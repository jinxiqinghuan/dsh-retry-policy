/**
 * lib/policy.js 的单测：逐条对着 SPEC §2/§3/§4/§5.1/§5.4 验证。
 * 这里不碰 cordis，全是纯函数，所以断言可以直接写成契约本身。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  BUILTIN_DEFAULT,
  CODE_OPTIONS,
  CONFIG_KEYS,
  DEFAULTS,
  OFFICIAL_RETRYABLE_CODES,
  PolicyError,
  RETRY_PROJECTION_KEY,
  RETRY_PROJECTION_STATE_VERSION,
  RETRY_STATE_SCHEMA,
  STRATEGY_OPTIONS,
  configToPatchRow,
  delayFor,
  effectiveView,
  normalizeConfig,
  normalizeConfigSafe,
  previewCount,
  previewDelays,
  resolveEffectivePolicy,
  retryPolicyKey,
  retryProjectionApply,
  retryProjectionInit,
  retryStateKey,
} from '../lib/policy.js'

const POLICY_SOURCE = readFileSync(fileURLToPath(new URL('../lib/policy.js', import.meta.url)), 'utf8')

// ----------------------------------------------------------------- 默认值

test('DEFAULTS 与补丁默认值一致且被冻结', () => {
  assert.deepEqual({ ...DEFAULTS, retryableCodes: [...DEFAULTS.retryableCodes] }, {
    enabled: true,
    mode: 'inherit',
    maxRetries: 10,
    strategy: 'exponential',
    initialDelayMs: 1000,
    maxDelayMs: 60000,
    multiplier: 2,
    jitterRatio: 0.1,
    retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
    respectRetryAfter: true,
  })
  assert.ok(Object.isFrozen(DEFAULTS))
  assert.ok(Object.isFrozen(DEFAULTS.retryableCodes))
  assert.deepEqual(CONFIG_KEYS, [
    'enabled', 'mode', 'maxRetries', 'strategy', 'initialDelayMs',
    'maxDelayMs', 'multiplier', 'jitterRatio', 'retryableCodes', 'respectRetryAfter',
  ])
})

test('BUILTIN_DEFAULT 是官方内置常量（500→10000 / 5 次 / 0.1）', () => {
  assert.equal(BUILTIN_DEFAULT.mode, 'normal')
  assert.equal(BUILTIN_DEFAULT.maxRetries, 5)
  assert.equal(BUILTIN_DEFAULT.initialDelayMs, 500)
  assert.equal(BUILTIN_DEFAULT.maxDelayMs, 10000)
  assert.equal(BUILTIN_DEFAULT.jitterRatio, 0.1)
  assert.deepEqual([...BUILTIN_DEFAULT.retryableCodes], [...OFFICIAL_RETRYABLE_CODES])
  assert.equal(BUILTIN_DEFAULT.source, 'builtin')
})

test('policy.js 不引用 Math.random（随机源必须注入）', () => {
  // 去掉注释后再查：文件头的说明文字里提到过 Math.random
  const code = POLICY_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(/Math\s*\.\s*random/.test(code), false)
})

// ----------------------------------------------------------------- normalizeConfig

test('normalizeConfig：空配置/undefined 得到完整默认值', () => {
  assert.deepEqual(normalizeConfig(undefined), { ...DEFAULTS, retryableCodes: [...DEFAULTS.retryableCodes] })
  assert.deepEqual(normalizeConfig({}), { ...DEFAULTS, retryableCodes: [...DEFAULTS.retryableCodes] })
  assert.deepEqual(normalizeConfig(null), { ...DEFAULTS, retryableCodes: [...DEFAULTS.retryableCodes] })
})

test('normalizeConfig：未知键抛 PolicyError 且带 issues', () => {
  assert.throws(() => normalizeConfig({ nope: 1 }), (error) => {
    assert.ok(error instanceof PolicyError)
    assert.ok(error instanceof Error)
    assert.deepEqual(error.issues, [{ field: 'nope', message: '未知配置项 nope' }])
    assert.match(error.message, /nope/)
    return true
  })
  assert.throws(() => normalizeConfig([1, 2]), PolicyError)
  assert.throws(() => normalizeConfig('x'), PolicyError)
})

test('normalizeConfig：类型错全部拒绝（含 null 不算缺省）', () => {
  const cases = [
    [{ enabled: 1 }, 'enabled'],
    [{ mode: true }, 'mode'],
    [{ maxRetries: '3' }, 'maxRetries'],
    [{ maxRetries: 3.5 }, 'maxRetries'],
    [{ maxRetries: null }, 'maxRetries'],
    [{ strategy: 'random' }, 'strategy'],
    [{ initialDelayMs: '1000' }, 'initialDelayMs'],
    [{ multiplier: '2' }, 'multiplier'],
    [{ jitterRatio: false }, 'jitterRatio'],
    [{ retryableCodes: 'SERVER' }, 'retryableCodes'],
    [{ respectRetryAfter: 'yes' }, 'respectRetryAfter'],
  ]
  for (const [raw, field] of cases) {
    assert.throws(() => normalizeConfig(raw), (error) => {
      assert.ok(error instanceof PolicyError, `${JSON.stringify(raw)} 应当抛 PolicyError`)
      assert.ok(error.issues.some((issue) => issue.field === field), `${field} 应当出现在 issues 里`)
      return true
    })
  }
})

test('normalizeConfig：越界全部拒绝', () => {
  const cases = [
    [{ maxRetries: -1 }, 'maxRetries'],
    [{ maxRetries: 1001 }, 'maxRetries'],
    [{ initialDelayMs: 0 }, 'initialDelayMs'],
    [{ initialDelayMs: 3_600_001 }, 'initialDelayMs'],
    [{ maxDelayMs: 0 }, 'maxDelayMs'],
    [{ maxDelayMs: 3_600_001 }, 'maxDelayMs'],
    [{ multiplier: 0.5 }, 'multiplier'],
    [{ multiplier: 101 }, 'multiplier'],
    [{ jitterRatio: -0.1 }, 'jitterRatio'],
    [{ jitterRatio: 1.5 }, 'jitterRatio'],
  ]
  for (const [raw, field] of cases) {
    assert.throws(() => normalizeConfig(raw), (error) => {
      assert.ok(error.issues.some((issue) => issue.field === field))
      return true
    })
  }
})

test('normalizeConfig：maxDelayMs 不得小于 initialDelayMs（跨字段）', () => {
  assert.throws(() => normalizeConfig({ initialDelayMs: 5000, maxDelayMs: 1000 }), (error) => {
    assert.deepEqual(error.issues, [{ field: 'maxDelayMs', message: 'maxDelayMs 不能小于 initialDelayMs' }])
    return true
  })
  assert.equal(normalizeConfig({ initialDelayMs: 1000, maxDelayMs: 1000 }).maxDelayMs, 1000)
})

test('normalizeConfig：失败码去重、非空、非空字符串', () => {
  assert.deepEqual(
    normalizeConfig({ retryableCodes: ['SERVER', 'SERVER', 'TIMEOUT'] }).retryableCodes,
    ['SERVER', 'TIMEOUT'],
  )
  for (const bad of [[], ['SERVER', ''], ['   '], [1]]) {
    assert.throws(() => normalizeConfig({ retryableCodes: bad }), (error) => {
      assert.equal(error.issues[0].field, 'retryableCodes')
      return true
    })
  }
})

test('normalizeConfig：一次收齐多个问题', () => {
  assert.throws(() => normalizeConfig({ maxRetries: -1, mode: 'x' }), (error) => {
    assert.deepEqual(error.issues.map((issue) => issue.field).sort(), ['maxRetries', 'mode'])
    return true
  })
})

test('normalizeConfig 幂等，且返回值可安全修改', () => {
  const once = normalizeConfig({ maxRetries: 3 })
  const twice = normalizeConfig(once)
  assert.deepEqual(twice, once)
  assert.notEqual(twice, once)
  assert.notEqual(twice.retryableCodes, once.retryableCodes)
})

test('normalizeConfigSafe：坏配置回落默认值，好配置正常归一化', () => {
  const fallback = normalizeConfigSafe({ maxRetries: -5 })
  assert.deepEqual(fallback, { ...DEFAULTS, retryableCodes: [...DEFAULTS.retryableCodes] })
  assert.notEqual(fallback, DEFAULTS)
  assert.deepEqual(normalizeConfigSafe({ maxRetries: 2 }).maxRetries, 2)
})

// ----------------------------------------------------------------- configToPatchRow

test('configToPatchRow：键顺序固定、纯 JSON、不污染 DEFAULTS', () => {
  const row = configToPatchRow({ maxRetries: 3 })
  assert.deepEqual(Object.keys(row), [...CONFIG_KEYS])
  assert.deepEqual(JSON.parse(JSON.stringify(row)), row)
  row.retryableCodes.push('AUTH')
  assert.equal(DEFAULTS.retryableCodes.includes('AUTH'), false)
  assert.deepEqual(JSON.parse(JSON.stringify(configToPatchRow(DEFAULTS))), {
    ...DEFAULTS, retryableCodes: [...DEFAULTS.retryableCodes],
  })
})

// ----------------------------------------------------------------- delayFor

const base = { initialDelayMs: 1000, maxDelayMs: 60000, jitterRatio: 0, multiplier: 2 }

test('delayFor：fixed / linear / exponential 三种公式（抖动 0）', () => {
  assert.deepEqual([1, 2, 3, 4].map((n) => delayFor({ ...base, strategy: 'fixed' }, n)), [1000, 1000, 1000, 1000])
  assert.deepEqual([1, 2, 3, 4].map((n) => delayFor({ ...base, strategy: 'linear' }, n)), [1000, 2000, 3000, 4000])
  assert.deepEqual([1, 2, 3, 4].map((n) => delayFor({ ...base, strategy: 'exponential' }, n)), [1000, 2000, 4000, 8000])
  assert.deepEqual([1, 2, 3].map((n) => delayFor({ ...base, strategy: 'exponential', multiplier: 3 }, n)), [1000, 3000, 9000])
})

test('delayFor：先夹上限、抖动后再夹一次、至少 1ms', () => {
  const policy = { strategy: 'exponential', initialDelayMs: 1000, maxDelayMs: 3000, jitterRatio: 0, multiplier: 2 }
  assert.deepEqual([1, 2, 3, 4].map((n) => delayFor(policy, n)), [1000, 2000, 3000, 3000])
  // 抖动把 3000 顶到 3300，仍被 maxDelayMs 夹回 3000
  assert.equal(delayFor({ ...policy, jitterRatio: 1 }, 3, () => 1), 3000)
  // 抖动到底：1000 * (1 - 1 + 0) = 0 → 抬到 1ms
  assert.equal(delayFor({ ...base, strategy: 'fixed', jitterRatio: 1 }, 1, () => 0), 1)
  // 四舍五入
  assert.equal(delayFor({ ...base, strategy: 'fixed', initialDelayMs: 101, jitterRatio: 0.5 }, 1, () => 1), 152)
})

test('delayFor：对称抖动按 rand 线性取值', () => {
  const policy = { ...base, strategy: 'fixed', jitterRatio: 0.1 }
  assert.equal(delayFor(policy, 1, () => 0), 900)
  assert.equal(delayFor(policy, 1, () => 0.5), 1000)
  assert.equal(delayFor(policy, 1, () => 1), 1100)
})

test('delayFor：attempt 从 1 起算，非法 attempt 退回 1；指数上限不会溢出', () => {
  const policy = { ...base, strategy: 'linear' }
  assert.equal(delayFor(policy, 0), 1000)
  assert.equal(delayFor(policy, -5), 1000)
  assert.equal(delayFor({ strategy: 'exponential', initialDelayMs: 3_600_000, maxDelayMs: 3_600_000, jitterRatio: 0, multiplier: 100 }, 1000), 3_600_000)
})

test('delayFor：rand 抛错/返回非有限值时退回中值', () => {
  const policy = { ...base, strategy: 'fixed', jitterRatio: 0.1 }
  assert.equal(delayFor(policy, 1, () => Number.NaN), 1000)
  assert.equal(delayFor(policy, 1, () => { throw new Error('boom') }), 1000)
})

// ----------------------------------------------------------------- previewDelays / effectiveView

test('previewDelays：默认按生效预算取条数（normal = min(maxRetries, 10)，always = 10）', () => {
  assert.deepEqual(previewDelays(DEFAULTS), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000])
  assert.deepEqual(previewDelays({ ...DEFAULTS, maxRetries: 3 }), [1000, 2000, 4000])
  assert.deepEqual(previewDelays({ ...DEFAULTS, maxRetries: 0 }), [])
  assert.deepEqual(previewDelays({ ...DEFAULTS, mode: 'always' }), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000])
  assert.equal(previewDelays({ ...DEFAULTS, mode: 'always' }).length, 10)
})

test('previewDelays：关闭接管时按官方内置常量算', () => {
  assert.deepEqual(previewDelays({ ...DEFAULTS, enabled: false }), [500, 1000, 2000, 4000, 8000])
})

test('previewDelays：显式 count 生效并夹到 10；抖动取中值', () => {
  assert.deepEqual(previewDelays({ ...DEFAULTS, maxRetries: 5 }, 2), [1000, 2000])
  assert.equal(previewDelays(DEFAULTS, 99).length, 10)
  assert.deepEqual(previewDelays(DEFAULTS, 3), [1000, 2000, 4000])
  // rand 注入后应当整体变大
  assert.ok(previewDelays(DEFAULTS, 1, () => 1)[0] > previewDelays(DEFAULTS, 1)[0])
})

test('previewCount：normal 看预算，always 取 10', () => {
  assert.equal(previewCount({ mode: 'normal', maxRetries: 4 }), 4)
  assert.equal(previewCount({ mode: 'normal', maxRetries: 0 }), 0)
  assert.equal(previewCount({ mode: 'always' }), 10)
})

test('effectiveView：normal 带 maxRetries，always 不带（SPEC §4 形状）', () => {
  const normal = effectiveView(resolveEffectivePolicy(DEFAULTS, undefined))
  assert.equal(normal.mode, 'normal')
  assert.equal(normal.maxRetries, 10)
  assert.equal(normal.strategy, 'exponential')
  assert.equal(normal.multiplier, 2)
  assert.equal(normal.source, 'config')
  assert.deepEqual(Object.keys(normal).sort(), [
    'initialDelayMs', 'jitterRatio', 'maxDelayMs', 'maxRetries', 'mode',
    'multiplier', 'preview', 'respectRetryAfter', 'source', 'strategy',
  ])
  const always = effectiveView(resolveEffectivePolicy({ ...DEFAULTS, mode: 'always' }, undefined))
  assert.equal(always.mode, 'always')
  assert.equal('maxRetries' in always, false)
  assert.equal(always.preview.length, 10)
})

// ----------------------------------------------------------------- resolveEffectivePolicy

test('resolveEffectivePolicy：关闭接管 → 官方内置（source disabled）', () => {
  const effective = resolveEffectivePolicy({ ...DEFAULTS, enabled: false, maxRetries: 99 }, undefined)
  assert.equal(effective.mode, 'normal')
  assert.equal(effective.maxRetries, 5)
  assert.equal(effective.initialDelayMs, 500)
  assert.equal(effective.maxDelayMs, 10000)
  assert.equal(effective.source, 'disabled')
})

test('resolveEffectivePolicy：mode=always → always + 本插件退避', () => {
  const effective = resolveEffectivePolicy({ ...DEFAULTS, mode: 'always', initialDelayMs: 2000 }, undefined)
  assert.equal(effective.mode, 'always')
  assert.equal('maxRetries' in effective, false)
  assert.equal(effective.initialDelayMs, 2000)
  assert.equal(effective.source, 'config')
})

test('resolveEffectivePolicy：提供方要 always 就尊重它（source provider-always）', () => {
  const effective = resolveEffectivePolicy(DEFAULTS, { mode: 'always', initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 })
  assert.equal(effective.mode, 'always')
  assert.equal(effective.initialDelayMs, DEFAULTS.initialDelayMs)
  assert.equal(effective.source, 'provider-always')
})

test('resolveEffectivePolicy：normal 用本插件的次数与失败码，不用提供方的 5 次', () => {
  const provided = { mode: 'normal', maxRetries: 5, retryableCodes: ['SERVER'], initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 }
  const effective = resolveEffectivePolicy(DEFAULTS, provided)
  assert.equal(effective.mode, 'normal')
  assert.equal(effective.maxRetries, 10)
  assert.deepEqual(effective.retryableCodes, [...DEFAULTS.retryableCodes])
  assert.equal(effective.source, 'config')
  assert.equal(resolveEffectivePolicy(DEFAULTS, undefined).source, 'config')
})

test('resolveEffectivePolicy：配置非法抛 PolicyError', () => {
  assert.throws(() => resolveEffectivePolicy({ maxRetries: -1 }, undefined), PolicyError)
})

// ----------------------------------------------------------------- 预算键

test('retryPolicyKey：稳定、codes 顺序无关、影响行为的字段都进键', () => {
  const policy = resolveEffectivePolicy(DEFAULTS, undefined)
  assert.equal(retryPolicyKey(policy), retryPolicyKey({ ...policy, retryableCodes: [...policy.retryableCodes].reverse() }))
  assert.deepEqual(JSON.parse(retryPolicyKey(policy)), [
    'normal', 10, [...DEFAULTS.retryableCodes].sort(), 1000, 60000, 0.1, 'exponential', 2,
  ])
  assert.notEqual(retryPolicyKey(policy), retryPolicyKey({ ...policy, maxRetries: 9 }))
  assert.notEqual(retryPolicyKey(policy), retryPolicyKey({ ...policy, strategy: 'fixed' }))
  assert.notEqual(retryPolicyKey(policy), retryPolicyKey({ ...policy, multiplier: 3 }))
  assert.notEqual(retryPolicyKey(policy), retryPolicyKey({ ...policy, maxDelayMs: 30000 }))
  const always = resolveEffectivePolicy({ ...DEFAULTS, mode: 'always' }, undefined)
  assert.deepEqual(JSON.parse(retryPolicyKey(always)), ['always', 1000, 60000, 0.1, 'exponential', 2])
  assert.notEqual(retryPolicyKey(always), retryPolicyKey(policy))
})

test('retryStateKey：按 (provider, 策略) 组合', () => {
  assert.equal(retryStateKey('loomy', 'K'), JSON.stringify(['loomy', 'K']))
  assert.notEqual(retryStateKey('loomy', 'K'), retryStateKey('other', 'K'))
})

// ----------------------------------------------------------------- 投影

test('投影常量与官方一致', () => {
  assert.equal(RETRY_PROJECTION_KEY, 'llmRetry')
  assert.equal(RETRY_PROJECTION_STATE_VERSION, 1)
})

test('retryProjectionApply：step/start 与 turn/end 清零，非重试事件原样放行', () => {
  const state = { K: { retry: 3, retryId: 'r1' } }
  assert.deepEqual(retryProjectionApply(state, { type: 'step/start', data: {} }), {})
  assert.deepEqual(retryProjectionApply(state, { type: 'turn/end', data: {} }), {})
  assert.equal(retryProjectionApply(state, { type: 'assistant/message', data: {} }), state)
  assert.equal(retryProjectionApply(state, { type: 'llm/retry-started', data: {} }), state)
  assert.deepEqual(retryProjectionInit(), {})
})

test('retryProjectionApply：llm/retry 写入预算，完全相同的 retry+retryId 返回原引用', () => {
  const state = retryProjectionInit()
  const data = { provider: 'loomy', policyKey: 'K', retry: 1, retryId: 'r1' }
  const next = retryProjectionApply(state, { type: 'llm/retry', data })
  assert.deepEqual(next, { [retryStateKey('loomy', 'K')]: { retry: 1, retryId: 'r1' } })
  assert.equal(retryProjectionApply(next, { type: 'llm/retry', data }), next)
  const advanced = retryProjectionApply(next, { type: 'llm/retry', data: { ...data, retry: 2 } })
  assert.deepEqual(advanced[retryStateKey('loomy', 'K')], { retry: 2, retryId: 'r1' })
  // 入参不被修改
  assert.deepEqual(state, {})
  assert.deepEqual(next[retryStateKey('loomy', 'K')], { retry: 1, retryId: 'r1' })
})

test('retryProjectionApply：不同 provider 各记一份', () => {
  let state = retryProjectionInit()
  state = retryProjectionApply(state, { type: 'llm/retry', data: { provider: 'a', policyKey: 'K', retry: 1, retryId: 'r1' } })
  state = retryProjectionApply(state, { type: 'llm/retry', data: { provider: 'b', policyKey: 'K', retry: 1, retryId: 'r2' } })
  assert.deepEqual(Object.keys(state).sort(), [retryStateKey('a', 'K'), retryStateKey('b', 'K')].sort())
})

test('RETRY_STATE_SCHEMA：校验落盘状态并剥掉未知键（zod 语义）', () => {
  const parsed = RETRY_STATE_SCHEMA.parse({ K: { retry: 2, retryId: 'r1', extra: true } })
  assert.deepEqual(parsed, { K: { retry: 2, retryId: 'r1' } })
  assert.deepEqual(RETRY_STATE_SCHEMA.parse({}), {})
  for (const bad of [null, [], 'x', { K: null }, { K: { retry: -1, retryId: 'r' } }, { K: { retry: 1.5, retryId: 'r' } }, { K: { retry: 1 } }, { K: { retry: 1, retryId: 2 } }]) {
    assert.throws(() => RETRY_STATE_SCHEMA.parse(bad), TypeError)
  }
})

// ----------------------------------------------------------------- 展示常量

test('设置页选项与 SPEC §6 一致', () => {
  assert.deepEqual(STRATEGY_OPTIONS.map((option) => option.id), ['fixed', 'linear', 'exponential'])
  assert.deepEqual(STRATEGY_OPTIONS.map((option) => option.label), ['固定间隔', '线性增长', '指数退避'])
  assert.deepEqual([...CODE_OPTIONS], [
    'EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT',
    'AUTH', 'QUOTA', 'INVALID_REQUEST', 'PROTOCOL', 'CONTEXT_OVERFLOW',
  ])
})
