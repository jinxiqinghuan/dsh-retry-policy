/**
 * dsh-retry-policy 宿主半边（cordis 插件）。
 *
 * 它是官方 `@deepseek-ai/dsh-llm-retry` 的「可配置化改写」，而不是另一套机制：
 * bundle patch 把官方那一行 `disabled: true`，这里复刻同一套事件（`llm/retry` /
 * `llm/retry-started`）、同一个投影 key（`llmRetry`）、同一条 `agent/request-error` 瀑布监听，
 * 因此会话界面、轨迹、会话格式迁移全部零改动，只有「重试几次 + 等多久」变成用户可配。
 *
 * 三个关键点（SPEC §5.2）：
 *   ① 本插件是链上唯一的重试执行器，不存在第二份预算；
 *   ② **决定不重试时必须 `return next()`**——瀑布上还有压缩等恢复策略
 *      （`dsh-compaction-basic` 的 CONTEXT_WINDOW_EXCEEDED、image-offload 的 IMAGE_OFFLOAD_REQUIRED），
 *      返回 undefined 会把它们的恢复路径整条掐掉；
 *   ③ 只有真正决定重试时才短路：`return { kind: 'retry' }` 且不调 `next()`。
 *
 * IO 与 HTTP 的事情也都在这里（路由、请求体、状态码），纯逻辑全在 lib/policy.js。
 */

import { randomUUID } from 'node:crypto'

import {
  CODE_OPTIONS,
  DEFAULTS,
  ENTRY_ID,
  MAX_BODY_BYTES,
  PolicyError,
  REQUEST_ERROR_EVENT,
  RETRY_EVENT,
  RETRY_PROJECTION_KEY,
  RETRY_PROJECTION_STATE_VERSION,
  RETRY_STARTED_EVENT,
  RETRY_STATE_SCHEMA,
  ROUTE,
  STRATEGY_OPTIONS,
  configToPatchRow,
  delayFor,
  effectiveView,
  normalizeConfig,
  normalizeConfigSafe,
  resolveEffectivePolicy,
  retryPolicyKey,
  retryProjectionApply,
  retryProjectionInit,
  retryStateKey,
} from './policy.js'

const name = ENTRY_ID
const inject = ['agents', 'sessionProjections']

/** 与官方一致：`setTimeout` 等待，abort 时清 timer 并返回 false。 */
function cancellableDelay(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 先问下游（压缩、其它恢复策略）要不要接管；抛错只当「下游没接管」，不能带崩整条链。 */
async function settleDownstream(next) {
  try {
    return { type: 'decision', decision: await next() }
  } catch (error) {
    return { type: 'error', error }
  }
}

function sendJson(res, code, payload) {
  if (!res || res.writableEnded || res.headersSent) return
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * 攒请求体；超过上限直接 413，并把连接排干（不再累积内容）。
 * 用 reject(带 status 的错误) 而不是返回错误码，是为了让调用方只写一次状态码语义。
 */
function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (status, message) => {
      if (settled) return
      settled = true
      const error = new Error(message)
      error.status = status
      reject(error)
    }

    req.on('error', () => fail(400, '请求体读取失败'))
    req.on('data', (chunk) => {
      if (settled) return
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buf.length
      if (size > limit) {
        fail(413, 'payload too large')
        chunks.length = 0
        if (typeof req.resume === 'function') req.resume()
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
  })
}

/**
 * 宿主插件体。
 *
 * @param {object} ctx cordis 上下文（插件 fiber 的 ctx）。
 * @param {unknown} config 当前生效配置；设置页保存后 Loader 会重启本插件，apply 带新 config 重跑，
 *   所以这里只在闭包里留一份 `live`，不做内存副本、不监听 volatile 更新（SPEC §5.5）。
 * @param {{random?: () => number}} [internals] 仅供测试注入随机源；Loader 只传前两个参数。
 */
function apply(ctx, config, internals = {}) {
  const warn = (message) => {
    try {
      if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(`[retry-policy] ${message}`)
    } catch {
      /* 没有 logger 就算了 */
    }
  }
  const info = (message) => {
    try {
      if (ctx.logger && typeof ctx.logger.info === 'function') ctx.logger.info(`[retry-policy] ${message}`)
    } catch {
      /* 没有 logger 就算了 */
    }
  }

  // 坏配置只回落默认值，绝不让插件加载失败（SPEC §2 硬要求）
  let live
  try {
    live = normalizeConfig(config)
  } catch (error) {
    const detail = error instanceof PolicyError
      ? error.issues.map((issue) => `${issue.field}: ${issue.message}`).join('；')
      : String(error && error.message)
    warn(`配置不合法，已整体回落默认值（${detail}）`)
    live = normalizeConfigSafe(config)
  }

  const random = typeof internals.random === 'function' ? internals.random : Math.random
  const lifetime = new AbortController()
  const active = new Set()

  /** 把在飞的重试挂进 Set，卸载时才能排空（否则 abort 后还留着没结算的 promise）。 */
  function track(operation) {
    const tracked = operation.finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  }

  // ---- 投影：与官方逐字段同构，界面与会话恢复都靠它 ----
  ctx.sessionProjections.register({
    key: RETRY_PROJECTION_KEY,
    stateVersion: RETRY_PROJECTION_STATE_VERSION,
    stateSchema: RETRY_STATE_SCHEMA,
    init: retryProjectionInit,
    apply: retryProjectionApply,
  })

  /** 延迟结束、真正重发之前：先落 `llm/retry`（可恢复的排定），再落 `llm/retry-started`。 */
  async function backoff(agent, turn, step, failure, provider, policy, policyKey, retry, retryId, delayMs, signal) {
    const fusedSignal = AbortSignal.any([signal, lifetime.signal])
    if (fusedSignal.aborted) return undefined

    // 字段集必须与官方完全一致（SPEC §5.4）：normal 带 maxRetries，always 不带
    const eventData = policy.mode === 'normal'
      ? { retryId, turn, step, provider, mode: policy.mode, policyKey, retry, maxRetries: policy.maxRetries, delayMs, failure }
      : { retryId, turn, step, provider, mode: policy.mode, policyKey, retry, delayMs, failure }

    agent.session.append(RETRY_EVENT, eventData)
    if (!await cancellableDelay(delayMs, fusedSignal)) return undefined
    agent.session.append(RETRY_STARTED_EVENT, { retryId, turn, step, retry })
    return { kind: 'retry' }
  }

  /**
   * 一次失败请求的恢复决策（SPEC §5.2 的判定顺序，顺序本身就是契约）。
   *
   * @returns {Promise<{kind: 'retry'}|undefined>} 只有真正排定了重试才返回 retry。
   */
  async function recover({ agent, turn, step, provider, failure, retryPolicy: providedPolicy, signal }, next) {
    // 1. 回合已经取消/插件正在卸载：什么都不做（也不 next，避免给死掉的回合跑恢复）
    if (signal.aborted || lifetime.signal.aborted) return undefined

    // 2. 生效策略；配置异常时交回下游，绝不自己短路
    let effective
    try {
      effective = resolveEffectivePolicy(live, providedPolicy)
    } catch (error) {
      warn(`生效策略解析失败，交回下游：${error && error.message}`)
      return next()
    }

    // 3. always：先让下游（压缩等）表态，下游不接管才由本插件无限兜底
    if (effective.mode === 'always') {
      const fusedSignal = AbortSignal.any([signal, lifetime.signal])
      const downstream = await settleDownstream(next)
      if (fusedSignal.aborted) return undefined
      if (downstream.type === 'error') {
        warn(`always 模式下下游恢复失败，改由本插件兜底：${downstream.error && downstream.error.message}`)
      }
      if (downstream.type === 'decision' && downstream.decision && downstream.decision.kind === 'retry') {
        return downstream.decision
      }
    } else if (!effective.retryableCodes.includes(failure.code)) {
      // 4. normal：这个失败码不归我们管 → 交给瀑布上的其它恢复策略
      return next()
    }

    // 5. 预算是按 (provider, 策略) 独立计数的，键一变就重新计数
    const policyKey = retryPolicyKey(effective)

    // 6. 读上一轮排到第几次
    const state = ctx.sessionProjections.stateOf(agent.session, RETRY_PROJECTION_KEY)
    const previous = state === undefined ? undefined : state[retryStateKey(provider, policyKey)]
    const previousRetry = previous === undefined ? 0 : previous.retry

    // 7. normal 预算耗尽 → 交给下游（不能返回 undefined，那会掐掉压缩等恢复路径）
    if (effective.mode === 'normal' && previousRetry >= effective.maxRetries) return next()

    // 8. 同一串重试共用一个 retryId
    const retry = previousRetry + 1
    const retryId = previous === undefined ? randomUUID() : previous.retryId

    // 9. 延迟：提供方的 Retry-After 优先（可关闭），超过上限时 normal 放弃、always 用本地公式
    let delayMs
    const retryAfterMs = failure.providerRetryAfterMs
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      if (retryAfterMs > effective.maxDelayMs) {
        if (effective.mode === 'normal') return next()
        delayMs = delayFor(effective, retry, random)
      } else if (effective.respectRetryAfter === false) {
        delayMs = delayFor(effective, retry, random)
      } else {
        delayMs = retryAfterMs
      }
    } else {
      delayMs = delayFor(effective, retry, random)
    }

    // 10. 落事件 → 等延迟 → 落 started → 让 agent loop 在同一回合内重跑这个 step
    return backoff(agent, turn, step, failure, provider, effective, policyKey, retry, retryId, delayMs, signal)
  }

  const disposeListener = ctx.on(REQUEST_ERROR_EVENT, (payload, next) => {
    if (lifetime.signal.aborted) return Promise.resolve(undefined)
    return track(recover(payload, next))
  })

  // 卸载：摘掉监听、abort 在飞的等待，并等它们全部结算（否则热重载会留下悬挂的定时器/事件写入）
  ctx.effect(() => async () => {
    disposeListener()
    lifetime.abort(new Error('dsh-retry-policy plugin disposed'))
    await Promise.allSettled([...active])
  }, 'dsh-retry-policy: abort and drain active recovery')

  // ------------------------------------------------------------------ HTTP

  // entry 必须在 apply 顶层捕获：HTTP 处理器跑在 ctx.inject 的子 fiber 上，那里拿到的 fiber 未必挂着 Loader entry
  const entry = ctx.fiber === undefined ? undefined : ctx.fiber.entry

  /** 可编辑时返回 configEditor 服务本身，否则 undefined（设置页据此转只读）。 */
  function configEditor() {
    if (entry === undefined) return undefined
    let service
    try {
      service = ctx.get('configEditor')
    } catch {
      return undefined
    }
    if (!service || typeof service.entries !== 'function' || typeof service.edit !== 'function') return undefined
    try {
      return service.entries().includes(entry) ? service : undefined
    } catch {
      return undefined
    }
  }

  /** 提供方自带的策略，只读展示「不改的话默认是几次」；取不到就空数组，绝不抛。 */
  function providerPolicies() {
    let llm
    try {
      llm = ctx.get('llm')
    } catch {
      return []
    }
    if (!llm || typeof llm.listProviders !== 'function') return []
    let list
    try {
      list = llm.listProviders()
    } catch (error) {
      warn(`读取提供方列表失败：${error && error.message}`)
      return []
    }
    const rows = []
    for (const item of Array.isArray(list) ? list : []) {
      const id = item && (item.id ?? item.provider)
      if (typeof id !== 'string' || id === '') continue
      let policy
      try {
        policy = typeof llm.providerRetryPolicy === 'function' ? llm.providerRetryPolicy(id) : undefined
      } catch {
        policy = undefined
      }
      if (policy && policy.mode === 'always') {
        rows.push({ provider: id, mode: 'always' })
      } else {
        rows.push({
          provider: id,
          mode: 'normal',
          maxRetries: Number.isInteger(policy && policy.maxRetries) ? policy.maxRetries : null,
        })
      }
    }
    return rows
  }

  function policyPayload() {
    return {
      ok: true,
      entryId: ENTRY_ID,
      editable: configEditor() !== undefined,
      config: configToPatchRow(live),
      defaults: configToPatchRow(DEFAULTS),
      effective: effectiveView(resolveEffectivePolicy(live, undefined)),
      providerPolicies: providerPolicies(),
      strategyOptions: STRATEGY_OPTIONS,
      codeOptions: CODE_OPTIONS,
    }
  }

  function handleGet(res) {
    sendJson(res, 200, policyPayload())
  }

  async function handlePost(req, res) {
    let raw
    try {
      raw = await readBody(req)
    } catch (error) {
      sendJson(res, error && error.status ? error.status : 400, { ok: false, error: (error && error.message) || '请求体读取失败' })
      return
    }
    if (!raw.trim()) {
      sendJson(res, 400, { ok: false, error: '请求体不能为空' })
      return
    }
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
      return
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, error: '请求体必须是一个 JSON 对象' })
      return
    }

    const reset = body.reset === true
    const dryRun = body.dryRun === true

    // reset 写默认值；没带 config 的保存也按默认值写。两者都用 configToPatchRow 固定键顺序
    const requested = reset || body.config === undefined ? DEFAULTS : body.config
    let next
    try {
      next = configToPatchRow(requested)
    } catch (error) {
      if (error instanceof PolicyError) {
        sendJson(res, 400, { ok: false, error: '配置不合法', issues: error.issues })
        return
      }
      warn(`配置转换失败：${error && error.stack}`)
      sendJson(res, 500, { ok: false, error: '配置处理失败' })
      return
    }

    const effective = effectiveView(resolveEffectivePolicy(next, undefined))

    // 预览：只算不写；dryRun 绝不能碰 profile（SPEC §8.5）
    if (dryRun) {
      sendJson(res, 200, { ok: true, saved: false, editable: configEditor() !== undefined, config: next, effective })
      return
    }

    const editor = configEditor()
    if (editor === undefined) {
      sendJson(res, 503, { ok: false, error: '配置编辑服务不可用，设置页当前只读' })
      return
    }

    try {
      await editor.edit(entry, () => next)
    } catch (error) {
      warn(`配置保存失败：${error && error.stack}`)
      sendJson(res, 500, { ok: false, error: (error && error.message) || '配置保存失败' })
      return
    }
    // 保存成功后 Loader 会重载本插件；这里直接回新值，设置页无须再 GET 一次才能看到结果
    sendJson(res, 200, { ok: true, saved: true, editable: true, config: next, effective })
  }

  ctx.inject(['webServer'], (scoped) => {
    // 照官方 dsh-client-hmr 的写法：路由注册放进 effect，随本插件 fiber 释放而摘掉。
    // 这一步不能省——设置页保存会重启本插件，旧路由不摘掉就会撞 webServer 的重复路径检查。
    scoped.effect(() => {
      let off
      try {
        off = scoped.webServer.register({
          kind: 'exact',
          path: ROUTE,
          handler: async (req, res) => {
            try {
              const method = String((req && req.method) || '').toUpperCase()
              const headers = (req && req.headers) || {}
              // 同源检查：别的站点不能跨站读配置，更不能改配置
              if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
                sendJson(res, 403, { ok: false, error: '拒绝跨站请求' })
                return
              }
              if (method === 'GET') {
                handleGet(res)
                return
              }
              if (method !== 'POST') {
                sendJson(res, 405, { ok: false, error: 'method not allowed' })
                return
              }
              await handlePost(req, res)
            } catch (error) {
              warn(`HTTP 处理失败：${error && error.stack}`)
              sendJson(res, 500, { ok: false, error: '内部错误' })
            }
          },
        })
      } catch (error) {
        // 路由注册失败（例如同路径已存在）不能连累重试引擎，只记 warn
        warn(`路由注册失败：${error && error.message}`)
        return undefined
      }
      return () => {
        try {
          off()
        } catch {
          /* 已经没了 */
        }
      }
    }, 'dsh-retry-policy: policy route')
  })

  info(`接管模型请求重试：enabled=${live.enabled} mode=${live.mode} maxRetries=${live.maxRetries} strategy=${live.strategy}`)
}

export { apply, inject, name, cancellableDelay, readBody }
