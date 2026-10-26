/**
 * lib/host.js 的假 ctx 集成测试。
 *
 * 假 ctx 只实现真实 cordis 里我们用到的语义：
 *   · `ctx.on('agent/request-error', ...)` 收监听器（瀑布：不调 next 就短路下游）；
 *   · `ctx.sessionProjections.register/stateOf` 按「eager drive」推进投影（append 即折叠），
 *     这样预算计数走的就是真实路径，而不是测试自己造的一份计数；
 *   · `ctx.effect` 收集卸载器，`ctx.inject(['webServer'])` 同步回调以捕获路由。
 */

import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers'
import { test } from 'node:test'

import { apply, inject, name } from '../lib/host.js'
import {
  DEFAULTS,
  RETRY_PROJECTION_KEY,
  STRATEGY_OPTIONS,
  delayFor,
  normalizeConfig,
  resolveEffectivePolicy,
  retryPolicyKey,
  retryStateKey,
} from '../lib/policy.js'

// ----------------------------------------------------------------- 测试夹具

/** 会话投影的最小实现：append 即折叠，等价于真实 registry 的 eager drive。 */
function createProjections() {
  let definition
  const cells = new WeakMap()
  return {
    get definition() {
      return definition
    },
    register(def) {
      definition = def
      return () => {
        definition = undefined
      }
    },
    stateOf(session, key) {
      if (key !== RETRY_PROJECTION_KEY || definition === undefined) return undefined
      if (!cells.has(session)) cells.set(session, definition.init(session.header, 0))
      return cells.get(session)
    },
    drive(session, event) {
      if (definition === undefined) return
      const previous = this.stateOf(session, RETRY_PROJECTION_KEY)
      cells.set(session, definition.apply(previous, event))
    },
  }
}

function createAgent(projections) {
  const events = []
  const session = {
    header: { version: 1, id: 's-1', createdAt: 0, isSeeded: false },
    events,
    append(type, data) {
      const event = { type, data, seq: events.length }
      events.push(event)
      projections.drive(session, event)
      return event
    },
  }
  return { id: 's-1', session, events }
}

function createHarness(pluginConfig, options = {}) {
  const projections = createProjections()
  const listeners = new Map()
  const routes = []
  const effects = []
  const warnings = []
  const infos = []
  const entry = options.entry ?? { id: 'dsh-retry-policy', options: { id: 'dsh-retry-policy', name: 'dsh-retry-policy' } }
  const services = {}
  if (Object.hasOwn(options, 'configEditor')) services.configEditor = options.configEditor
  if (Object.hasOwn(options, 'llm')) services.llm = options.llm

  const ctx = {
    logger: {
      warn: (message) => warnings.push(String(message)),
      info: (message) => infos.push(String(message)),
      error: () => {},
    },
    fiber: { entry: options.noEntry === true ? undefined : entry },
    sessionProjections: projections,
    get: (key) => services[key],
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const at = list.indexOf(listener)
        if (at !== -1) list.splice(at, 1)
      }
    },
    effect(execute, label) {
      effects.push({ dispose: execute(), label })
      return () => {}
    },
    inject(required, callback) {
      if (options.noWebServer === true || !required.includes('webServer')) return
      // 真实 ctx.inject 会起一个子 fiber，回调里 ctx.effect 的清理随该 fiber 释放
      const scoped = {
        webServer: {
          register(route) {
            if (routes.some((item) => item.path === route.path)) throw new Error(`duplicate route ${route.path}`)
            routes.push(route)
            return () => {
              const at = routes.indexOf(route)
              if (at !== -1) routes.splice(at, 1)
            }
          },
        },
        effect(execute, label) {
          effects.push({ dispose: execute(), label })
          return () => {}
        },
      }
      callback(scoped)
    },
  }

  apply(ctx, pluginConfig, options.internals)

  return {
    ctx,
    entry,
    routes,
    effects,
    warnings,
    infos,
    projections,
    requestErrorListeners: () => (listeners.get('agent/request-error') ?? []).slice(),
    recover: () => {
      const [listener] = listeners.get('agent/request-error') ?? []
      assert.ok(listener, 'agent/request-error 监听器缺失')
      return listener
    },
    drain: () => {
      const effect = effects.find((item) => String(item.label).includes('drain'))
      assert.ok(effect, 'ctx.effect 卸载器缺失')
      return effect.dispose()
    },
    disposeRoute: () => {
      const effect = effects.find((item) => String(item.label).includes('route'))
      assert.ok(effect, '路由 effect 缺失')
      return effect.dispose()
    },
  }
}

function payload(agent, overrides = {}) {
  return {
    agent,
    turn: 1,
    step: 1,
    provider: 'loomy',
    failure: { message: 'boom', code: 'SERVER' },
    retryPolicy: undefined,
    signal: new AbortController().signal,
    ...overrides,
  }
}

function createNext(result) {
  const calls = []
  const next = async (...args) => {
    calls.push(args)
    return typeof result === 'function' ? result() : result
  }
  next.calls = calls
  return next
}

/** 逼真的 req/res：req 用 setImmediate 异步喂 body，等价于真实流。 */
function createReq({ method = 'GET', headers = {}, body = '' } = {}) {
  const handlers = new Map()
  const req = {
    method,
    headers,
    on(event, callback) {
      const list = handlers.get(event) ?? []
      list.push(callback)
      handlers.set(event, list)
      return req
    },
    resume() {},
  }
  setImmediate(() => {
    if (body) for (const callback of handlers.get('data') ?? []) callback(Buffer.from(body, 'utf8'))
    for (const callback of handlers.get('end') ?? []) callback()
  })
  return req
}

function createRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    setHeader(key, value) {
      res.headers[key] = value
    },
    end(text) {
      res.body = text ?? ''
      res.writableEnded = true
    },
  }
  return res
}

async function callRoute(harness, options) {
  const [route] = harness.routes
  assert.ok(route, 'HTTP 路由未注册')
  const res = createRes()
  await route.handler(createReq(options), res)
  return { status: res.statusCode, headers: res.headers, json: res.body ? JSON.parse(res.body) : undefined }
}

/** normal 模式的快速配置：延迟 1ms，避免测试等真时间。 */
function fastConfig(overrides = {}) {
  return {
    ...DEFAULTS,
    maxRetries: 2,
    initialDelayMs: 1,
    maxDelayMs: 1000,
    jitterRatio: 0,
    strategy: 'fixed',
    ...overrides,
  }
}

// ----------------------------------------------------------------- 挂载形态

test('导出 name / inject，与官方 llm-retry 一致', () => {
  assert.equal(name, 'dsh-retry-policy')
  assert.deepEqual(inject, ['agents', 'sessionProjections'])
})

test('apply 注册 llmRetry 投影，字段与官方同构', () => {
  const harness = createHarness(fastConfig())
  const definition = harness.projections.definition
  assert.equal(definition.key, 'llmRetry')
  assert.equal(definition.stateVersion, 1)
  assert.deepEqual(definition.init(), {})
  assert.deepEqual(definition.apply({}, { type: 'step/start', data: {} }), {})
  assert.equal(typeof definition.stateSchema.parse, 'function')
})

// ----------------------------------------------------------------- 重试执行器

test('normal：按预算重试，用尽后 return next() 交回下游', async () => {
  const harness = createHarness(fastConfig())
  const agent = createAgent(harness.projections)
  const listener = harness.recover()

  const decisions = []
  for (let round = 0; round < 3; round += 1) {
    const next = createNext(undefined)
    decisions.push(await listener(payload(agent), next))
    if (round < 2) assert.equal(next.calls.length, 0, '决定重试时不得调 next')
    else assert.equal(next.calls.length, 1, '预算耗尽必须调 next')
  }

  assert.deepEqual(decisions, [{ kind: 'retry' }, { kind: 'retry' }, undefined])
  assert.deepEqual(agent.events.map((event) => event.type), [
    'llm/retry', 'llm/retry-started', 'llm/retry', 'llm/retry-started',
  ])
  const retries = agent.events.filter((event) => event.type === 'llm/retry').map((event) => event.data.retry)
  assert.deepEqual(retries, [1, 2])
  assert.equal(agent.events[0].data.retryId, agent.events[2].data.retryId, '同一串重试共用 retryId')
  assert.deepEqual(agent.events.map((event) => event.data.delayMs).filter((value) => value !== undefined), [1, 1])
})

test('normal：失败码不匹配 → return next()，并把下游的决策原样传出去', async () => {
  const harness = createHarness(DEFAULTS)
  const agent = createAgent(harness.projections)
  const decision = { kind: 'retry' }
  const next = createNext(decision)

  const result = await harness.recover()(payload(agent, { failure: { message: 'nope', code: 'AUTH' } }), next)

  assert.equal(result, decision, '下游（如压缩）的恢复决策不能被吞掉')
  assert.equal(next.calls.length, 1)
  assert.deepEqual(agent.events, [], '不归自己管的失败不写任何事件')
})

test('normal：无提供方策略时也由本插件接管（不看 payload 里的 5 次）', async () => {
  const harness = createHarness(fastConfig({ maxRetries: 1 }))
  const agent = createAgent(harness.projections)
  const listener = harness.recover()

  // payload.retryPolicy 缺失 + 提供方策略说 normal/5 次，都不影响本插件的预算
  assert.deepEqual(await listener(payload(agent, { retryPolicy: { mode: 'normal', maxRetries: 5, retryableCodes: ['SERVER'], initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 } }), createNext(undefined)), { kind: 'retry' })
  const next = createNext(undefined)
  await listener(payload(agent, { retryPolicy: { mode: 'normal', maxRetries: 5, retryableCodes: ['SERVER'], initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 } }), next)
  assert.equal(next.calls.length, 1, '用配置里的 1 次预算，而不是提供方的 5 次')
})

test('always：下游优先，下游给出 retry 就原样采纳且不写事件', async () => {
  const harness = createHarness({ ...DEFAULTS, mode: 'always' })
  const agent = createAgent(harness.projections)
  const decision = { kind: 'retry' }
  const next = createNext(decision)

  const result = await harness.recover()(payload(agent), next)

  assert.equal(result, decision)
  assert.equal(next.calls.length, 1)
  assert.deepEqual(agent.events, [])
})

test('always：下游不接管则本插件无限兜底；下游抛错只 warn 后兜底', async () => {
  const harness = createHarness({ ...DEFAULTS, mode: 'always', initialDelayMs: 1, jitterRatio: 0, strategy: 'fixed' })
  const agent = createAgent(harness.projections)
  const listener = harness.recover()

  const idle = createNext(undefined)
  assert.deepEqual(await listener(payload(agent), idle), { kind: 'retry' })
  assert.deepEqual(agent.events.map((event) => event.type), ['llm/retry', 'llm/retry-started'])

  const broken = createNext(() => { throw new Error('downstream boom') })
  assert.deepEqual(await listener(payload(agent), broken), { kind: 'retry' })
  assert.equal(agent.events.length, 4, '下游抛错后仍然兜底重试')
  assert.ok(harness.warnings.some((line) => line.includes('下游恢复失败')), harness.warnings.join('\n'))

  // 第 8 次失败：always 没有次数上限
  for (let round = 0; round < 6; round += 1) {
    assert.deepEqual(await listener(payload(agent), createNext(undefined)), { kind: 'retry' })
  }
  assert.equal(agent.events.filter((event) => event.type === 'llm/retry').length, 8)
})

test('always：下游把回合取消了就不再重试', async () => {
  const harness = createHarness({ ...DEFAULTS, mode: 'always' })
  const agent = createAgent(harness.projections)
  const controller = new AbortController()
  const next = createNext(() => {
    controller.abort()
    return undefined
  })

  const result = await harness.recover()(payload(agent, { signal: controller.signal }), next)

  assert.equal(result, undefined)
  assert.deepEqual(agent.events, [])
})

test('signal 已取消：直接返回且不碰下游，也不写事件', async () => {
  const harness = createHarness(fastConfig())
  const agent = createAgent(harness.projections)
  const controller = new AbortController()
  controller.abort()
  const next = createNext(undefined)

  const result = await harness.recover()(payload(agent, { signal: controller.signal }), next)

  assert.equal(result, undefined)
  assert.equal(next.calls.length, 0)
  assert.deepEqual(agent.events, [])
})

test('Retry-After：不超过上限且开启时优先听提供方', async () => {
  const harness = createHarness(fastConfig({ initialDelayMs: 1000, maxDelayMs: 10000 }))
  const agent = createAgent(harness.projections)

  await harness.recover()(payload(agent, { failure: { message: 'slow down', code: 'RATE_LIMIT', providerRetryAfterMs: 7 } }), createNext(undefined))

  assert.equal(agent.events[0].data.delayMs, 7)
})

test('Retry-After：关闭优先时用本地公式；0/NaN 视为没有', async () => {
  const config = fastConfig({ maxRetries: 5, initialDelayMs: 1000, maxDelayMs: 10000, respectRetryAfter: false })
  const harness = createHarness(config)
  const agent = createAgent(harness.projections)
  const listener = harness.recover()

  await listener(payload(agent, { failure: { message: 'x', code: 'RATE_LIMIT', providerRetryAfterMs: 7 } }), createNext(undefined))
  assert.equal(agent.events[0].data.delayMs, 1000)

  agent.events.length = 0
  await listener(payload(agent, { failure: { message: 'x', code: 'RATE_LIMIT', providerRetryAfterMs: 0 } }), createNext(undefined))
  assert.equal(agent.events[0].data.delayMs, 1000)

  agent.events.length = 0
  await listener(payload(agent, { failure: { message: 'x', code: 'RATE_LIMIT', providerRetryAfterMs: Number.NaN } }), createNext(undefined))
  assert.equal(agent.events[0].data.delayMs, 1000)
})

test('Retry-After：超过上限时 normal 放弃、always 走本地公式', async () => {
  const normal = createHarness(fastConfig({ maxDelayMs: 5000 }))
  const normalAgent = createAgent(normal.projections)
  const normalNext = createNext(undefined)

  const normalResult = await normal.recover()(
    payload(normalAgent, { failure: { message: 'x', code: 'RATE_LIMIT', providerRetryAfterMs: 60000 } }),
    normalNext,
  )
  assert.equal(normalResult, undefined)
  assert.equal(normalNext.calls.length, 1, 'normal 放弃时必须调 next')
  assert.deepEqual(normalAgent.events, [])

  const always = createHarness(fastConfig({ mode: 'always', maxDelayMs: 5000, jitterRatio: 0, initialDelayMs: 1000 }))
  const alwaysAgent = createAgent(always.projections)
  await always.recover()(
    payload(alwaysAgent, { failure: { message: 'x', code: 'RATE_LIMIT', providerRetryAfterMs: 60000 } }),
    createNext(undefined),
  )
  assert.equal(alwaysAgent.events[0].data.delayMs, 1000, 'always 用本地公式而不是被上限截断的 5s')
})

test('预算按 (provider, 策略) 独立计数，step/start 与 turn/end 清零', async () => {
  const harness = createHarness(fastConfig({ maxRetries: 1 }))
  const agent = createAgent(harness.projections)
  const listener = harness.recover()

  assert.deepEqual(await listener(payload(agent), createNext(undefined)), { kind: 'retry' })
  // 同一 provider 预算已满
  const exhausted = createNext(undefined)
  assert.equal(await listener(payload(agent), exhausted), undefined)
  assert.equal(exhausted.calls.length, 1)

  // 换 provider：独立预算，可以再重试一次
  assert.deepEqual(await listener(payload(agent, { provider: 'other' }), createNext(undefined)), { kind: 'retry' })

  // step/start 清零：同一 provider 又有预算了
  agent.session.append('step/start', { turn: 1, step: 2 })
  assert.deepEqual(await listener(payload(agent, { provider: 'other' }), createNext(undefined)), { kind: 'retry' })

  // turn/end 清零
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(await listener(payload(agent, { provider: 'other' }), createNext(undefined)), { kind: 'retry' })
})

test('策略变化会换预算键（改设置不会把旧预算算到新策略头上）', async () => {
  const harness = createHarness(fastConfig({ maxRetries: 1, strategy: 'fixed' }))
  const agent = createAgent(harness.projections)
  const listener = harness.recover()
  await listener(payload(agent), createNext(undefined))

  const keys = agent.events.filter((event) => event.type === 'llm/retry').map((event) => event.data.policyKey)
  assert.deepEqual(keys, [retryPolicyKey(resolveEffectivePolicy(normalizeConfig(fastConfig({ maxRetries: 1, strategy: 'fixed' })), undefined))])
  assert.ok(keys[0].includes('"fixed"'))
})

test('事件字段集与官方逐字段一致（normal / always / started）', async () => {
  const harness = createHarness(fastConfig({ maxRetries: 3 }))
  const agent = createAgent(harness.projections)
  const failure = { message: 'boom', code: 'SERVER', status: 503, requestId: 'req-1' }

  await harness.recover()(payload(agent, { turn: 4, step: 7, failure }), createNext(undefined))

  const retryEvent = agent.events[0]
  assert.deepEqual(Object.keys(retryEvent.data).sort(), [
    'delayMs', 'failure', 'maxRetries', 'mode', 'policyKey', 'provider', 'retry', 'retryId', 'step', 'turn',
  ])
  assert.equal(retryEvent.data.mode, 'normal')
  assert.equal(retryEvent.data.maxRetries, 3)
  assert.equal(retryEvent.data.turn, 4)
  assert.equal(retryEvent.data.step, 7)
  assert.equal(retryEvent.data.provider, 'loomy')
  assert.equal(retryEvent.data.retry, 1)
  assert.equal(typeof retryEvent.data.retryId, 'string')
  assert.ok(retryEvent.data.retryId.length > 0)
  assert.equal(retryEvent.data.failure, failure, 'failure 原样透传')
  assert.equal(typeof retryEvent.data.policyKey, 'string')

  assert.deepEqual(Object.keys(agent.events[1].data).sort(), ['retry', 'retryId', 'step', 'turn'])
  assert.equal(agent.events[1].data.retryId, retryEvent.data.retryId)
  assert.deepEqual(agent.events.map((event) => event.type), ['llm/retry', 'llm/retry-started'])

  // always 的 llm/retry 不带 maxRetries（官方如此）
  const alwaysHarness = createHarness({ ...DEFAULTS, mode: 'always', initialDelayMs: 1, jitterRatio: 0, strategy: 'fixed' })
  const alwaysAgent = createAgent(alwaysHarness.projections)
  await alwaysHarness.recover()(payload(alwaysAgent), createNext(undefined))
  assert.deepEqual(Object.keys(alwaysAgent.events[0].data).sort(), [
    'delayMs', 'failure', 'mode', 'policyKey', 'provider', 'retry', 'retryId', 'step', 'turn',
  ])
  assert.equal(alwaysAgent.events[0].data.mode, 'always')
})

test('延迟真的会等：backoff 等满 delayMs 才写 llm/retry-started', async () => {
  const harness = createHarness(fastConfig({ maxRetries: 1, initialDelayMs: 30, maxDelayMs: 1000, jitterRatio: 0, strategy: 'fixed' }))
  const agent = createAgent(harness.projections)
  const started = Date.now()

  await harness.recover()(payload(agent), createNext(undefined))

  const elapsed = Date.now() - started
  assert.ok(elapsed >= 25, `应当等约 30ms，实际 ${elapsed}ms`)
  assert.deepEqual(agent.events.map((event) => event.type), ['llm/retry', 'llm/retry-started'])
})

test('取消在飞的重试：卸载时清 timer、不写 llm/retry-started、并移除监听', async () => {
  const harness = createHarness(fastConfig({ maxRetries: 3, initialDelayMs: 60000 }))
  const agent = createAgent(harness.projections)

  const pending = harness.recover()(payload(agent), createNext(undefined))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(agent.events.map((event) => event.type), ['llm/retry'], '排定事件先落，等待中')

  await harness.drain()

  assert.equal(await pending, undefined, '被取消的等待不产生重试决策')
  assert.deepEqual(agent.events.map((event) => event.type), ['llm/retry'], '不再写 llm/retry-started')
  assert.deepEqual(harness.requestErrorListeners(), [], '卸载后不再监听 agent/request-error')
})

test('payload.signal 取消：等待被中断，且不写 llm/retry-started', async () => {
  const harness = createHarness(fastConfig({ maxRetries: 3, initialDelayMs: 60000 }))
  const agent = createAgent(harness.projections)
  const controller = new AbortController()

  const pending = harness.recover()(payload(agent, { signal: controller.signal }), createNext(undefined))
  await new Promise((resolve) => setTimeout(resolve, 10))
  controller.abort()

  assert.equal(await pending, undefined)
  assert.deepEqual(agent.events.map((event) => event.type), ['llm/retry'])
})

test('坏配置：记 warning 并整体回落 DEFAULTS，重试照常工作', async () => {
  const harness = createHarness({ maxRetries: -5, strategy: 'nope' })
  assert.ok(harness.warnings.some((line) => line.includes('配置不合法')), harness.warnings.join('\n'))

  const agent = createAgent(harness.projections)
  const listener = harness.recover()
  // DEFAULTS 的预算 10 次：第 1 次失败仍然重试
  assert.deepEqual(await listener(payload(agent), createNext(undefined)), { kind: 'retry' })
  assert.equal(agent.events[0].data.maxRetries, DEFAULTS.maxRetries)
  assert.equal(delayFor(resolveEffectivePolicy(DEFAULTS, undefined), 1), 1000)
})

// ----------------------------------------------------------------- HTTP

function createConfigEditor(entry, log = []) {
  return {
    entry,
    log,
    entries: () => [entry],
    async edit(target, change) {
      log.push({ target, next: change(), inherited: {} })
    },
  }
}

/**
 * 可编辑场景：configEditor.entries() 必须返回 `ctx.fiber.entry` 这个**同一个对象**
 * （真实 configEditor 就是用对象身份判定的），所以这里把 entry 显式传给 harness。
 */
function createEditableHarness(pluginConfig, options = {}) {
  const entry = { id: 'dsh-retry-policy' }
  const editor = createConfigEditor(entry)
  return { entry, editor, harness: createHarness(pluginConfig, { ...options, configEditor: editor, entry }) }
}

const LLM_STUB = {
  listProviders: () => [{ id: 'loomy', name: 'Loomy' }, { id: 'zai', name: 'Zai' }, { id: 'ghost', name: 'Ghost' }],
  providerRetryPolicy: (id) => {
    if (id === 'ghost') throw new Error('not registered')
    if (id === 'zai') return { mode: 'always', initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 }
    return { mode: 'normal', maxRetries: 5, retryableCodes: ['SERVER'], initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 }
  },
}

test('GET：返回配置、默认值、生效策略、提供方策略与选项', async () => {
  const { editor, harness } = createEditableHarness(DEFAULTS, { llm: LLM_STUB })

  const { status, headers, json } = await callRoute(harness, { method: 'GET' })

  assert.equal(status, 200)
  assert.equal(headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(headers['cache-control'], 'no-store')
  assert.equal(json.ok, true)
  assert.equal(json.entryId, 'dsh-retry-policy')
  assert.equal(json.editable, true)
  assert.deepEqual(json.config, { ...DEFAULTS, retryableCodes: [...DEFAULTS.retryableCodes] })
  assert.deepEqual(json.defaults, { ...DEFAULTS, retryableCodes: [...DEFAULTS.retryableCodes] })
  assert.equal(json.effective.mode, 'normal')
  assert.equal(json.effective.maxRetries, 10)
  assert.equal(json.effective.source, 'config')
  assert.deepEqual(json.effective.preview, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000])
  assert.deepEqual(json.providerPolicies, [
    { provider: 'loomy', mode: 'normal', maxRetries: 5 },
    { provider: 'zai', mode: 'always' },
    { provider: 'ghost', mode: 'normal', maxRetries: null },
  ])
  assert.deepEqual(json.strategyOptions, STRATEGY_OPTIONS.map((option) => ({ ...option })))
  assert.deepEqual(json.codeOptions, ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'AUTH', 'QUOTA', 'INVALID_REQUEST', 'PROTOCOL', 'CONTEXT_OVERFLOW'])
  assert.deepEqual(Object.keys(json.config), Object.keys(json.defaults))
})

test('GET：没有 configEditor / 没有 llm 时只读且不抛错', async () => {
  const harness = createHarness(DEFAULTS, { noEntry: true })
  const { status, json } = await callRoute(harness, { method: 'GET' })

  assert.equal(status, 200)
  assert.equal(json.editable, false)
  assert.deepEqual(json.providerPolicies, [])
})

test('GET：enabled:false 时生效策略回落官方内置', async () => {
  const { harness } = createEditableHarness({ ...DEFAULTS, enabled: false })
  const { json } = await callRoute(harness, { method: 'GET' })

  assert.equal(json.effective.mode, 'normal')
  assert.equal(json.effective.maxRetries, 5)
  assert.equal(json.effective.source, 'disabled')
  assert.deepEqual(json.effective.preview, [500, 1000, 2000, 4000, 8000])
})

test('POST dryRun：只预览不落盘，固定间隔预览正确', async () => {
  const { editor, harness } = createEditableHarness(DEFAULTS)

  const { status, json } = await callRoute(harness, {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ config: { maxRetries: 3, strategy: 'fixed', initialDelayMs: 2000 }, dryRun: true }),
  })

  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.saved, false)
  assert.equal(json.editable, true)
  assert.deepEqual(editor.log, [], 'dryRun 不得写配置')
  assert.equal(json.config.maxRetries, 3)
  assert.equal(json.config.strategy, 'fixed')
  assert.equal(json.config.initialDelayMs, 2000)
  // 其余字段补默认值
  assert.equal(json.config.maxDelayMs, DEFAULTS.maxDelayMs)
  assert.equal(json.config.multiplier, DEFAULTS.multiplier)
  assert.deepEqual(json.config.retryableCodes, [...DEFAULTS.retryableCodes])
  assert.deepEqual(json.effective.preview, [2000, 2000, 2000])
})

test('POST 保存：走 configEditor.edit，落盘的是归一化后的补丁行', async () => {
  const { entry, editor, harness } = createEditableHarness(DEFAULTS)

  const { status, json } = await callRoute(harness, {
    method: 'POST',
    body: JSON.stringify({ config: { maxRetries: 4, strategy: 'linear', initialDelayMs: 500, maxDelayMs: 8000 } }),
  })

  assert.equal(status, 200)
  assert.equal(json.saved, true)
  assert.equal(json.editable, true)
  assert.equal(editor.log.length, 1)
  assert.equal(editor.log[0].target, entry, 'edit 必须收到 apply 里捕获的 entry')
  assert.deepEqual(editor.log[0].next, {
    enabled: true,
    mode: 'inherit',
    maxRetries: 4,
    strategy: 'linear',
    initialDelayMs: 500,
    maxDelayMs: 8000,
    multiplier: 2,
    jitterRatio: 0.1,
    retryableCodes: [...DEFAULTS.retryableCodes],
    respectRetryAfter: true,
  })
  assert.deepEqual(json.config, editor.log[0].next)
  assert.deepEqual(json.effective.preview, [500, 1000, 1500, 2000])
})

test('POST reset：写回默认值', async () => {
  const { editor, harness } = createEditableHarness({ ...DEFAULTS, maxRetries: 3 })

  const { status, json } = await callRoute(harness, { method: 'POST', body: JSON.stringify({ reset: true }) })

  assert.equal(status, 200)
  assert.equal(json.saved, true)
  assert.deepEqual(editor.log[0].next, { ...DEFAULTS, retryableCodes: [...DEFAULTS.retryableCodes] })
})

test('POST 非法配置：400 + issues，且不写配置', async () => {
  const { editor, harness } = createEditableHarness(DEFAULTS)

  const { status, json } = await callRoute(harness, {
    method: 'POST',
    body: JSON.stringify({ config: { maxRetries: 99999 } }),
  })

  assert.equal(status, 400)
  assert.equal(json.ok, false)
  assert.equal(json.error, '配置不合法')
  assert.equal(json.issues[0].field, 'maxRetries')
  assert.deepEqual(editor.log, [])

  const unknown = await callRoute(harness, { method: 'POST', body: JSON.stringify({ config: { nope: 1 } }) })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.json.issues[0].field, 'nope')
})

test('POST 不可编辑：503；保存抛错：500', async () => {
  const readonly = createHarness(DEFAULTS, {})
  const blocked = await callRoute(readonly, { method: 'POST', body: JSON.stringify({ reset: true }) })
  assert.equal(blocked.status, 503)
  assert.equal(blocked.json.ok, false)
  assert.equal(typeof blocked.json.error, 'string')

  const { editor, harness: broken } = createEditableHarness(DEFAULTS)
  editor.edit = async () => {
    throw new Error('磁盘满了')
  }
  const failed = await callRoute(broken, { method: 'POST', body: JSON.stringify({ reset: true }) })
  assert.equal(failed.status, 500)
  assert.equal(failed.json.error, '磁盘满了')
})

test('HTTP 边界：跨站 403 / 方法 405 / body 过大 413 / 非 JSON 400 / 空体 400', async () => {
  const { harness } = createEditableHarness(DEFAULTS)

  const crossSite = await callRoute(harness, { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossSite.status, 403)
  assert.equal(crossSite.json.ok, false)

  const wrongMethod = await callRoute(harness, { method: 'PUT' })
  assert.equal(wrongMethod.status, 405)

  const tooLarge = await callRoute(harness, { method: 'POST', body: 'x'.repeat(70 * 1024) })
  assert.equal(tooLarge.status, 413)

  const notJson = await callRoute(harness, { method: 'POST', body: 'not json' })
  assert.equal(notJson.status, 400)
  assert.equal(notJson.json.ok, false)

  const empty = await callRoute(harness, { method: 'POST', body: '' })
  assert.equal(empty.status, 400)

  const arrayBody = await callRoute(harness, { method: 'POST', body: '[]' })
  assert.equal(arrayBody.status, 400)
})

test('路由注册失败不连累重试引擎；卸载时摘掉路由', async () => {
  const harness = createHarness(fastConfig())
  assert.equal(harness.routes.length, 1)
  assert.equal(harness.routes[0].path, '/dsh-retry-policy/policy')
  assert.equal(harness.routes[0].kind, 'exact')

  const agent = createAgent(harness.projections)
  harness.disposeRoute()
  assert.deepEqual(harness.routes, [], '卸载器必须摘掉路由（否则热重载会撞重复路径）')
  // 路由没了，引擎照常
  assert.deepEqual(await harness.recover()(payload(agent), createNext(undefined)), { kind: 'retry' })
})

test('apply 会打印一行接管摘要（便于排障）', () => {
  const harness = createHarness(DEFAULTS)
  assert.ok(harness.infos.some((line) => line.includes('接管模型请求重试')), harness.infos.join('\n'))
})

test('投影状态键与预算键一致（事件 → 投影 → 预算查询闭环）', async () => {
  const harness = createHarness(fastConfig({ maxRetries: 1 }))
  const agent = createAgent(harness.projections)
  await harness.recover()(payload(agent), createNext(undefined))

  const data = agent.events[0].data
  const state = harness.projections.stateOf(agent.session, RETRY_PROJECTION_KEY)
  assert.ok(state[retryStateKey(data.provider, data.policyKey)])
  assert.equal(state[retryStateKey(data.provider, data.policyKey)].retry, 1)
})
