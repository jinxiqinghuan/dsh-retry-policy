/**
 * 独立验收脚本 C —— 重试链路探针（verifier 自己写的假 ctx，不复用作者 tests/）。
 *
 * 目标（SPEC §5.2 / §5.4 / §8.9）：
 *   1. normal 事件字段集 / 预算计数 / 预算耗尽后必须 next()
 *   2. 预算按 (provider, 策略) 独立计数；step/start 清零
 *   3. 不归本插件管的失败码 → next()，不写事件
 *   4. always：下游优先；下游不管才兜底；事件无 maxRetries
 *   5. Retry-After 优先 / 超过 maxDelayMs 时 normal 放弃
 *   6. 取消：dispose 时 abort 等待并排空，不再写 llm/retry-started
 *   7. enabled:false → 不接管，全部 next()
 *
 * 用法：node scripts/retry-chain-probe.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { apply } = await import('../../lib/host.js')

const HERE = dirname(fileURLToPath(import.meta.url))
const ART = join(HERE, '..', 'artifacts')

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}
const keysOf = (obj) => Object.keys(obj).sort().join(',')
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---------------------------------------------------------------- 假 ctx（verifier 自己实现）
const lastRetry = (agent) => agent.session.events.filter((e) => e.type === 'llm/retry').at(-1)

function makeHarness(pluginConfig, internals) {
  const listeners = new Map()
  const effects = []
  const infos = []
  const warnings = []
  let projection
  const cells = new WeakMap()

  const fold = (session, event) => {
    const prev = cells.get(session) ?? {}
    cells.set(session, projection.apply(prev, event))
  }
  const ctx = {
    logger: {
      warn: (m) => warnings.push(String(m)),
      info: (m) => infos.push(String(m)),
      error: () => {},
    },
    fiber: { entry: { id: 'dsh-retry-policy', options: { id: 'dsh-retry-policy', name: 'dsh-retry-policy' } } },
    sessionProjections: {
      register(def) {
        projection = def
        return () => { projection = undefined }
      },
      stateOf(session, key) {
        if (key !== 'llmRetry' || projection === undefined) return undefined
        if (!cells.has(session)) cells.set(session, projection.init())
        return cells.get(session)
      },
    },
    get: () => undefined,
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
      if (!required.includes('webServer')) return
      callback({
        webServer: { register: () => () => {} },
        effect(execute, label) {
          effects.push({ dispose: execute(), label })
          return () => {}
        },
      })
    },
  }

  apply(ctx, pluginConfig, internals ?? { random: () => 0.5 })

  const makeAgent = () => {
    const session = {
      header: { version: 1, id: 'probe-session' },
      events: [],
      append(type, data) {
        const event = { type, data }
        session.events.push(event)
        fold(session, event)
        return event
      },
    }
    return { id: 'probe-session', session }
  }

  return {
    projection: () => projection,
    effects,
    infos,
    warnings,
    makeAgent,
    recover: () => (listeners.get('agent/request-error') ?? [])[0],
    disposers: () => effects.map((e) => e.dispose),
  }
}

function callRecover(h, { agent, provider = 'probe-provider', code = 'SERVER', failure, retryPolicy, signal, downstream = async () => undefined }) {
  const listener = h.recover()
  const calls = { next: 0 }
  const payload = {
    agent,
    turn: 1,
    step: 1,
    provider,
    failure: failure ?? { message: 'probe failure', code },
    retryPolicy,
    signal: signal ?? new AbortController().signal,
  }
  const next = async () => {
    calls.next += 1
    return downstream()
  }
  return listener(payload, next).then((action) => ({ action, nextCalls: calls.next }))
}

const NORMAL_CONFIG = {
  enabled: true,
  mode: 'inherit',
  maxRetries: 2,
  strategy: 'fixed',
  initialDelayMs: 1,
  maxDelayMs: 50,
  multiplier: 2,
  jitterRatio: 0,
  retryableCodes: ['SERVER', 'RATE_LIMIT'],
  respectRetryAfter: true,
}

// ================================================================ 1. normal：事件形状 + 预算
{
  const h = makeHarness(NORMAL_CONFIG)
  const def = h.projection()
  check('投影已注册 llmRetry/stateVersion=1', def?.key === 'llmRetry' && def?.stateVersion === 1,
    `key=${def?.key} stateVersion=${def?.stateVersion}`)
  const agent = h.makeAgent()

  const r1 = await callRecover(h, { agent })
  const ev1 = lastRetry(agent)
  check('第 1 次：返回 {kind:retry} 且不调 next', eq(r1.action, { kind: 'retry' }) && r1.nextCalls === 0,
    `action=${JSON.stringify(r1.action)} nextCalls=${r1.nextCalls}`)
  check('llm/retry 事件字段集（normal）',
    keysOf(ev1.data) === 'delayMs,failure,maxRetries,mode,policyKey,provider,retry,retryId,step,turn',
    keysOf(ev1.data))
  check('normal 事件内容（retry=1/maxRetries=2/delayMs=1）',
    ev1.data.retry === 1 && ev1.data.maxRetries === 2 && ev1.data.delayMs === 1 && ev1.data.mode === 'normal',
    JSON.stringify({ retry: ev1.data.retry, maxRetries: ev1.data.maxRetries, delayMs: ev1.data.delayMs, mode: ev1.data.mode }))
  const started1 = agent.session.events.at(-1)
  check('llm/retry-started 字段集', started1.type === 'llm/retry-started'
    && keysOf(started1.data) === 'retry,retryId,step,turn', `${started1.type} ${keysOf(started1.data)}`)
  check('同一次重试串共用 retryId', started1.data.retryId === ev1.data.retryId,
    `${started1.data.retryId === ev1.data.retryId}`)

  const r2 = await callRecover(h, { agent })
  const ev2 = lastRetry(agent)
  check('第 2 次：retry=2 且沿用同一 retryId', eq(r2.action, { kind: 'retry' }) && ev2.data.retry === 2 && ev2.data.retryId === ev1.data.retryId,
    `retry=${ev2.data.retry} sameRetryId=${ev2.data.retryId === ev1.data.retryId}`)

  const r3 = await callRecover(h, { agent })
  check('预算耗尽（maxRetries=2）→ 调用下游而非直接 undefined',
    r3.nextCalls === 1 && r3.action === undefined, `nextCalls=${r3.nextCalls} action=${JSON.stringify(r3.action)}`)
  check('预算耗尽后不再写 llm/retry',
    agent.session.events.filter((e) => e.type === 'llm/retry').length === 2,
    `n=${agent.session.events.filter((e) => e.type === 'llm/retry').length}`)

  // step/start 清零预算
  agent.session.append('step/start', {})
  const r4 = await callRecover(h, { agent })
  const ev4 = lastRetry(agent)
  check('step/start 后预算清零（retry 回到 1）', eq(r4.action, { kind: 'retry' }) && ev4.data.retry === 1, `retry=${ev4.data.retry}`)

  // 不同 provider 独立计数
  agent.session.append('step/start', {})
  const other = await callRecover(h, { agent, provider: 'another-provider' })
  const evOther = lastRetry(agent)
  check('预算按 provider 独立计数', eq(other.action, { kind: 'retry' }) && evOther.data.retry === 1 && evOther.data.provider === 'another-provider',
    `provider=${evOther.data.provider} retry=${evOther.data.retry}`)

  // 不归本插件管的失败码 → next()，无事件
  const before = agent.session.events.length
  const r5 = await callRecover(h, { agent, code: 'AUTH' })
  check('非 retryableCodes（AUTH）→ next() 且不写事件', r5.nextCalls === 1 && agent.session.events.length === before,
    `nextCalls=${r5.nextCalls} newEvents=${agent.session.events.length - before}`)

  // 不同策略 → 不同 policyKey（预算键含 strategy/multiplier）
  const keyA = ev1.data.policyKey
  const h2 = makeHarness({ ...NORMAL_CONFIG, strategy: 'exponential' })
  const a2 = h2.makeAgent()
  const r6 = await callRecover(h2, { agent: a2 })
  const keyB = lastRetry(a2).data.policyKey
  check('policyKey 随策略变化（策略变则预算重置）', keyA !== keyB && typeof keyA === 'string', `${keyA} vs ${keyB}`)
}

// ================================================================ 2. always 模式
{
  const h = makeHarness({ ...NORMAL_CONFIG, mode: 'always' })
  const agent = h.makeAgent()
  // 下游接管 → 原样采纳，不写事件
  const r1 = await callRecover(h, { agent, downstream: async () => ({ kind: 'retry' }) })
  check('always：下游给 retry 就采纳且本插件不写事件',
    eq(r1.action, { kind: 'retry' }) && r1.nextCalls === 1 && agent.session.events.length === 0,
    `nextCalls=${r1.nextCalls} events=${agent.session.events.length}`)
  // 下游不管 → 本插件兜底；事件无 maxRetries
  const r2 = await callRecover(h, { agent, downstream: async () => undefined })
  const ev = lastRetry(agent)
  check('always：下游不管则兜底重试',
    eq(r2.action, { kind: 'retry' }) && r2.nextCalls === 1 && agent.session.events.filter((e) => e.type === 'llm/retry').length === 1,
    `action=${JSON.stringify(r2.action)}`)
  check('always 事件无 maxRetries 字段',
    keysOf(ev.data) === 'delayMs,failure,mode,policyKey,provider,retry,retryId,step,turn' && ev.data.mode === 'always' && ev.data.retry === 1,
    keysOf(ev.data))
  // 超出预算也不停（always 无限）
  const h3 = makeHarness({ ...NORMAL_CONFIG, mode: 'always', maxRetries: 0 })
  const a3 = h3.makeAgent()
  const r3 = await callRecover(h3, { agent: a3, downstream: async () => undefined })
  check('always：maxRetries=0 仍重试（无预算概念）', eq(r3.action, { kind: 'retry' }), JSON.stringify(r3.action))
}

// ================================================================ 3. Retry-After
{
  const h = makeHarness(NORMAL_CONFIG)
  const agent = h.makeAgent()
  const r1 = await callRecover(h, { agent, failure: { message: 'x', code: 'SERVER', providerRetryAfterMs: 7 } })
  const ev1 = lastRetry(agent)
  check('Retry-After(7ms) 优先于本地公式(1ms)', eq(r1.action, { kind: 'retry' }) && ev1.data.delayMs === 7, `delayMs=${ev1.data.delayMs}`)

  const agent2 = h.makeAgent()
  const r2 = await callRecover(h, { agent: agent2, failure: { message: 'x', code: 'SERVER', providerRetryAfterMs: 9999 } })
  check('Retry-After > maxDelayMs 且 normal → 放弃并 next()',
    r2.nextCalls === 1 && r2.action === undefined && agent2.session.events.length === 0,
    `nextCalls=${r2.nextCalls} events=${agent2.session.events.length}`)

  const hNo = makeHarness({ ...NORMAL_CONFIG, respectRetryAfter: false })
  const agent3 = hNo.makeAgent()
  const r3 = await callRecover(hNo, { agent: agent3, failure: { message: 'x', code: 'SERVER', providerRetryAfterMs: 7 } })
  const ev3 = lastRetry(agent3)
  check('respectRetryAfter=false → 用本地公式(1ms)', ev3.data.delayMs === 1, `delayMs=${ev3.data.delayMs}`)
}

// ================================================================ 4. enabled:false → 内置默认常量（SPEC §4 / §9）
{
  const h = makeHarness({ ...NORMAL_CONFIG, enabled: false })
  const agent = h.makeAgent()
  const r = await callRecover(h, { agent })
  const ev = lastRetry(agent)
  check('enabled:false → 仍由本插件执行，但用内置常量（5 次 / 500ms）',
    eq(r.action, { kind: 'retry' }) && r.nextCalls === 0 && ev?.data.maxRetries === 5 && ev?.data.delayMs === 500,
    `action=${JSON.stringify(r.action)} nextCalls=${r.nextCalls} maxRetries=${ev?.data.maxRetries} delayMs=${ev?.data.delayMs}`)
  check('enabled:false 时非官方码（AUTH）仍交回下游',
    (await callRecover(h, { agent, code: 'AUTH' })).nextCalls === 1, 'AUTH → next()')
}

// ================================================================ 5. 取消排空
{
  const h = makeHarness({ ...NORMAL_CONFIG, initialDelayMs: 3000, maxDelayMs: 3000 })
  const agent = h.makeAgent()
  const controller = new AbortController()
  const pending = callRecover(h, { agent, signal: controller.signal })
  // 等到 llm/retry 已落事件（排定），再 abort
  await new Promise((r) => setTimeout(r, 30))
  const scheduled = agent.session.events.filter((e) => e.type === 'llm/retry').length
  controller.abort()
  const settled = await Promise.race([
    pending,
    new Promise((r) => setTimeout(() => r({ action: 'TIMEOUT' }), 1500)),
  ])
  check('取消后等待被中断（不等满 3000ms）且不返回 retry',
    settled.action !== 'TIMEOUT' && settled.action === undefined,
    `action=${JSON.stringify(settled.action)}`)
  check('取消后不再写 llm/retry-started',
    agent.session.events.filter((e) => e.type === 'llm/retry-started').length === 0
      && scheduled === 1 && agent.session.events.filter((e) => e.type === 'llm/retry').length === 1,
    `scheduled=${scheduled} started=${agent.session.events.filter((e) => e.type === 'llm/retry-started').length}`)

  // 插件卸载：dispose 必须 abort 在飞等待并排空（不悬挂）
  const h2 = makeHarness({ ...NORMAL_CONFIG, initialDelayMs: 3000, maxDelayMs: 3000 })
  const agent2 = h2.makeAgent()
  const pending2 = callRecover(h2, { agent: agent2 })
  await new Promise((r) => setTimeout(r, 30))
  const t0 = Date.now()
  const drain = await Promise.race([
    Promise.allSettled(h2.disposers().map((d) => d())),
    new Promise((r) => setTimeout(() => r('TIMEOUT'), 1500)),
  ])
  const elapsed = Date.now() - t0
  const settled2 = await pending2
  check('dispose：abort 在飞等待并排空（allSettled 不超时）',
    drain !== 'TIMEOUT' && elapsed < 1000 && settled2.action === undefined,
    `elapsed=${elapsed}ms action=${JSON.stringify(settled2.action)}`)
  check('dispose 后不再写 llm/retry-started',
    agent2.session.events.filter((e) => e.type === 'llm/retry-started').length === 0,
    `started=${agent2.session.events.filter((e) => e.type === 'llm/retry-started').length}`)
  check('effect 标签符合 SPEC §5.1',
    h2.effects.some((e) => e.label === 'dsh-retry-policy: abort and drain active recovery')
      && h2.effects.some((e) => e.label === 'dsh-retry-policy: policy route'),
    h2.effects.map((e) => e.label).join(' | '))
}

// ================================================================ 6. 落盘事件不可见性（不写模型历史）
{
  const h = makeHarness(NORMAL_CONFIG)
  const agent = h.makeAgent()
  await callRecover(h, { agent })
  const types = [...new Set(agent.session.events.map((e) => e.type))]
  check('只写 llm/retry 与 llm/retry-started（不碰模型可见历史）',
    eq(types.sort(), ['llm/retry', 'llm/retry-started']), types.join(','))
}

mkdirSync(ART, { recursive: true })
const failed = results.filter((r) => !r.pass)
writeFileSync(join(ART, 'C-retry-chain-probe.json'), JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2))
console.log(`\n=== total=${results.length} failed=${failed.length} ===`)
for (const f of failed) console.log(`FAILED: ${f.name} :: ${f.detail}`)
process.exit(failed.length === 0 ? 0 : 1)
