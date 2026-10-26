/**
 * dsh-retry-policy 的纯逻辑半边（零 IO、零 cordis、零第三方依赖）。
 *
 * 为什么单独拆一个文件：宿主引擎（lib/host.js）跑在 cordis 里、要写会话事件，很难单测；
 * 把「配置归一化 + 等待时间公式 + 生效策略解析 + 事件/投影定义」全部收在这里的纯函数里，
 * 就能用 `node --test` 直接对着 SPEC §2/§3/§4 逐条验证，设置页也能复用同一套公式做本地预览
 * （两边算出来必须一模一样，否则保存前的预览和保存后的实际延迟会对不上）。
 *
 * 硬约束：只 import `node:*` 与包内相对路径；不 import 任何 `@deepseek-ai/*`（本地 link 解析不到）；
 * 不引用 `Math.random`（随机数一律由参数注入：宿主传 `Math.random`，测试传定值）。
 */

// ----------------------------------------------------------------- 常量

/** Loader entry id，同时也是 HTTP 响应的 entryId。 */
const ENTRY_ID = 'dsh-retry-policy'
/** 设置页读写配置的宿主路由（SPEC §6）。 */
const ROUTE = '/dsh-retry-policy/policy'
/** 请求体上限；设置页只发一个小 JSON，超过这个数一定是打错了。 */
const MAX_BODY_BYTES = 64 * 1024

/** 模型请求失败瀑布：本插件是链上唯一的重试执行器。 */
const REQUEST_ERROR_EVENT = 'agent/request-error'
/** 会话事件：已排定一次重试（官方同款，界面/轨迹依赖它）。 */
const RETRY_EVENT = 'llm/retry'
/** 会话事件：延迟结束、马上真正重发请求。 */
const RETRY_STARTED_EVENT = 'llm/retry-started'
/** 官方 llm-retry 用的投影 key 与版本；必须逐字节保持一致，否则会话快照里读不到预算。 */
const RETRY_PROJECTION_KEY = 'llmRetry'
const RETRY_PROJECTION_STATE_VERSION = 1
/** 这两个事件把预算清零（官方语义：每个 step、每个 turn 都是新预算）。 */
const RESET_EVENT_TYPES = Object.freeze(['step/start', 'turn/end'])

/** 官方内置的参与重试的失败码（禁用接管时原样沿用）。 */
const OFFICIAL_RETRYABLE_CODES = Object.freeze([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
])

const STRATEGIES = Object.freeze(['fixed', 'linear', 'exponential'])

/** 设置页的三段式选择（id 与 config.strategy 一致）。 */
const STRATEGY_OPTIONS = Object.freeze([
  Object.freeze({ id: 'fixed', label: '固定间隔' }),
  Object.freeze({ id: 'linear', label: '线性增长' }),
  Object.freeze({ id: 'exponential', label: '指数退避' }),
])

/** 设置页多选的可选失败码；前五个是官方内置值，其余为便于用户覆盖永久性错误。 */
const CODE_OPTIONS = Object.freeze([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'AUTH',
  'QUOTA',
  'INVALID_REQUEST',
  'PROTOCOL',
  'CONTEXT_OVERFLOW',
])

/**
 * 本插件的默认配置（= cordis.patch.yml 里 insert 行的 config）。
 * 冻结是为了挡住「某处顺手改一下 DEFAULTS」这类事故——它是契约，不是工作副本。
 */
const DEFAULTS = Object.freeze({
  // false = 不接管，退回官方内置策略（normal / 5 次 / 500→10000 / 0.1 抖动）
  enabled: true,
  // inherit = 沿用提供方策略模式；always = 对所有提供方强制无限重试
  mode: 'inherit',
  maxRetries: 10,
  strategy: 'exponential',
  initialDelayMs: 1000,
  maxDelayMs: 60000,
  multiplier: 2,
  jitterRatio: 0.1,
  retryableCodes: Object.freeze([...OFFICIAL_RETRYABLE_CODES]),
  respectRetryAfter: true,
})

/** 配置键的固定顺序（= 写进 profile 补丁行的键顺序）。 */
const CONFIG_KEYS = Object.freeze(Object.keys(DEFAULTS))

const LIMITS = Object.freeze({
  maxRetries: Object.freeze([0, 1000]),
  initialDelayMs: Object.freeze([1, 3_600_000]),
  maxDelayMs: Object.freeze([1, 3_600_000]),
  multiplier: Object.freeze([1, 100]),
  jitterRatio: Object.freeze([0, 1]),
})

/**
 * 官方内置默认策略（enabled:false 时回落的目标）。
 * strategy/multiplier 是补上的：官方公式等价于 multiplier=2 的指数退避，
 * 补上以后预览与实际重试都能走同一条公式。
 */
const BUILTIN_DEFAULT = Object.freeze({
  mode: 'normal',
  maxRetries: 5,
  retryableCodes: Object.freeze([...OFFICIAL_RETRYABLE_CODES]),
  initialDelayMs: 500,
  maxDelayMs: 10000,
  jitterRatio: 0.1,
  strategy: 'exponential',
  multiplier: 2,
  respectRetryAfter: true,
  source: 'builtin',
})

// ----------------------------------------------------------------- 配置校验

/** 配置非法时抛这个；`issues` 直接喂给设置页展示。 */
class PolicyError extends Error {
  /**
   * @param {Array<{field: string, message: string}>} issues 逐字段的问题列表。
   */
  constructor(issues) {
    const list = Array.isArray(issues) && issues.length
      ? issues
      : [{ field: 'config', message: String(issues) }]
    super(`配置不合法：${list.map((issue) => `${issue.field}: ${issue.message}`).join('；')}`)
    this.name = 'PolicyError'
    this.issues = list
  }
}

function boolField(raw, field, issues) {
  const value = raw[field]
  if (value === undefined) return DEFAULTS[field]
  if (typeof value !== 'boolean') {
    issues.push({ field, message: `${field} 必须是布尔值` })
    return DEFAULTS[field]
  }
  return value
}

function enumField(raw, field, options, issues) {
  const value = raw[field]
  if (value === undefined) return DEFAULTS[field]
  if (typeof value !== 'string' || !options.includes(value)) {
    issues.push({ field, message: `${field} 只能是 ${options.join(' / ')}` })
    return DEFAULTS[field]
  }
  return value
}

/** 整数 + 区间校验；`Number.isInteger` 已排除 NaN/Infinity/小数。 */
function intField(raw, field, issues) {
  const value = raw[field]
  if (value === undefined) return DEFAULTS[field]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    issues.push({ field, message: `${field} 必须是整数` })
    return DEFAULTS[field]
  }
  const [min, max] = LIMITS[field]
  if (value < min || value > max) {
    issues.push({ field, message: `${field} 必须在 ${min} ~ ${max} 之间（当前 ${value}）` })
    return DEFAULTS[field]
  }
  return value
}

/** 数值（可为小数）+ 区间校验。 */
function numField(raw, field, issues) {
  const value = raw[field]
  if (value === undefined) return DEFAULTS[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push({ field, message: `${field} 必须是数字` })
    return DEFAULTS[field]
  }
  const [min, max] = LIMITS[field]
  if (value < min || value > max) {
    issues.push({ field, message: `${field} 必须在 ${min} ~ ${max} 之间（当前 ${value}）` })
    return DEFAULTS[field]
  }
  return value
}

/** 失败码：非空数组、元素为非空字符串、按首次出现顺序去重。 */
function codesField(raw, issues) {
  const value = raw.retryableCodes
  if (value === undefined) return [...DEFAULTS.retryableCodes]
  if (!Array.isArray(value)) {
    issues.push({ field: 'retryableCodes', message: 'retryableCodes 必须是字符串数组' })
    return [...DEFAULTS.retryableCodes]
  }
  const out = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      issues.push({ field: 'retryableCodes', message: 'retryableCodes 只能包含非空字符串' })
      return [...DEFAULTS.retryableCodes]
    }
    if (!out.includes(item)) out.push(item)
  }
  if (out.length === 0) {
    issues.push({ field: 'retryableCodes', message: 'retryableCodes 不能为空' })
    return [...DEFAULTS.retryableCodes]
  }
  return out
}

/**
 * 把任意原始配置归一化成完整的、可信的配置对象。
 *
 * 语义（SPEC §2）：缺省 → 默认值；类型错 / 越界 / 未知键 → 抛 `PolicyError`。
 * 全部问题一次收齐再抛，避免用户改一个字段报一次错。
 *
 * @param {unknown} raw 来自 patch、设置页或 Loader 的原始值。
 * @returns 归一化后的完整配置（新对象，可安全改）。
 */
function normalizeConfig(raw) {
  if (raw === undefined || raw === null) raw = {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PolicyError([{ field: 'config', message: '配置必须是一个对象' }])
  }

  const issues = []
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(DEFAULTS, key)) issues.push({ field: key, message: `未知配置项 ${key}` })
  }

  const out = {
    enabled: boolField(raw, 'enabled', issues),
    mode: enumField(raw, 'mode', ['inherit', 'always'], issues),
    maxRetries: intField(raw, 'maxRetries', issues),
    strategy: enumField(raw, 'strategy', STRATEGIES, issues),
    initialDelayMs: intField(raw, 'initialDelayMs', issues),
    maxDelayMs: intField(raw, 'maxDelayMs', issues),
    multiplier: numField(raw, 'multiplier', issues),
    jitterRatio: numField(raw, 'jitterRatio', issues),
    retryableCodes: codesField(raw, issues),
    respectRetryAfter: boolField(raw, 'respectRetryAfter', issues),
  }

  // 跨字段约束只在单字段都合法时才判定，否则区间报错已经说清楚了
  if (issues.length === 0 && out.maxDelayMs < out.initialDelayMs) {
    issues.push({ field: 'maxDelayMs', message: 'maxDelayMs 不能小于 initialDelayMs' })
  }
  if (issues.length) throw new PolicyError(issues)
  return out
}

/**
 * `apply()` 专用的safe 版本：坏配置只回落默认值，绝不抛（插件不能因为配置坏掉就不加载）。
 *
 * @param {unknown} raw 原始配置。
 * @returns 归一化配置，或 DEFAULTS 的副本。
 */
function normalizeConfigSafe(raw) {
  try {
    return normalizeConfig(raw)
  } catch {
    return { ...DEFAULTS, retryableCodes: [...DEFAULTS.retryableCodes] }
  }
}

/**
 * 归一化配置 → 写进 profile 补丁行的纯 JSON 对象（键顺序固定，SPEC §2）。
 *
 * @param {unknown} config 原始或已归一化的配置。
 * @returns 纯 JSON 对象（深拷贝，改它不会污染 DEFAULTS）。
 */
function configToPatchRow(config) {
  const normalized = normalizeConfig(config)
  const row = {}
  for (const key of CONFIG_KEYS) {
    row[key] = key === 'retryableCodes' ? [...normalized[key]] : normalized[key]
  }
  return row
}

// ----------------------------------------------------------------- 等待时间（SPEC §3）

function toAttempt(attempt) {
  const value = Math.trunc(Number(attempt))
  return Number.isFinite(value) && value >= 1 ? value : 1
}

/** 抖动系数：rand 由外部注入，取不到有限值就退回中值 0.5（宁可保守也不要 NaN 延迟）。 */
function jitterFactor(jitterRatio, rand) {
  let sample = 0.5
  try {
    const value = Number(rand())
    if (Number.isFinite(value)) sample = Math.min(Math.max(value, 0), 1)
  } catch {
    sample = 0.5
  }
  return 1 - jitterRatio + 2 * jitterRatio * sample
}

/**
 * 第 `attempt` 次重试的等待时间（SPEC §3 的唯一公式）。
 *
 * fixed: base = initialDelayMs；linear: base = initialDelayMs * attempt；
 * exponential: base = initialDelayMs * multiplier ** min(attempt - 1, 64)；
 * 之后夹上限 → 对称抖动 → 四舍五入 → 再夹一次上限 → 至少 1ms。
 *
 * @param {{strategy?: string, multiplier?: number, initialDelayMs: number, maxDelayMs: number, jitterRatio: number}} policy
 *   生效策略（或归一化配置，两者都有这几个字段）。
 * @param {number} attempt 第几次重试，从 1 开始。
 * @param {() => number} [rand] 随机源；宿主注入 Math.random，测试注入定值，默认中值。
 * @returns {number} 毫秒。
 */
function delayFor(policy, attempt, rand = () => 0.5) {
  const n = toAttempt(attempt)
  const strategy = policy.strategy ?? 'exponential'
  const multiplier = Number.isFinite(policy.multiplier) ? policy.multiplier : 2
  const initialDelayMs = policy.initialDelayMs
  const maxDelayMs = policy.maxDelayMs
  const jitterRatio = policy.jitterRatio

  let base
  if (strategy === 'fixed') base = initialDelayMs
  else if (strategy === 'linear') base = initialDelayMs * n
  else base = initialDelayMs * multiplier ** Math.min(n - 1, 64)
  base = Math.min(base, maxDelayMs)

  const jittered = base * jitterFactor(jitterRatio, rand)
  return Math.max(Math.min(Math.round(jittered), maxDelayMs), 1)
}

/** 生效策略一次能排多少次重试（预览条数：normal 看预算，always 取满 10）。 */
function previewCount(effective) {
  if (!effective || effective.mode === 'always') return 10
  const budget = Number.isInteger(effective.maxRetries) ? effective.maxRetries : 0
  return Math.max(0, Math.min(budget, 10))
}

/**
 * 预览前若干次重试的等待时间（抖动取中值：rand=0.5 时 jittered === base，SPEC §3）。
 *
 * @param {unknown} config 归一化配置（或原始配置，内部会归一化）。
 * @param {number} [count] 条数；省略时按生效预算（min(上限, 10)，always 取 10）。
 * @param {() => number} [rand] 随机源，默认中值。
 * @returns {number[]} 逐次等待毫秒。
 */
function previewDelays(config, count, rand = () => 0.5) {
  const effective = resolveEffectivePolicy(config, undefined)
  const total = count === undefined
    ? previewCount(effective)
    : Math.max(0, Math.min(Math.trunc(Number(count)) || 0, 10))
  const out = []
  for (let attempt = 1; attempt <= total; attempt += 1) out.push(delayFor(effective, attempt, rand))
  return out
}

/**
 * GET /policy 里 `effective` 的响应片段：生效策略 + 预览（SPEC §6）。
 *
 * @param {object} effective resolveEffectivePolicy 的结果。
 * @param {() => number} [rand] 随机源，默认中值（预览必须可复现）。
 * @returns {object} 纯 JSON 对象。
 */
function effectiveView(effective, rand = () => 0.5) {
  const view = {
    mode: effective.mode,
    strategy: effective.strategy,
    multiplier: effective.multiplier,
    initialDelayMs: effective.initialDelayMs,
    maxDelayMs: effective.maxDelayMs,
    jitterRatio: effective.jitterRatio,
    respectRetryAfter: effective.respectRetryAfter,
    source: effective.source,
  }
  // always 模式没有次数概念（SPEC §4 的形状），别塞一个假的 maxRetries 误导设置页
  if (effective.mode === 'normal') view.maxRetries = effective.maxRetries
  const total = previewCount(effective)
  const preview = []
  for (let attempt = 1; attempt <= total; attempt += 1) preview.push(delayFor(effective, attempt, rand))
  view.preview = preview
  return view
}

// ----------------------------------------------------------------- 生效策略（SPEC §4）

/**
 * 算出「这一次请求实际按什么策略重试」。
 *
 * 优先级：关闭接管 → 官方内置；插件强制 always → always；提供方要求 always → 尊重它；
 * 否则按配置的 normal（次数 + 失败码）。
 *
 * @param {unknown} config 归一化配置。
 * @param {{mode?: string}|undefined} providedPolicy payload 里的 `retryPolicy`。
 * @returns {object} 与官方 ResolvedRetryPolicy 同构（additional: strategy/multiplier/respectRetryAfter/source）。
 * @throws {PolicyError} 配置非法时。
 */
function resolveEffectivePolicy(config, providedPolicy) {
  const cfg = normalizeConfig(config)

  if (!cfg.enabled) {
    // 用户关掉接管：回落官方内置常量。source 用 'disabled' 让设置页能区分
    // 「内置策略」和「用户主动关掉」两种都指向 5 次的情境
    return { ...BUILTIN_DEFAULT, retryableCodes: [...BUILTIN_DEFAULT.retryableCodes], source: 'disabled' }
  }

  const backoff = {
    initialDelayMs: cfg.initialDelayMs,
    maxDelayMs: cfg.maxDelayMs,
    jitterRatio: cfg.jitterRatio,
    strategy: cfg.strategy,
    multiplier: cfg.multiplier,
    respectRetryAfter: cfg.respectRetryAfter,
  }

  if (cfg.mode === 'always') return { mode: 'always', ...backoff, source: 'config' }
  // 提供方自己写了 always（例如某些适配器要求无限重试）：尊重它，但退避用我们的
  if (providedPolicy !== undefined && providedPolicy !== null && providedPolicy.mode === 'always') {
    return { mode: 'always', ...backoff, source: 'provider-always' }
  }
  return {
    mode: 'normal',
    maxRetries: cfg.maxRetries,
    retryableCodes: [...cfg.retryableCodes],
    ...backoff,
    source: 'config',
  }
}

// ----------------------------------------------------------------- 预算键

/**
 * 稳定标识一份策略：进了这个键的字段一改，预算就重新计数。
 * 含全部影响行为的字段（含 strategy/multiplier），失败码排序保证顺序无关。
 *
 * @param {object} policy 生效策略。
 * @returns {string} JSON 字符串，直接写进会话事件与投影状态键。
 */
function retryPolicyKey(policy) {
  return policy.mode === 'always'
    ? JSON.stringify([
      policy.mode,
      policy.initialDelayMs,
      policy.maxDelayMs,
      policy.jitterRatio,
      policy.strategy,
      policy.multiplier,
    ])
    : JSON.stringify([
      policy.mode,
      policy.maxRetries,
      [...policy.retryableCodes].sort(),
      policy.initialDelayMs,
      policy.maxDelayMs,
      policy.jitterRatio,
      policy.strategy,
      policy.multiplier,
    ])
}

/** 预算按 (provider, 策略) 独立计数（SPEC §9）。 */
function retryStateKey(provider, policyKey) {
  return JSON.stringify([provider, policyKey])
}

// ----------------------------------------------------------------- 事件与投影（SPEC §5.1 / §5.4）

/**
 * 投影状态 schema：`Record<string, { retry: int >= 0, retryId: string }>`。
 *
 * 为什么手写而不是 import zod：lib/*.js 不许 import 任何 `@deepseek-ai/*`（本地 link 解析不到），
 * 而 sessionProjections 只用到 `stateSchema.parse`（冷读/恢复时校验落盘状态）。
 * 这里按 zod 的语义实现：非法抛错、未知键剥掉、返回新对象。
 */
const RETRY_STATE_SCHEMA = Object.freeze({
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('llmRetry 状态必须是对象')
    }
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new TypeError(`llmRetry 状态项 ${key} 必须是对象`)
      }
      if (!Number.isInteger(entry.retry) || entry.retry < 0) {
        throw new TypeError(`llmRetry 状态项 ${key}.retry 必须是非负整数`)
      }
      if (typeof entry.retryId !== 'string') {
        throw new TypeError(`llmRetry 状态项 ${key}.retryId 必须是字符串`)
      }
      out[key] = { retry: entry.retry, retryId: entry.retryId }
    }
    return out
  },
})

/** 投影初值：空预算表（官方一致）。 */
function retryProjectionInit() {
  return {}
}

/**
 * 投影折叠（与官方 @deepseek-ai/dsh-llm-retry 逐字段同构）：
 * step/start、turn/end 清零；非 llm/retry 事件原样放行；llm/retry 写 (provider, policyKey) → 预算，
 * 相同 retry + retryId 时返回原引用（避免无谓的视图失效）。
 *
 * @param {object} state 当前状态。
 * @param {{type: string, data?: object}} event 会话事件。
 * @returns {object} 新状态或原状态。
 */
function retryProjectionApply(state, event) {
  if (RESET_EVENT_TYPES.includes(event.type)) return {}
  if (event.type !== RETRY_EVENT) return state
  const key = retryStateKey(event.data.provider, event.data.policyKey)
  const entry = state[key]
  if (entry !== undefined && entry.retry === event.data.retry && entry.retryId === event.data.retryId) {
    return state
  }
  return { ...state, [key]: { retry: event.data.retry, retryId: event.data.retryId } }
}

export {
  BUILTIN_DEFAULT,
  CODE_OPTIONS,
  CONFIG_KEYS,
  DEFAULTS,
  ENTRY_ID,
  LIMITS,
  MAX_BODY_BYTES,
  OFFICIAL_RETRYABLE_CODES,
  PolicyError,
  REQUEST_ERROR_EVENT,
  RESET_EVENT_TYPES,
  RETRY_EVENT,
  RETRY_PROJECTION_KEY,
  RETRY_PROJECTION_STATE_VERSION,
  RETRY_STARTED_EVENT,
  RETRY_STATE_SCHEMA,
  ROUTE,
  STRATEGIES,
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
}
