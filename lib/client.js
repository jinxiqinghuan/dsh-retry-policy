/**
 * dsh-retry-policy —— 浏览器半边（设置页「模型重试策略」）。
 *
 * 形态（SPEC §7，已按官方客户端样例核实）：
 *   IIFE + `window.__ModuleLoader__.load({ id, factory })`；factory(require) 只 require('react')，
 *   无第三方 UI 库、无打包器。导出 `{ inject, apply }`。
 *
 * 注册（官方依据，见交付报告）：
 *   官方 client-ui-agent-preset 的 lib/client.js:2490-2497
 *     ctx.slots.inject("settings.section", () => ctx.slots.register({
 *       name: "settings.section", id, order, label: () => ctx.locale.bind(NS)("nav"), locale: NS,
 *     }, Section))
 *   同文件 2343 行：`ctx.effect(() => ctx.locale.register("settings.agentPreset", { zh, en }))`
 *   —— 文案在**客户端内联注册**进 locale 服务，不从 locale/*.json 读。
 *   官方 client-ui-settings-plugins 的 lib/client.js:201-212 是同一形态。
 *   本文件不 import 任何 Harness 客户端包（只在注释里记出处）。
 *
 * 数据（SPEC §6）：只走宿主同源 HTTP 路由 `/dsh-retry-policy/policy`
 *   （GET 拉取 / POST 保存 / POST { reset:true } 恢复默认 / POST { dryRun:true } 预览校准）。
 *   客户端不使用 ctx.remote / configForms：宿主半边提供的是普通路由，和 dsh-quadrant 同款做法。
 *
 * 为什么文案「中文硬编码 + 也注册 locale 字典」：
 *   ui-plugin.md 要求可见文案走客户端 locale 服务，而用户是中文用户。所以把中文写成
 *   权威回退表 COPY_ZH，同时以 'settings.retryPolicy' 命名空间注册 zh/en；
 *   `t()` 取不到字典时（locale 服务缺失、注册冲突、未选中语言）自动回落到 COPY_ZH，
 *   页面永远是中文可读的，不会出现 "nav" 这种裸键。
 *
 * 为什么只用 --dsw-alias-* / --dsw-* token：
 *   深色模式必须自动跟随（无主题分支）；opacity/透明度一律用 color-mix(..., transparent)
 *   从 token 派生，不写死任何颜色。
 */
;(() => {
  'use strict'

  const PLUGIN_ID = 'dsh-retry-policy'
  /** 宿主路由（SPEC §6）。 */
  const ROUTE = '/dsh-retry-policy/policy'
  /** 设置页 locale 命名空间（客户端内联注册，SPEC §7 的 <NS>）。 */
  const LOCALE_NS = 'settings.retryPolicy'
  /** settings.section 条目的 id / order（SPEC §7）。 */
  const SECTION_ID = 'dsh-retry-policy'
  const SECTION_ORDER = 60
  /** 预览最多展示多少次（SPEC §3：count = min(effective 上限, 10)；always 取 10）。 */
  const MAX_PREVIEW = 10

  /** 配置字段顺序（SPEC §2）：POST 出去的对象键顺序固定，方便人和 diff 读。 */
  const CONFIG_KEYS = [
    'enabled',
    'mode',
    'maxRetries',
    'strategy',
    'initialDelayMs',
    'maxDelayMs',
    'multiplier',
    'jitterRatio',
    'retryableCodes',
    'respectRetryAfter',
  ]

  /** SPEC §2 默认值（宿主 GET 的 `defaults` 取不到时的本地兜底）。 */
  const DEFAULTS_CLIENT = {
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
  }

  /**
   * 官方内置策略常量（SPEC §3 末条）：`enabled:false` 时本插件不接管，
   * 预览必须按内置常量算，否则会误导用户（显示的是自己那套值，实际走的是 5 次/500ms）。
   */
  const BUILTIN_LOCAL = {
    enabled: false,
    mode: 'normal',
    maxRetries: 5,
    strategy: 'exponential',
    initialDelayMs: 500,
    maxDelayMs: 10000,
    multiplier: 2,
    jitterRatio: 0.1,
    retryableCodes: DEFAULTS_CLIENT.retryableCodes,
    respectRetryAfter: true,
  }

  const DEFAULT_CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']
  const LOCAL_STRATEGY_OPTIONS = [
    { id: 'fixed', label: '固定间隔' },
    { id: 'linear', label: '线性增长' },
    { id: 'exponential', label: '指数退避' },
  ]

  /* ============================================================ 内置中文文案（权威回退表） */

  const COPY_ZH = {
    nav: '模型重试策略',
    title: '模型重试策略',
    subtitle: '模型请求失败后的重试次数与等待时间策略',

    badgeOn: '接管中（当前 {count} 次 / {strategy}）',
    badgeUnlimited: '接管中（无限重试 / {strategy}）',
    badgeOff: '未接管（内置默认 5 次）',
    badgeUnknown: '尚未读到配置',

    enabledTitle: '启用接管',
    enabledDesc: '关闭后本插件不再接管重试，回落为内置默认：最多 5 次、500ms 起、指数退避到 10s。',
    unlimitedTitle: '无限重试',
    unlimitedDesc:
      '对所有提供方强制无限重试。永久性错误（鉴权、配额、参数非法）也会一直重试，成本与延迟由你承担。',

    maxRetriesTitle: '重试次数',
    maxRetriesDesc: '不含首次请求；0 表示不重试，范围 0 ~ 1000。',
    maxRetriesDescUnlimited: '无限重试开启时此值不生效。',

    strategyTitle: '等待策略',
    strategyDesc: '两次尝试之间的等待时间怎么增长。',
    strategyFixed: '固定间隔',
    strategyLinear: '线性增长',
    strategyExponential: '指数退避',

    delayTitle: '初始等待 / 最大等待',
    delayDesc: '第一次重试前等待 {initial}，之后单次等待不超过 {max}。',
    initialDelayLabel: '初始等待（ms）',
    maxDelayLabel: '最大等待（ms）',
    quickLabel: '快捷值',

    multiplierTitle: '增长倍数',
    multiplierDesc: '仅指数退避生效：等待 = 初始等待 × 倍数^(次数-1)。',
    multiplierDescDisabled: '仅指数退避可用。',

    jitterTitle: '抖动比例',
    jitterDesc: '在等待时间上下随机浮动，避免大量请求同时重试；0% 表示不抖动。',

    codesTitle: '参与重试的失败码',
    codesDesc: '只有这些失败码会触发重试；至少要选一个。',

    retryAfterTitle: '优先听提供方 Retry-After',
    retryAfterDesc:
      '提供方给出 Retry-After 且不超过最大等待时按它等待；有限模式下超过上限则放弃本次重试。',

    previewTitle: '实时预览',
    previewStep: '第 {n} 次 {delay}',
    previewTotal: '（共 {count} 次，累计 ~{total}）',
    previewUnlimited: '（无限重试，以下为前 {count} 次）',
    previewNone: '不重试（重试次数为 0）',
    previewCalibrated: '服务端已校准',
    previewLocal: '本地即时预览（与宿主同一公式）',
    sourceConfig: '由本页配置决定',
    sourceProviderAlways: '提供方要求无限重试',
    sourceDisabled: '未接管，走内置默认',

    providersTitle: '提供方自带的默认策略（只读参考）',
    providerLine: '{provider}：{mode}，最多 {count} 次',
    modeNormal: '有限重试',
    modeAlways: '无限重试',
    countNone: '—',

    save: '保存',
    saving: '保存中…',
    reset: '恢复默认',
    resetting: '恢复中…',
    reload: '重新读取',
    reloading: '读取中…',
    dryRun: '预览校验（dryRun）',
    previewing: '校验中…',
    dirtyHint: '有未保存的改动。',
    saved: '已保存并生效。',
    resetDone: '已恢复默认值。',
    dryRunDone: '已按服务端公式校准预览。',

    loadingConfig: '正在读取当前策略…',
    readOnlyNotice:
      '当前只读：宿主 configEditor 服务不可用，或本插件不在可配置条目里。以下显示当前生效值。',
    localInvalid: '配置不合法，未提交。',
    errorNetwork: '无法访问宿主接口（网络错误）。',
    errorHttp: '宿主接口返回 HTTP {status}。',
    errorBadPayload: '宿主接口返回了无法解析的响应。',
    errorUnknown: '发生未知错误。',
    errorNoFetch: '当前浏览器环境没有 fetch，无法访问宿主接口。',
  }

  const COPY_EN = {
    nav: 'Model Retry Policy',
    title: 'Model Retry Policy',
    subtitle: 'Retry budget and wait strategy for failed model requests',

    badgeOn: 'Active ({count} retries / {strategy})',
    badgeUnlimited: 'Active (unlimited / {strategy})',
    badgeOff: 'Not active (built-in default: 5 retries)',
    badgeUnknown: 'No configuration read yet',

    enabledTitle: 'Take over retries',
    enabledDesc:
      'When off, this plugin stops taking over and the built-in default applies: 5 retries, 500ms initial, exponential up to 10s.',
    unlimitedTitle: 'Unlimited retries',
    unlimitedDesc:
      'Forces unlimited retries for every provider. Permanent failures (auth, quota, invalid request) are retried too; cost and latency are yours.',

    maxRetriesTitle: 'Retry count',
    maxRetriesDesc: 'Excludes the first request; 0 means no retry, range 0 ~ 1000.',
    maxRetriesDescUnlimited: 'Ignored while unlimited retries are on.',

    strategyTitle: 'Wait strategy',
    strategyDesc: 'How the wait between two attempts grows.',
    strategyFixed: 'Fixed interval',
    strategyLinear: 'Linear growth',
    strategyExponential: 'Exponential backoff',

    delayTitle: 'Initial / maximum wait',
    delayDesc: 'Wait {initial} before the first retry; no single wait exceeds {max}.',
    initialDelayLabel: 'Initial wait (ms)',
    maxDelayLabel: 'Maximum wait (ms)',
    quickLabel: 'Quick values',

    multiplierTitle: 'Growth multiplier',
    multiplierDesc: 'Exponential only: wait = initial × multiplier^(attempt-1).',
    multiplierDescDisabled: 'Available for exponential backoff only.',

    jitterTitle: 'Jitter ratio',
    jitterDesc: 'Randomizes each wait so retries do not synchronize; 0% means no jitter.',

    codesTitle: 'Retryable failure codes',
    codesDesc: 'Only these codes trigger a retry; keep at least one selected.',

    retryAfterTitle: 'Prefer provider Retry-After',
    retryAfterDesc:
      'Honours Retry-After when it stays within the maximum wait; above the cap a finite policy gives up.',

    previewTitle: 'Live preview',
    previewStep: 'Retry {n}: {delay}',
    previewTotal: ' ({count} retries, ~{total} total)',
    previewUnlimited: ' (unlimited; first {count} shown)',
    previewNone: 'No retry (retry count is 0)',
    previewCalibrated: 'Calibrated by the host',
    previewLocal: 'Local live preview (same formula as the host)',
    sourceConfig: 'Decided by this page',
    sourceProviderAlways: 'The provider requires unlimited retries',
    sourceDisabled: 'Not active; built-in default applies',

    providersTitle: 'Provider defaults (read-only)',
    providerLine: '{provider}: {mode}, up to {count} retries',
    modeNormal: 'finite',
    modeAlways: 'unlimited',
    countNone: '—',

    save: 'Save',
    saving: 'Saving…',
    reset: 'Restore defaults',
    resetting: 'Restoring…',
    reload: 'Reload',
    reloading: 'Reloading…',
    dryRun: 'Validate preview (dryRun)',
    previewing: 'Validating…',
    dirtyHint: 'Unsaved changes.',
    saved: 'Saved and active.',
    resetDone: 'Defaults restored.',
    dryRunDone: 'Preview calibrated with the host formula.',

    loadingConfig: 'Reading the current policy…',
    readOnlyNotice:
      'Read-only: the host configEditor service is unavailable, or this plugin is not a configurable entry. Current effective values are shown.',
    localInvalid: 'The configuration is invalid and was not submitted.',
    errorNetwork: 'Cannot reach the host route (network error).',
    errorHttp: 'The host route answered HTTP {status}.',
    errorBadPayload: 'The host route answered with an unreadable payload.',
    errorUnknown: 'Unknown error.',
    errorNoFetch: 'This browser environment has no fetch, so the host route is unreachable.',
  }

  /* ============================================================ 纯函数（可单测，无 React/DOM 依赖） */

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value)
  }

  function num(value, fallback) {
    return typeof value === 'number' && isFinite(value) ? value : fallback
  }

  function toInt(value, fallback) {
    const n = num(value, NaN)
    if (isFinite(n)) return Math.trunc(n)
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)
      if (isFinite(parsed)) return Math.trunc(parsed)
    }
    return fallback
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max)
  }

  /** `{name}` 占位符替换（与 locale 服务的插值语法保持一致）。 */
  function formatTemplate(template, params) {
    if (typeof template !== 'string') return ''
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
    )
  }

  /**
   * SPEC §3 的等待时间公式（唯一真相）：
   *   fixed: base = initial；linear: base = initial * attempt；
   *   exponential: base = initial * multiplier ** min(attempt-1, 64)
   *   base = min(base, maxDelay)
   *   jittered = base * (1 - jitterRatio + 2 * jitterRatio * rand)   // rand ∈ [0,1)
   *   delay = max(min(round(jittered), maxDelay), 1)
   * rand 注入是为了可测；设置页预览用 0.5（抖动中值 = 不抖动）。
   */
  function delayMsFor(config, attempt, rand) {
    const cfg = isPlainObject(config) ? config : {}
    const strategy =
      cfg.strategy === 'fixed' || cfg.strategy === 'linear' ? cfg.strategy : 'exponential'
    const initial = num(cfg.initialDelayMs, BUILTIN_LOCAL.initialDelayMs)
    const maxDelay = num(cfg.maxDelayMs, BUILTIN_LOCAL.maxDelayMs)
    const multiplier = num(cfg.multiplier, 2)
    const jitter = clamp(num(cfg.jitterRatio, 0), 0, 1)
    const n = Math.max(1, toInt(attempt, 1))

    let base
    if (strategy === 'fixed') base = initial
    else if (strategy === 'linear') base = initial * n
    else base = initial * Math.pow(multiplier, Math.min(n - 1, 64))
    base = Math.min(base, maxDelay)

    const draw = typeof rand === 'function' ? rand : () => 0.5
    const r = clamp(num(draw(), 0.5), 0, 1)
    const jittered = base * (1 - jitter + 2 * jitter * r)
    return Math.max(Math.min(Math.round(jittered), maxDelay), 1)
  }

  /** SPEC §3：previewDelays(config, count, rand = () => 0.5) —— 抖动取中值。 */
  function previewDelays(config, count, rand) {
    const n = Math.max(0, toInt(count, 0))
    const out = []
    for (let attempt = 1; attempt <= n; attempt++) out.push(delayMsFor(config, attempt, rand))
    return out
  }

  /** 预览条数：always 模式取 10；有限模式取 min(maxRetries, 10)（SPEC §3）。 */
  function previewCount(config) {
    if (!isPlainObject(config)) return 0
    if (config.mode === 'always') return MAX_PREVIEW
    return clamp(toInt(config.maxRetries, 0), 0, MAX_PREVIEW)
  }

  /** 毫秒 → 人类可读（1.0s / 500ms / 1.0分）；60s 以内一律用秒，读起来更直观。 */
  function formatDuration(ms) {
    const value = num(ms, 0)
    if (value < 1000) return String(Math.round(value)) + 'ms'
    if (value <= 60000) return (value / 1000).toFixed(1) + 's'
    return (value / 60000).toFixed(1) + '分'
  }

  /**
   * SPEC §7 第 3 项：接管中 / 未接管徽标文案。
   * 冻结契约（Lead 裁决）：`effective.source` 只有 'config' | 'provider-always' | 'disabled' 三种；
   * 未接管判定用 `!config.enabled || effective.source === 'disabled'`（**不是** 'builtin'）。
   * `effective` 只在对应当前草稿时传进来，否则为 null（脏草稿时服务端描述的还是旧配置）。
   */
  function describeBadge(t, config, effective) {
    if (!isPlainObject(config)) return { tone: 'unknown', text: t('badgeUnknown') }
    const cfg = config
    const source = isPlainObject(effective) && typeof effective.source === 'string' ? effective.source : null
    if (cfg.enabled === false || source === 'disabled') return { tone: 'off', text: t('badgeOff') }
    const strategy = strategyLabel(t, cfg.strategy)
    // always 模式下 effective **没有** maxRetries（契约），所以先判 always 再取次数；
    // 有限模式下也用 effective.maxRetries ?? config.maxRetries，绝不让 undefined 出现在界面上。
    if (cfg.mode === 'always' || (isPlainObject(effective) && effective.mode === 'always')) {
      return { tone: 'on', text: t('badgeUnlimited', { strategy }) }
    }
    const count = toInt(isPlainObject(effective) && effective.maxRetries !== undefined ? effective.maxRetries : cfg.maxRetries, toInt(cfg.maxRetries, 0))
    return { tone: 'on', text: t('badgeOn', { count: String(count), strategy }) }
  }

  function strategyLabel(t, id) {
    if (id === 'fixed') return t('strategyFixed')
    if (id === 'linear') return t('strategyLinear')
    return t('strategyExponential')
  }

  /**
   * 预览数据：本地按 SPEC §3 即时算；若服务端给过对应同一份配置的 preview（GET/POST/dryRun），
   * 优先用服务端的（§7 第 9 项「保存/加载后用服务端 preview 校准」）。
   * `serverEffective` 只在它同样对应当前配置时传入：提供方强制 always 时（source='provider-always'）
   * 界面必须显示「无限」，不能只看用户自己选的 mode。
   */
  function computePreview(config, serverPreview, serverEffective) {
    const cfg = isPlainObject(config) ? config : DEFAULTS_CLIENT
    const effective = cfg.enabled === false ? BUILTIN_LOCAL : cfg
    const calibrated = !!(
      isPlainObject(serverPreview) &&
      configEquals(serverPreview.config, cfg) &&
      Array.isArray(serverPreview.delays) &&
      serverPreview.delays.length > 0
    )
    const unlimited =
      effective.mode === 'always' || (calibrated && isPlainObject(serverEffective) && serverEffective.mode === 'always')
    const count = previewCount(effective)
    const local = count > 0 ? previewDelays(effective, count) : []
    const delays = calibrated ? serverPreview.delays.slice() : local
    let totalMs = 0
    for (let i = 0; i < delays.length; i++) totalMs += num(delays[i], 0)
    return {
      delays,
      totalMs,
      count: delays.length,
      unlimited,
      none: !unlimited && count === 0 && delays.length === 0,
      calibrated,
    }
  }

  /** 「第 1 次 1.0s → 第 2 次 2.0s（共 N 次，累计 ~X）」。 */
  function buildPreviewText(t, preview) {
    const p = isPlainObject(preview) ? preview : { delays: [], count: 0 }
    if (!p.delays || p.delays.length === 0) return t('previewNone')
    const steps = p.delays
      .map((delay, i) => t('previewStep', { n: String(i + 1), delay: formatDuration(delay) }))
      .join(' → ')
    const suffix = p.unlimited
      ? t('previewUnlimited', { count: String(p.delays.length) })
      : t('previewTotal', {
          count: String(p.delays.length),
          total: formatDuration(p.totalMs),
        })
    return steps + suffix
  }

  function isIntIn(value, min, max) {
    return typeof value === 'number' && isFinite(value) && Math.trunc(value) === value && value >= min && value <= max
  }

  function isNumIn(value, min, max) {
    return typeof value === 'number' && isFinite(value) && value >= min && value <= max
  }

  /**
   * 客户端镜像 SPEC §2 约束：先本地拦一次，省一次往返、也能即时提示。
   * 服务端仍是权威（它的 `issues` 会覆盖显示）。
   */
  function validateConfig(config) {
    const cfg = isPlainObject(config) ? config : {}
    const issues = []
    const push = (field, message) => issues.push({ field, message })

    if (typeof cfg.enabled !== 'boolean') push('enabled', '必须是布尔值')
    if (cfg.mode !== 'inherit' && cfg.mode !== 'always') push('mode', "必须是 'inherit' 或 'always'")
    if (!isIntIn(cfg.maxRetries, 0, 1000)) push('maxRetries', '必须是 0 ~ 1000 的整数')
    if (cfg.strategy !== 'fixed' && cfg.strategy !== 'linear' && cfg.strategy !== 'exponential') {
      push('strategy', "必须是 'fixed' / 'linear' / 'exponential'")
    }
    if (!isIntIn(cfg.initialDelayMs, 1, 3600000)) push('initialDelayMs', '必须是 1 ~ 3600000 的整数')
    if (!isIntIn(cfg.maxDelayMs, 1, 3600000)) push('maxDelayMs', '必须是 1 ~ 3600000 的整数')
    if (isIntIn(cfg.initialDelayMs, 1, 3600000) && isIntIn(cfg.maxDelayMs, 1, 3600000) && cfg.maxDelayMs < cfg.initialDelayMs) {
      push('maxDelayMs', '必须大于等于初始等待')
    }
    if (!isNumIn(cfg.multiplier, 1, 100)) push('multiplier', '必须是 1 ~ 100 的数')
    if (!isNumIn(cfg.jitterRatio, 0, 1)) push('jitterRatio', '必须是 0 ~ 1 的数')
    if (!Array.isArray(cfg.retryableCodes) || cfg.retryableCodes.length === 0) {
      push('retryableCodes', '至少要选一个失败码')
    } else {
      const seen = {}
      for (let i = 0; i < cfg.retryableCodes.length; i++) {
        const code = cfg.retryableCodes[i]
        if (typeof code !== 'string' || code === '') {
          push('retryableCodes', '失败码必须是非空字符串')
          break
        }
        if (seen[code]) {
          push('retryableCodes', '失败码不能重复：' + code)
          break
        }
        seen[code] = true
      }
    }
    if (typeof cfg.respectRetryAfter !== 'boolean') push('respectRetryAfter', '必须是布尔值')
    return issues
  }

  /** 服务端配置 → 表单草稿：只认已知键，缺的用宿主 `defaults` 或 SPEC §2 默认值补。 */
  function normalizeServerConfig(raw, defaults) {
    const out = {}
    const base = isPlainObject(defaults) ? defaults : {}
    for (const key of CONFIG_KEYS) {
      if (base[key] !== undefined) out[key] = cloneValue(base[key])
      else out[key] = cloneValue(DEFAULTS_CLIENT[key])
    }
    if (isPlainObject(raw)) {
      for (const key of CONFIG_KEYS) if (raw[key] !== undefined) out[key] = cloneValue(raw[key])
    }
    if (!Array.isArray(out.retryableCodes)) out.retryableCodes = DEFAULTS_CLIENT.retryableCodes.slice()
    return out
  }

  function cloneValue(value) {
    return Array.isArray(value) ? value.slice() : value
  }

  /** 严格比较两份配置（含数组顺序），用于「服务端 preview 是否对应当前草稿」。 */
  function configEquals(a, b) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false
    for (const key of CONFIG_KEYS) {
      const left = a[key]
      const right = b[key]
      if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
        for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false
      } else if (left !== right) return false
    }
    return true
  }

  /** POST body：保存用 { config }，恢复默认用 { reset:true }，预览加 dryRun。 */
  function buildRequestBody(config, options) {
    const opts = isPlainObject(options) ? options : {}
    if (opts.reset === true) return { reset: true }
    const body = { config: {} }
    const cfg = isPlainObject(config) ? config : {}
    for (const key of CONFIG_KEYS) body.config[key] = cloneValue(cfg[key])
    if (opts.dryRun === true) body.dryRun = true
    return body
  }

  /** GET/POST 响应里的 effective.preview → 可校准的预览缓存。 */
  function previewFromEffective(effective, config) {
    if (!isPlainObject(effective) || !Array.isArray(effective.preview) || effective.preview.length === 0) {
      return null
    }
    return { config: normalizeServerConfig(config, null), delays: effective.preview.slice() }
  }

  function mergeStrategyOptions(raw) {
    const list = Array.isArray(raw) && raw.length > 0 ? raw : LOCAL_STRATEGY_OPTIONS
    const out = []
    const seen = {}
    for (let i = 0; i < list.length; i++) {
      const item = list[i]
      if (!isPlainObject(item) || typeof item.id !== 'string' || seen[item.id]) continue
      seen[item.id] = true
      out.push({ id: item.id, label: typeof item.label === 'string' && item.label ? item.label : strategyLabel(COPY_ZH, item.id) })
    }
    for (let i = 0; i < LOCAL_STRATEGY_OPTIONS.length; i++) {
      const fallback = LOCAL_STRATEGY_OPTIONS[i]
      if (!seen[fallback.id]) {
        seen[fallback.id] = true
        out.push({ id: fallback.id, label: fallback.label })
      }
    }
    return out
  }

  function mergeCodeOptions(raw, selected) {
    const out = []
    const seen = {}
    const add = (code) => {
      if (typeof code !== 'string' || code === '' || seen[code]) return
      seen[code] = true
      out.push(code)
    }
    if (Array.isArray(raw)) for (let i = 0; i < raw.length; i++) add(raw[i])
    if (out.length === 0) for (let i = 0; i < DEFAULT_CODES.length; i++) add(DEFAULT_CODES[i])
    // 草稿里手动存在的、宿主 codeOptions 里没有的码也要显示出来，不能悄悄丢掉用户的配置。
    if (Array.isArray(selected)) for (let i = 0; i < selected.length; i++) add(selected[i])
    return out
  }

  /* ============================================================ 翻译（locale 服务 + 中文回退） */

  function makeTranslator(locale) {
    let bound = null
    if (locale && typeof locale.bind === 'function') {
      try {
        bound = locale.bind(LOCALE_NS)
      } catch (error) {
        bound = null
      }
    }
    return (key, params) => {
      let text = null
      if (typeof bound === 'function') {
        try {
          text = bound(key, params)
        } catch (error) {
          text = null
        }
      }
      // 官方 translate 在缺键时返回 key 本身 —— 这里换成中文回退表，页面不会出现裸键。
      if (typeof text !== 'string' || text === '' || text === key) text = COPY_ZH[key]
      if (typeof text !== 'string') text = key
      return params ? formatTemplate(text, params) : text
    }
  }

  /* ============================================================ HTTP（宿主路由，SPEC §6） */

  function makeAbortError() {
    const err = new Error('aborted')
    err.aborted = true
    return err
  }

  function networkError(cause) {
    if (cause && cause.aborted) return cause
    const detail = cause && cause.message ? String(cause.message) : COPY_ZH.errorUnknown
    const err = new Error(COPY_ZH.errorNetwork + '（' + detail + '）')
    err.cause = cause
    return err
  }

  function httpError(status, payload) {
    const hasError = isPlainObject(payload) && typeof payload.error === 'string' && payload.error !== ''
    const text = hasError
      ? payload.error
      : formatTemplate(COPY_ZH.errorHttp, { status: String(num(status, 0)) })
    const err = new Error(text)
    err.status = num(status, 0)
    err.issues = isPlainObject(payload) && Array.isArray(payload.issues) ? payload.issues : []
    return err
  }

  /**
   * 一次宿主调用。HTTP 错误状态也要读 body（400 的 `issues`、503 的 `error` 都是页面要显示的），
   * 所以先解析再判 ok，绝不因为状态码就丢掉错误细节。
   */
  async function callHost(body, signal) {
    const doFetch = typeof fetch === 'function' ? fetch : null
    if (!doFetch) throw new Error(COPY_ZH.errorNoFetch)
    const init = {
      method: body ? 'POST' : 'GET',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    }
    if (body) {
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    if (signal) init.signal = signal

    let res
    try {
      res = await doFetch(ROUTE, init)
    } catch (cause) {
      throw networkError(cause)
    }
    let payload = null
    try {
      payload = await res.json()
    } catch (cause) {
      payload = null
    }
    if (!isPlainObject(payload) || payload.ok !== true) {
      throw httpError(res && res.status, payload)
    }
    return payload
  }

  /* ============================================================ 样式（只引用主题 token） */

  const CSS = `
[data-dshrp-page],[data-dshrp-page] *{box-sizing:border-box}
[data-dshrp-page]{display:flex;flex-direction:column;gap:14px;width:100%;max-width:760px;min-width:0;
  color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,inherit);font-size:13px;line-height:1.5}
.dshrp-head{display:flex;flex-direction:column;gap:6px}
.dshrp-title{margin:0;font-size:18px;font-weight:600;line-height:26px}
.dshrp-sub{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.dshrp-badge{align-self:flex-start;display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 10px;
  border-radius:999px;font-size:12px;line-height:20px;
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);color:var(--dsw-alias-label-tertiary)}
.dshrp-badge[data-tone=on]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);
  color:var(--dsw-alias-state-success-primary)}
.dshrp-banner{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:var(--dsw-radius-md);font-size:13px;line-height:20px}
.dshrp-banner[data-kind=error]{border:.5px solid var(--dsw-alias-state-error-primary);
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-label-primary)}
.dshrp-banner[data-kind=notice]{border:.5px solid var(--dsw-alias-border-l2);
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent);color:var(--dsw-alias-label-secondary)}
.dshrp-banner ul{margin:0;padding-left:18px}
.dshrp-rows{display:flex;flex-direction:column;border-top:.5px solid var(--dsw-alias-border-l2)}
.dshrp-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:14px 0;
  border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dshrp-row[data-stack=true]{flex-direction:column;align-items:stretch;gap:10px}
.dshrp-rowtext{display:flex;flex-direction:column;gap:4px;min-width:0}
.dshrp-rowtitle{font-size:14px;line-height:20px}
.dshrp-rowdesc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dshrp-control{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:none}
.dshrp-control[data-grow=true]{flex:1 1 auto;min-width:0}
.dshrp-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshrp-inline-label{color:var(--dsw-alias-label-secondary);font-size:12px}
.dshrp-switch{position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;
  background:var(--dsw-alias-border-l3);cursor:pointer}
.dshrp-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
.dshrp-switch:disabled{cursor:default;opacity:.5}
.dshrp-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dshrp-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);
  transition:transform .12s ease}
.dshrp-switch[aria-checked=false] .dshrp-thumb{background:var(--dsw-alias-switch-thumb)}
.dshrp-switch[aria-checked=true] .dshrp-thumb{transform:translate(16px)}
.dshrp-input{height:32px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}
.dshrp-input:disabled{opacity:.5;cursor:default}
.dshrp-input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dshrp-num{width:112px;text-align:right;font-variant-numeric:tabular-nums}
.dshrp-range{width:160px;accent-color:var(--dsw-alias-brand-primary)}
.dshrp-value{min-width:44px;color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums}
.dshrp-seg{display:inline-flex;overflow:hidden;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.dshrp-segbtn{height:30px;padding:0 12px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:13px;cursor:pointer}
.dshrp-segbtn+.dshrp-segbtn{border-left:.5px solid var(--dsw-alias-border-l2)}
.dshrp-segbtn[data-active=true]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
.dshrp-segbtn:hover:not(:disabled):not([data-active=true]){background:var(--dsw-alias-interactive-bg-hover)}
.dshrp-segbtn:disabled{opacity:.5;cursor:default}
.dshrp-segbtn:focus-visible,.dshrp-btn:focus-visible,.dshrp-chip:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dshrp-chip{height:24px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.dshrp-chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshrp-chip:disabled{opacity:.5;cursor:default}
.dshrp-codes{display:flex;flex-wrap:wrap;gap:8px}
.dshrp-code{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2);
  border-radius:999px;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
.dshrp-code[data-checked=true]{color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}
.dshrp-code:has(input:disabled){opacity:.5;cursor:default}
.dshrp-preview{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);font-size:13px;line-height:20px;font-variant-numeric:tabular-nums}
.dshrp-preview-meta{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshrp-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dshrp-btn{height:32px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);
  background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
.dshrp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshrp-btn:disabled{opacity:.5;cursor:default}
.dshrp-btn[data-variant=primary]{border-color:transparent;background:var(--dsw-alias-button-primary-fill);
  color:var(--dsw-alias-label-primary-foreground)}
.dshrp-btn[data-variant=primary]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dshrp-hint{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshrp-hint[data-kind=ok]{color:var(--dsw-alias-state-success-primary)}
.dshrp-providers{display:flex;flex-direction:column;gap:4px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshrp-providers ul{margin:0;padding-left:18px}
.dshrp-mono{font-family:var(--dsw-font-markdown-code-font-family,monospace)}
@media (max-width:640px){.dshrp-row{flex-direction:column;align-items:stretch;gap:10px}}
@media (prefers-reduced-motion:reduce){.dshrp-thumb{transition:none}}
`

  /* ============================================================ React 组件 */

  function createSection(React) {
    const h = React.createElement

    /** 一行设置：左标题+说明，右控件；stack 用于失败码那种需要整行的内容。 */
    function Row(props) {
      const id = props.field ? 'dshrp-field-' + props.field : undefined
      return h(
        'div',
        { className: 'dshrp-row', 'data-row': props.row, 'data-stack': props.stack ? 'true' : undefined },
        h(
          'div',
          { className: 'dshrp-rowtext' },
          id
            ? h('label', { className: 'dshrp-rowtitle', htmlFor: id }, props.title)
            : h('span', { className: 'dshrp-rowtitle' }, props.title),
          props.desc ? h('span', { className: 'dshrp-rowdesc' }, props.desc) : null,
        ),
        h('div', { className: 'dshrp-control', 'data-grow': props.grow ? 'true' : undefined }, props.children),
      )
    }

    /** 官方开关形态（role=switch + aria-checked + thumb 位移），类名换成自己的前缀。 */
    function Switch(props) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': props.checked ? true : false,
          'aria-label': props.label,
          title: props.title || props.label,
          disabled: !!props.disabled,
          className: 'dshrp-switch',
          'data-role': props.role,
          onClick: () => props.onChange(!props.checked),
        },
        h('span', { className: 'dshrp-thumb' }),
      )
    }

    function NumberInput(props) {
      return h('input', {
        id: props.id,
        className: 'dshrp-input dshrp-num',
        type: 'number',
        inputMode: 'numeric',
        min: props.min,
        max: props.max,
        step: props.step || 1,
        value: props.text,
        disabled: !!props.disabled,
        'data-field': props.field,
        'aria-label': props.label,
        onChange: (event) => props.onChange(event.target.value),
        onBlur: () => props.onBlur(),
      })
    }

    function RetryPolicySection(props) {
      const incoming = props || {}
      const t = typeof incoming.t === 'function' ? incoming.t : makeTranslator(null)

      const alive = React.useRef(true)
      const abortRef = React.useRef(null)
      const [snapshot, setSnapshot] = React.useState({ status: 'loading', data: null })
      const [draft, setDraft] = React.useState(null)
      const [baseline, setBaseline] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [feedback, setFeedback] = React.useState(null)
      const [serverPreview, setServerPreview] = React.useState(null)
      const [issues, setIssues] = React.useState([])
      const [texts, setTexts] = React.useState({})

      const setIfAlive = (fn) => {
        if (alive.current) fn()
      }

      const request = React.useCallback(async (body) => {
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        abortRef.current = controller
        try {
          return await callHost(body, controller ? controller.signal : null)
        } catch (cause) {
          if (controller && controller.signal && controller.signal.aborted) throw makeAbortError()
          throw cause
        }
      }, [])

      const failWith = React.useCallback((cause) => {
        if (!alive.current || (cause && cause.aborted)) return
        setFeedback({
          kind: 'error',
          text: cause && cause.message ? cause.message : COPY_ZH.errorUnknown,
          issues: (cause && Array.isArray(cause.issues) && cause.issues) || [],
        })
      }, [])

      /** 保存/恢复默认/加载成功后的统一落点：草稿、基线、服务端预览、反馈一起更新。 */
      const adoptPayload = React.useCallback((payload, sentConfig, okText) => {
        const next = normalizeServerConfig(payload.config, payload.defaults)
        setDraft(next)
        setBaseline(next)
        setTexts({})
        setIssues([])
        setServerPreview(previewFromEffective(payload.effective, next))
        setSnapshot((prev) => {
          // POST 响应不带 strategyOptions / codeOptions / providerPolicies，必须并上上一份 GET 的；
          // 显式的 undefined/null 也不能把已知值抹掉，否则保存一次后失败码选项就消失了。
          const merged = Object.assign({}, prev.data || {})
          for (const key of Object.keys(payload)) {
            if (payload[key] === undefined || payload[key] === null) continue
            merged[key] = payload[key]
          }
          return { status: 'ready', data: merged }
        })
        setFeedback({ kind: 'ok', text: okText })
      }, [])

      const load = React.useCallback(async () => {
        setBusy('load')
        try {
          const payload = await request(null)
          if (!alive.current) return
          const next = normalizeServerConfig(payload.config, payload.defaults)
          setDraft(next)
          setBaseline(next)
          setTexts({})
          setIssues([])
          setServerPreview(previewFromEffective(payload.effective, next))
          setSnapshot({ status: 'ready', data: payload })
          setFeedback(null)
        } catch (cause) {
          if (!alive.current || (cause && cause.aborted)) return
          setSnapshot((prev) => ({ status: prev.data ? 'ready' : 'error', data: prev.data }))
          failWith(cause)
        } finally {
          if (alive.current) setBusy(null)
        }
      }, [request, failWith])

      React.useEffect(() => {
        alive.current = true
        load()
        return () => {
          // 卸载：置死标志 + abort 在途请求 —— 之后任何 await 回来都不得 setState。
          alive.current = false
          const controller = abortRef.current
          if (controller && typeof controller.abort === 'function') controller.abort()
        }
      }, [load])

      const data = snapshot.data
      const readOnly = !!(data && data.editable === false)
      const disabled = readOnly || busy !== null
      const dirty = !!(draft && baseline && !configEquals(draft, baseline))

      const patch = (partial) => {
        setDraft((prev) => (prev ? Object.assign({}, prev, partial) : prev))
        setIssues([])
      }

      const currentText = (field) =>
        texts[field] !== undefined ? texts[field] : String(draft ? draft[field] : '')

      const onNumberChange = (field, raw) => {
        setTexts((prev) => Object.assign({}, prev, { [field]: raw }))
        if (raw === '' || raw === '-') return
        const parsed = Number(raw)
        if (!isFinite(parsed)) return
        patch({ [field]: parsed })
      }

      const onNumberBlur = (field) => {
        setTexts((prev) => {
          if (prev[field] === undefined) return prev
          const next = Object.assign({}, prev)
          delete next[field]
          return next
        })
      }

      const toggleCode = (code, checked) => {
        if (!draft) return
        const list = Array.isArray(draft.retryableCodes) ? draft.retryableCodes.slice() : []
        const at = list.indexOf(code)
        if (checked && at < 0) list.push(code)
        if (!checked && at >= 0) list.splice(at, 1)
        patch({ retryableCodes: list })
      }

      const submit = async (kind) => {
        if (!draft || disabled) return
        if (kind !== 'dryRun') {
          const found = validateConfig(draft)
          if (found.length > 0) {
            setIssues(found)
            setFeedback({ kind: 'error', text: t('localInvalid'), issues: found })
            return
          }
        }
        setBusy(kind)
        setFeedback(null)
        try {
          if (kind === 'save') {
            const payload = await request(buildRequestBody(draft, null))
            if (!alive.current) return
            adoptPayload(payload, draft, t('saved'))
          } else if (kind === 'reset') {
            const payload = await request(buildRequestBody(null, { reset: true }))
            if (!alive.current) return
            adoptPayload(payload, draft, t('resetDone'))
          } else {
            // dryRun：只拿服务端公式校准预览，**不**改草稿、不落盘（SPEC §6）。
            const payload = await request(buildRequestBody(draft, { dryRun: true }))
            if (!alive.current) return
            if (isPlainObject(payload.effective) && Array.isArray(payload.effective.preview) && payload.effective.preview.length > 0) {
              setServerPreview({ config: normalizeServerConfig(draft, null), delays: payload.effective.preview.slice() })
              setFeedback({ kind: 'ok', text: t('dryRunDone') })
            } else {
              setFeedback({ kind: 'error', text: COPY_ZH.errorBadPayload, issues: [] })
            }
          }
        } catch (cause) {
          failWith(cause)
        } finally {
          if (alive.current) setBusy(null)
        }
      }

      if (snapshot.status === 'loading' && !data) {
        return h(
          'div',
          { className: 'dshrp-head', 'data-dshrp-page': 'true' },
          h('style', { 'data-plugin': PLUGIN_ID, dangerouslySetInnerHTML: { __html: CSS } }),
          h('h2', { className: 'dshrp-title' }, t('title')),
          h('p', { className: 'dshrp-sub', 'data-role': 'loading' }, t('loadingConfig')),
        )
      }

      // 服务端 effective 只有在草稿与基线一致时才描述当前草稿（脏草稿时它描述的还是旧配置）。
      const effectiveIsCurrent = !dirty && isPlainObject(data && data.effective)
      const effective = effectiveIsCurrent ? data.effective : null
      const badge = describeBadge(t, draft, effective)
      const preview = computePreview(draft, serverPreview, effective)
      const strategies = mergeStrategyOptions(data && data.strategyOptions)
      const codes = mergeCodeOptions(data && data.codeOptions, draft && draft.retryableCodes)
      const providers = Array.isArray(data && data.providerPolicies) ? data.providerPolicies : []
      // 「无限重试」开关与次数行的显隐只看**用户自己**的选择；
      // 提供方强制 always 只影响徽标与预览（effective.mode），不该把开关伪装成已打开。
      const unlimitedChoice = !!(draft && draft.mode === 'always')
      const sourceNote = effective
        ? effective.source === 'provider-always'
          ? t('sourceProviderAlways')
          : effective.source === 'disabled'
            ? t('sourceDisabled')
            : t('sourceConfig')
        : null
      const jitterPercent = draft ? Math.round(num(draft.jitterRatio, 0) * 100) : 0
      const delayDesc = formatTemplate(t('delayDesc'), {
        initial: formatDuration(draft ? draft.initialDelayMs : DEFAULTS_CLIENT.initialDelayMs),
        max: formatDuration(draft ? draft.maxDelayMs : DEFAULTS_CLIENT.maxDelayMs),
      })

      const bannerIssues = feedback && feedback.kind === 'error' && feedback.issues.length > 0 ? feedback.issues : issues
      const hint = feedback
        ? feedback.text
        : dirty
          ? t('dirtyHint')
          : null // 只读原因由上方 notice 条说明，这里不重复

      return h(
        'div',
        { 'data-dshrp-page': 'true', className: 'dshrp-page-wrap' },
        h('style', { 'data-plugin': PLUGIN_ID, dangerouslySetInnerHTML: { __html: CSS } }),

        h(
          'div',
          { className: 'dshrp-head' },
          h('h2', { className: 'dshrp-title' }, t('title')),
          h('p', { className: 'dshrp-sub' }, t('subtitle')),
          h('span', { className: 'dshrp-badge', 'data-tone': badge.tone, 'data-role': 'badge' }, badge.text),
        ),

        feedback && feedback.kind === 'error'
          ? h(
              'div',
              { className: 'dshrp-banner', 'data-kind': 'error', 'data-role': 'error-banner', role: 'alert' },
              h('span', null, feedback.text),
              bannerIssues.length > 0
                ? h(
                    'ul',
                    null,
                    bannerIssues.map((issue, index) =>
                      h(
                        'li',
                        { key: String(index), 'data-issue': issue && issue.field ? issue.field : '' },
                        (issue && issue.field ? issue.field + '：' : '') +
                          (issue && issue.message ? issue.message : COPY_ZH.errorUnknown),
                      ),
                    ),
                  )
                : null,
            )
          : null,

        readOnly
          ? h('div', { className: 'dshrp-banner', 'data-kind': 'notice', 'data-role': 'readonly-notice' }, t('readOnlyNotice'))
          : null,

        draft
          ? h(
              'div',
              { className: 'dshrp-rows' },

              h(
                Row,
                { row: 'enabled', title: t('enabledTitle'), desc: t('enabledDesc') },
                h(Switch, {
                  role: 'enabled',
                  checked: !!(draft && draft.enabled),
                  label: t('enabledTitle'),
                  disabled: disabled,
                  onChange: (next) => patch({ enabled: next }),
                }),
              ),

              h(
                Row,
                { row: 'unlimited', title: t('unlimitedTitle'), desc: t('unlimitedDesc') },
                h(Switch, {
                  role: 'unlimited',
                  checked: unlimitedChoice,
                  label: t('unlimitedTitle'),
                  disabled: disabled || !draft || draft.enabled === false,
                  onChange: (next) => patch({ mode: next ? 'always' : 'inherit' }),
                }),
              ),

              unlimitedChoice
                ? null
                : h(
                    Row,
                    {
                      row: 'maxRetries',
                      field: 'maxRetries',
                      title: t('maxRetriesTitle'),
                      desc: t('maxRetriesDesc'),
                    },
                    h(NumberInput, {
                      id: 'dshrp-field-maxRetries',
                      field: 'maxRetries',
                      label: t('maxRetriesTitle'),
                      min: 0,
                      max: 1000,
                      text: currentText('maxRetries'),
                      disabled: disabled || !draft,
                      onChange: (raw) => onNumberChange('maxRetries', raw),
                      onBlur: () => onNumberBlur('maxRetries'),
                    }),
                  ),

              unlimitedChoice
                ? h(Row, { row: 'maxRetriesUnlimited', title: t('maxRetriesTitle'), desc: t('maxRetriesDescUnlimited') }, h('span', { className: 'dshrp-value dshrp-mono' }, '∞'))
                : null,

              h(
                Row,
                { row: 'strategy', title: t('strategyTitle'), desc: t('strategyDesc') },
                h(
                  'div',
                  { className: 'dshrp-seg', role: 'group', 'aria-label': t('strategyTitle') },
                  strategies.map((option) =>
                    h(
                      'button',
                      {
                        key: option.id,
                        type: 'button',
                        className: 'dshrp-segbtn',
                        'data-strategy': option.id,
                        'data-active': draft && draft.strategy === option.id ? 'true' : undefined,
                        'aria-pressed': !!(draft && draft.strategy === option.id),
                        disabled: disabled || !draft,
                        onClick: () => patch({ strategy: option.id }),
                      },
                      option.label,
                    ),
                  ),
                ),
              ),

              h(
                Row,
                { row: 'delay', title: t('delayTitle'), desc: delayDesc, stack: true },
                h(
                  'div',
                  { className: 'dshrp-inline' },
                  h('label', { className: 'dshrp-inline-label', htmlFor: 'dshrp-field-initialDelayMs' }, t('initialDelayLabel')),
                  h(NumberInput, {
                    id: 'dshrp-field-initialDelayMs',
                    field: 'initialDelayMs',
                    label: t('initialDelayLabel'),
                    min: 1,
                    max: 3600000,
                    text: currentText('initialDelayMs'),
                    disabled: disabled || !draft,
                    onChange: (raw) => onNumberChange('initialDelayMs', raw),
                    onBlur: () => onNumberBlur('initialDelayMs'),
                  }),
                  h('span', { className: 'dshrp-inline-label' }, '≤'),
                  h('label', { className: 'dshrp-inline-label', htmlFor: 'dshrp-field-maxDelayMs' }, t('maxDelayLabel')),
                  h(NumberInput, {
                    id: 'dshrp-field-maxDelayMs',
                    field: 'maxDelayMs',
                    label: t('maxDelayLabel'),
                    min: 1,
                    max: 3600000,
                    text: currentText('maxDelayMs'),
                    disabled: disabled || !draft,
                    onChange: (raw) => onNumberChange('maxDelayMs', raw),
                    onBlur: () => onNumberBlur('maxDelayMs'),
                  }),
                  // 初始等待的快捷值（SPEC §7 第 6 项要求 0.5s/1s/2s/5s），和输入框同一行。
                  h('span', { className: 'dshrp-inline-label', 'data-role': 'quick-label' }, t('quickLabel')),
                  [500, 1000, 2000, 5000].map((ms) =>
                    h(
                      'button',
                      {
                        key: String(ms),
                        type: 'button',
                        className: 'dshrp-chip',
                        'data-quick': String(ms),
                        disabled: disabled || !draft,
                        onClick: () => {
                          onNumberBlur('initialDelayMs')
                          patch({ initialDelayMs: ms })
                        },
                      },
                      formatDuration(ms),
                    ),
                  ),
                ),
              ),

              h(
                Row,
                {
                  row: 'multiplier',
                  field: 'multiplier',
                  title: t('multiplierTitle'),
                  desc: draft && draft.strategy === 'exponential' ? t('multiplierDesc') : t('multiplierDescDisabled'),
                },
                h(NumberInput, {
                  id: 'dshrp-field-multiplier',
                  field: 'multiplier',
                  label: t('multiplierTitle'),
                  min: 1,
                  max: 100,
                  step: 0.1,
                  text: currentText('multiplier'),
                  disabled: disabled || !draft || draft.strategy !== 'exponential',
                  onChange: (raw) => onNumberChange('multiplier', raw),
                  onBlur: () => onNumberBlur('multiplier'),
                }),
              ),

              h(
                Row,
                { row: 'jitter', title: t('jitterTitle'), desc: t('jitterDesc') },
                h('input', {
                  id: 'dshrp-field-jitterRatio',
                  className: 'dshrp-range',
                  type: 'range',
                  min: 0,
                  max: 100,
                  step: 1,
                  value: String(jitterPercent),
                  disabled: disabled || !draft,
                  'data-field': 'jitterRatioPercent',
                  'aria-label': t('jitterTitle'),
                  onChange: (event) => patch({ jitterRatio: clamp(Number(event.target.value), 0, 100) / 100 }),
                }),
                h('label', { className: 'dshrp-value', htmlFor: 'dshrp-field-jitterRatio', 'data-role': 'jitter-value' }, jitterPercent + '%'),
              ),

              h(
                Row,
                { row: 'codes', title: t('codesTitle'), desc: t('codesDesc'), stack: true, grow: true },
                h(
                  'div',
                  { className: 'dshrp-codes', 'data-role': 'codes' },
                  codes.map((code) => {
                    const checked = !!(draft && draft.retryableCodes && draft.retryableCodes.indexOf(code) >= 0)
                    return h(
                      'label',
                      { key: code, className: 'dshrp-code', 'data-checked': checked ? 'true' : undefined },
                      h('input', {
                        type: 'checkbox',
                        'data-code': code,
                        checked: checked,
                        disabled: disabled || !draft,
                        onChange: (event) => toggleCode(code, event.target.checked),
                      }),
                      h('span', { className: 'dshrp-mono' }, code),
                    )
                  }),
                ),
              ),

              h(
                Row,
                { row: 'respectRetryAfter', title: t('retryAfterTitle'), desc: t('retryAfterDesc') },
                h(Switch, {
                  role: 'respectRetryAfter',
                  checked: !!(draft && draft.respectRetryAfter),
                  label: t('retryAfterTitle'),
                  disabled: disabled || !draft,
                  onChange: (next) => patch({ respectRetryAfter: next }),
                }),
              ),
            )
          : null,

        draft
          ? h(
              'div',
              { className: 'dshrp-preview', 'data-role': 'preview' },
              h('span', { className: 'dshrp-rowtitle' }, t('previewTitle')),
              h('span', { className: 'dshrp-mono', 'data-role': 'preview-steps' }, buildPreviewText(t, preview)),
              h(
                'span',
                { className: 'dshrp-preview-meta', 'data-role': 'preview-meta' },
                [
                  preview.unlimited
                    ? t('modeAlways') + '（' + strategyLabel(t, draft.strategy) + '）'
                    : strategyLabel(t, draft.strategy) + ' · ' + String(preview.count) + ' 次',
                  preview.calibrated ? t('previewCalibrated') : t('previewLocal'),
                  sourceNote,
                ]
                  .filter(Boolean)
                  .join(' · '),
              ),
            )
          : null,

        providers.length > 0
          ? h(
              'div',
              { className: 'dshrp-providers', 'data-role': 'providers' },
              h('span', null, t('providersTitle')),
              h(
                'ul',
                null,
                providers.map((row, index) =>
                  h(
                    'li',
                    { key: (row && row.provider ? String(row.provider) : 'p') + index },
                    formatTemplate(t('providerLine'), {
                      provider: row && row.provider ? String(row.provider) : COPY_ZH.countNone,
                      mode: row && row.mode === 'always' ? t('modeAlways') : t('modeNormal'),
                      count: row && row.maxRetries !== undefined && row.maxRetries !== null ? String(row.maxRetries) : t('countNone'),
                    }),
                  ),
                ),
              ),
            )
          : null,

        h(
          'div',
          { className: 'dshrp-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dshrp-btn',
              'data-variant': 'primary',
              'data-action': 'save',
              disabled: disabled || !draft,
              onClick: () => submit('save'),
            },
            busy === 'save' ? t('saving') : t('save'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshrp-btn',
              'data-action': 'reset',
              disabled: disabled || !draft,
              onClick: () => submit('reset'),
            },
            busy === 'reset' ? t('resetting') : t('reset'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshrp-btn',
              'data-action': 'reload',
              disabled: disabled,
              onClick: () => load(),
            },
            busy === 'load' ? t('reloading') : t('reload'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshrp-btn',
              'data-action': 'dryRun',
              disabled: disabled || !draft,
              onClick: () => submit('dryRun'),
            },
            busy === 'dryRun' ? t('previewing') : t('dryRun'),
          ),
          hint
            ? h(
                'span',
                {
                  className: 'dshrp-hint',
                  'data-kind': feedback && feedback.kind === 'ok' ? 'ok' : undefined,
                  'data-role': 'hint',
                  role: feedback && feedback.kind === 'ok' ? 'status' : undefined,
                },
                hint,
              )
            : null,
        ),
      )
    }

    return RetryPolicySection
  }

  /* ============================================================ apply（注册设置页） */

  function resolveService(ctx, key) {
    if (!ctx) return null
    const direct = ctx[key]
    if (direct) return direct
    if (typeof ctx.get === 'function') {
      try {
        const found = ctx.get(key)
        if (found) return found
      } catch (error) {
        /* 服务未就绪：保持 null，由调用方回退 */
      }
    }
    return null
  }

  function resolveLocale(ctx) {
    const locale = resolveService(ctx, 'locale')
    return locale && typeof locale.register === 'function' ? locale : null
  }

  function resolveSlots(ctx) {
    const slots = resolveService(ctx, 'slots')
    return slots && typeof slots.inject === 'function' && typeof slots.register === 'function' ? slots : null
  }

  function registerDictionaries(locale) {
    try {
      const dispose = locale.register(LOCALE_NS, { zh: COPY_ZH, en: COPY_EN })
      return typeof dispose === 'function' ? dispose : null
    } catch (error) {
      // 同 ns+locale 重复注册时官方 register 会抛错（例如上一实例尚未卸载）。
      // 文案注册失败绝不能连累页面注册：此时 makeTranslator 自动回退到 COPY_ZH。
      return null
    }
  }

  /**
   * 必需服务：'slots' 是注册面；'locale' 让 apply 在 locale 就绪后才跑
   * （官方 dsh-client-ui-agent-preset 的 inject 同样是 ["slots", ..., "locale", ...]）。
   */
  const inject = ['slots', 'locale']

  window.__ModuleLoader__.load({
    id: PLUGIN_ID,
    factory: (require) => {
      const module = { exports: {} }
      const exports = module.exports

      // 只允许平台种子模块 'react'（无第三方 UI 库、无打包器）。
      const React = require('react')
      const RetryPolicySection = createSection(React)

      /**
       * 注册设置页（官方 dsh-client-ui-agent-preset 同款形态）。
       * 放在 factory 内是为了让组件闭包拿到 React，同时保证 factory 本身无副作用
       * （ui-plugin.md：Keep factories free of side effects）。
       */
      function apply(ctx) {
        if (!ctx) return

        const locale = resolveLocale(ctx)
        if (locale) {
          const dispose = registerDictionaries(locale)
          if (dispose && typeof ctx.effect === 'function') {
            ctx.effect(() => dispose, 'dsh-retry-policy: settings dictionaries')
          }
        }

        const slots = resolveSlots(ctx)
        if (!slots) return
        slots.inject('settings.section', () =>
          slots.register(
            {
              name: 'settings.section',
              id: SECTION_ID,
              order: SECTION_ORDER,
              // label 是 thunk：shell 每次投影都会重新求值（官方 resolveSlotLabel 就是直接调用它），
              // 所以语言切换、locale 晚就绪都能跟上，且返回的永远是中文可读文案。
              label: () => makeTranslator(resolveLocale(ctx))('nav'),
              locale: LOCALE_NS,
            },
            RetryPolicySection,
          ),
        )
      }

      exports.apply = apply
      exports.inject = inject
      exports.RetryPolicySection = RetryPolicySection
      // 供 tests/client.test.mjs 直接测纯函数（公式/校验/请求体/预览文案）。
      exports.__internals = {
        PLUGIN_ID,
        ROUTE,
        LOCALE_NS,
        SECTION_ID,
        SECTION_ORDER,
        MAX_PREVIEW,
        CONFIG_KEYS,
        DEFAULTS_CLIENT,
        BUILTIN_LOCAL,
        DEFAULT_CODES,
        COPY_ZH,
        COPY_EN,
        CSS,
        delayMsFor,
        previewDelays,
        previewCount,
        formatDuration,
        describeBadge,
        strategyLabel,
        computePreview,
        buildPreviewText,
        validateConfig,
        normalizeServerConfig,
        configEquals,
        buildRequestBody,
        previewFromEffective,
        mergeStrategyOptions,
        mergeCodeOptions,
        makeTranslator,
        formatTemplate,
        callHost,
        resolveService,
        resolveLocale,
        resolveSlots,
      }
      return module.exports
    },
  })
})()
