/**
 * dsh-retry-policy —— 客户端半边测试（`node --test tests/`）。
 *
 * 三层：
 *   A. 纯函数层（公式 §3 / 校验 §2 / 请求体 §6 / 预览文案 §7）—— 无 React、无 DOM。
 *   B. 注册与静态约束层 —— 用 ctx stub 断言 settings.section 注册参数与官方样例一致，
 *      并静态扫描 lib/client.js（只 require 'react'、无 Harness 包、CSS 只用主题 token）。
 *   C. 组件行为层（jsdom + react-dom）—— 真挂载页面：GET 拉取、本地即时预览、dryRun 校准、
 *      保存、恢复默认、只读态、失败可见、卸载 abort。
 *
 * 关于 C：本机 /Users/ljt/project/deepseek-harness/node_modules 里已有 jsdom 29 + react 18.3.1
 * （离线，不安装任何东西）；取不到时整段 skip，A/B 仍然全跑。
 * 也可 `npm install`（devDependencies 里有 jsdom / react / react-dom）或设置
 * `DSH_TEST_NODE_MODULES` 指向任意含这三者的 node_modules，让 C 段跑起来。
 * **这不是浏览器验证**：真实渲染仍需在打开的 Harness 页面里确认（verification.md 的口径）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')
const CLIENT = path.join(PKG, 'lib', 'client.js')
const SRC = fs.readFileSync(CLIENT, 'utf8')

/* ------------------------------------------------------------------ 加载 client.js（伪造 __ModuleLoader__） */

function loadClient(React) {
  let captured = null
  const previousWindow = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (config) => { captured = config } } }
  try {
    // 间接 eval：client.js 是普通脚本（IIFE），不是 ESM。
    ;(0, eval)(SRC)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
  assert.ok(captured, '__ModuleLoader__.load 没有被调用')
  const requireCalls = []
  const mod = captured.factory((name) => {
    requireCalls.push(name)
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })
  return { captured, mod, requireCalls }
}

/** 纯函数层用的最小 React stub：createSection 只定义组件，不求值 hooks。 */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useRef: (value) => ({ current: value }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}

const { captured, mod } = loadClient(reactStub)
const I = mod.__internals

/* ================================================================== A. 模块契约 + 静态约束 */

test('A1 bundle 形态：id / factory / exports', () => {
  assert.equal(captured.id, 'dsh-retry-policy')
  assert.equal(typeof captured.factory, 'function')
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof mod.RetryPolicySection, 'function')
  assert.ok(Array.isArray(mod.inject))
})

test('A2 inject 覆盖 slots（并声明 locale，与官方样例一致）', () => {
  assert.ok(mod.inject.includes('slots'), 'inject 必须含 slots')
  assert.ok(mod.inject.includes('locale'), 'inject 应含 locale（官方 agent-preset 同样声明）')
})

test('A3 静态：只 require 平台种子模块 react', () => {
  const args = [...SRC.matchAll(/require\(([^)]*)\)/g)].map((m) => m[1].trim())
  assert.ok(args.length >= 1, '至少应有 require(\'react\')')
  for (const arg of args) assert.equal(arg, "'react'", '禁止 require：' + arg)
  assert.deepEqual(mod.inject, ['slots', 'locale'])
})

test('A4 静态：不引用任何 Harness 客户端包 / 不碰 document.body / 不用 localStorage', () => {
  assert.ok(!/@deepseek-ai\//.test(SRC), '源码里不得出现 Harness 包名')
  assert.ok(!/require\(['"]react-dom/.test(SRC), '不得 require react-dom')
  assert.ok(!/document\.body/.test(SRC), '不得往 document.body 挂东西')
  assert.ok(!/createPortal/.test(SRC), '不得自建浮层')
  assert.ok(!/localStorage/.test(SRC), '数据必须走宿主路由，不得用 localStorage')
  assert.ok(!/querySelector/.test(SRC), '不得读取宿主 DOM')
})

test('A5 静态：CSS 只用 --dsw-* 主题变量，无写死颜色', () => {
  const css = I.CSS
  assert.ok(css.length > 500)
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'CSS 里不得有 #hex 颜色')
  assert.ok(!/\brgba?\(/.test(css), 'CSS 里不得有 rgb()/rgba()')
  assert.ok(!/\bhsla?\(/.test(css), 'CSS 里不得有 hsl()/hsla()')
  assert.ok(!/:\s*(white|black|red|green|blue|gray|grey)\b/.test(css), 'CSS 里不得有命名颜色')
  const vars = [...css.matchAll(/var\((--[a-zA-Z0-9-]+)/g)].map((m) => m[1])
  assert.ok(vars.length > 5, '应当引用主题变量')
  for (const name of vars) assert.ok(name.startsWith('--dsw-'), '非主题变量：' + name)
  assert.ok(/--dsw-alias-label-primary/.test(css), '应引用 --dsw-alias-* 系列')
  assert.ok(/prefers-reduced-motion/.test(css), '应有 reduced-motion 降级')
})

test('A6 静态：开关用 role=switch + aria-checked（宿主控件语义）', () => {
  assert.ok(/role: 'switch'/.test(SRC))
  assert.ok(/'aria-checked'/.test(SRC))
})

/* ================================================================== A. 等待时间公式（SPEC §3） */

const D = I.DEFAULTS_CLIENT // 表单草稿的基准（enabled:true）；内置常量只在 enabled:false 时用
const cfg = (over) => Object.assign({}, D, over)

test('A7 公式：fixed = 恒定 initialDelayMs', () => {
  const config = cfg({ strategy: 'fixed', initialDelayMs: 2000, maxDelayMs: 60000 })
  assert.deepEqual(I.previewDelays(config, 3), [2000, 2000, 2000])
})

test('A8 公式：linear = initialDelayMs × attempt', () => {
  const config = cfg({ strategy: 'linear', initialDelayMs: 1000, maxDelayMs: 60000 })
  assert.deepEqual(I.previewDelays(config, 4), [1000, 2000, 3000, 4000])
})

test('A9 公式：exponential = initialDelayMs × multiplier^(attempt-1)', () => {
  const config = cfg({ strategy: 'exponential', initialDelayMs: 1000, multiplier: 2, maxDelayMs: 60000 })
  assert.deepEqual(I.previewDelays(config, 4), [1000, 2000, 4000, 8000])
})

test('A10 公式：先夹 maxDelayMs，再夹 >= 1ms', () => {
  const big = cfg({ strategy: 'exponential', initialDelayMs: 1000, multiplier: 10, maxDelayMs: 60000 })
  assert.equal(I.delayMsFor(big, 5, () => 0.5), 60000)
  // 溢出（multiplier^63 = Infinity）也必须被 maxDelayMs 夹住
  assert.equal(I.delayMsFor(big, 200, () => 0.5), 60000)
  const tiny = cfg({ strategy: 'fixed', initialDelayMs: 1, maxDelayMs: 10, jitterRatio: 0 })
  assert.equal(I.delayMsFor(tiny, 1, () => 0), 1)
})

test('A11 公式：抖动对称（rand=0 下界 / 0.5 中值 / 1 上界）', () => {
  const config = cfg({ strategy: 'fixed', initialDelayMs: 1000, maxDelayMs: 60000, jitterRatio: 0.5 })
  assert.equal(I.delayMsFor(config, 1, () => 0), 500)
  assert.equal(I.delayMsFor(config, 1, () => 0.5), 1000)
  assert.equal(I.delayMsFor(config, 1, () => 1), 1500)
  // 默认 rand=0.5（预览用中值）
  assert.equal(I.delayMsFor(config, 1), 1000)
})

test('A12 previewCount：有限模式 min(maxRetries,10)，always 取 10，0 次为空', () => {
  assert.equal(I.previewCount(cfg({ mode: 'inherit', maxRetries: 3 })), 3)
  assert.equal(I.previewCount(cfg({ mode: 'inherit', maxRetries: 25 })), 10)
  assert.equal(I.previewCount(cfg({ mode: 'inherit', maxRetries: 0 })), 0)
  assert.equal(I.previewCount(cfg({ mode: 'always', maxRetries: 0 })), 10)
})

test('A13 formatDuration', () => {
  assert.equal(I.formatDuration(500), '500ms')
  assert.equal(I.formatDuration(1000), '1.0s')
  assert.equal(I.formatDuration(60000), '60.0s')
  assert.equal(I.formatDuration(65000), '1.1分')
})

/* ================================================================== A. 校验 / 请求体 / 预览 */

test('A14 validateConfig：默认值合法，非法值逐字段报 issue', () => {
  assert.deepEqual(I.validateConfig(I.DEFAULTS_CLIENT), [])
  assert.equal(I.validateConfig(cfg({ maxRetries: 1001 }))[0].field, 'maxRetries')
  assert.equal(I.validateConfig(cfg({ initialDelayMs: 0 }))[0].field, 'initialDelayMs')
  assert.equal(I.validateConfig(cfg({ initialDelayMs: 5000, maxDelayMs: 3000 }))[0].field, 'maxDelayMs')
  assert.equal(I.validateConfig(cfg({ strategy: 'bogus' }))[0].field, 'strategy')
  assert.equal(I.validateConfig(cfg({ multiplier: 0 }))[0].field, 'multiplier')
  assert.equal(I.validateConfig(cfg({ jitterRatio: 1.5 }))[0].field, 'jitterRatio')
  assert.equal(I.validateConfig(cfg({ retryableCodes: [] }))[0].field, 'retryableCodes')
  assert.equal(I.validateConfig(cfg({ retryableCodes: ['SERVER', 'SERVER'] }))[0].field, 'retryableCodes')
  assert.equal(I.validateConfig(cfg({ retryableCodes: [''] }))[0].field, 'retryableCodes')
  assert.equal(I.validateConfig(cfg({ enabled: 'yes' }))[0].field, 'enabled')
})

test('A15 buildRequestBody：键顺序固定，未知键丢弃，dryRun/reset 形态正确', () => {
  const body = I.buildRequestBody(Object.assign({}, I.DEFAULTS_CLIENT, { evil: 1 }), null)
  assert.deepEqual(Object.keys(body), ['config'])
  assert.deepEqual(Object.keys(body.config), I.CONFIG_KEYS)
  assert.equal(body.config.evil, undefined)
  assert.equal(body.dryRun, undefined)
  assert.deepEqual(I.buildRequestBody(I.DEFAULTS_CLIENT, { dryRun: true }).dryRun, true)
  assert.deepEqual(I.buildRequestBody(I.DEFAULTS_CLIENT, { reset: true }), { reset: true })
})

test('A16 normalizeServerConfig：缺键用 defaults 补，未知键丢弃，数组是副本', () => {
  const out = I.normalizeServerConfig(
    { maxRetries: 3, strategy: 'fixed', junk: true },
    { initialDelayMs: 900, retryableCodes: ['SERVER'] },
  )
  assert.equal(out.maxRetries, 3)
  assert.equal(out.strategy, 'fixed')
  assert.equal(out.initialDelayMs, 900)
  assert.equal(out.junk, undefined)
  assert.deepEqual(out.retryableCodes, ['SERVER'])
  out.retryableCodes.push('X')
  assert.deepEqual(I.DEFAULTS_CLIENT.retryableCodes.length, 5, '不得污染默认值常量')
  assert.deepEqual(Object.keys(out), I.CONFIG_KEYS)
})

test('A17 configEquals 严格比较（含数组顺序）', () => {
  assert.equal(I.configEquals(I.DEFAULTS_CLIENT, Object.assign({}, I.DEFAULTS_CLIENT)), true)
  assert.equal(I.configEquals(I.DEFAULTS_CLIENT, cfg({ maxRetries: 11 })), false)
  assert.equal(I.configEquals(cfg({ retryableCodes: ['A', 'B'] }), cfg({ retryableCodes: ['B', 'A'] })), false)
})

test('A18 computePreview：未接管时按内置常量算（5 次 / 500ms / 指数）', () => {
  const preview = I.computePreview(cfg({ enabled: false }), null)
  assert.deepEqual(preview.delays, [500, 1000, 2000, 4000, 8000])
  assert.equal(preview.unlimited, false)
  assert.equal(preview.none, false)
})

test('A19 computePreview：服务端 preview 只在配置一致时校准', () => {
  const config = cfg({ maxRetries: 3 })
  const server = { config: cfg({ maxRetries: 3 }), delays: [7, 8, 9] }
  const calibrated = I.computePreview(config, server)
  assert.equal(calibrated.calibrated, true)
  assert.deepEqual(calibrated.delays, [7, 8, 9])
  const stale = I.computePreview(cfg({ maxRetries: 4 }), server)
  assert.equal(stale.calibrated, false)
  assert.deepEqual(stale.delays, [1000, 2000, 4000, 8000])
})

test('A20 buildPreviewText：第 N 次 / 共 N 次 / 累计 / 无限 / 不重试', () => {
  const t = I.makeTranslator(null)
  const text = I.buildPreviewText(t, I.computePreview(cfg({ maxRetries: 3 }), null))
  assert.match(text, /第 1 次 1\.0s → 第 2 次 2\.0s → 第 3 次 4\.0s/)
  assert.match(text, /（共 3 次，累计 ~7\.0s）/)
  const unlimited = I.buildPreviewText(t, I.computePreview(cfg({ mode: 'always' }), null))
  assert.match(unlimited, /无限重试，以下为前 10 次/)
  assert.equal(I.buildPreviewText(t, I.computePreview(cfg({ maxRetries: 0 }), null)), '不重试（重试次数为 0）')
})

test('A21 describeBadge：接管中 / 无限 / 未接管', () => {
  const t = I.makeTranslator(null)
  assert.equal(I.describeBadge(t, cfg({ maxRetries: 10, strategy: 'exponential' })).text, '接管中（当前 10 次 / 指数退避）')
  assert.equal(I.describeBadge(t, cfg({ mode: 'always' })).text, '接管中（无限重试 / 指数退避）')
  assert.equal(I.describeBadge(t, cfg({ enabled: false })).text, '未接管（内置默认 5 次）')
  assert.equal(I.describeBadge(t, cfg({ enabled: false })).tone, 'off')
  // 还没读到配置时不得假装「接管中」
  assert.equal(I.describeBadge(t, null).tone, 'unknown')
  assert.equal(I.describeBadge(t, null).text, '尚未读到配置')
})

test('A22 makeTranslator：locale 命中走字典，缺键/缺服务回落到中文', () => {
  const zh = I.makeTranslator(null)
  assert.equal(zh('save'), '保存')
  assert.equal(zh('previewStep', { n: '2', delay: '4.0s' }), '第 2 次 4.0s')

  const fakeLocale = {
    register: () => () => {},
    bind: () => (key, params) => (key === 'save' ? 'Save!' : key), // 官方缺键时返回 key 本身
  }
  const en = I.makeTranslator(fakeLocale)
  assert.equal(en('save'), 'Save!')
  assert.equal(en('reset'), '恢复默认', '缺键必须回落到中文，而不是裸键')
})

test('A23 mergeStrategyOptions / mergeCodeOptions：补齐本地三档与宿主码', () => {
  const strategies = I.mergeStrategyOptions([{ id: 'fixed', label: '固定' }])
  assert.deepEqual(strategies.map((s) => s.id), ['fixed', 'linear', 'exponential'])
  assert.equal(strategies[0].label, '固定')
  assert.deepEqual(I.mergeStrategyOptions(null).map((s) => s.label), ['固定间隔', '线性增长', '指数退避'])
  assert.deepEqual(I.mergeCodeOptions(['A', 'A', 'B'], ['LOCAL_ONLY']), ['A', 'B', 'LOCAL_ONLY'])
  assert.deepEqual(I.mergeCodeOptions(null, null), I.DEFAULT_CODES)
})

test('A24 callHost：GET/POST 形态、错误状态带 issues、网络错误包装', async () => {
  const seen = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = (url, init) => {
    seen.push({ url, init })
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, editable: true }),
    })
  }
  try {
    const payload = await I.callHost(null, null)
    assert.equal(payload.ok, true)
    assert.equal(seen[0].url, '/dsh-retry-policy/policy')
    assert.equal(seen[0].init.method, 'GET')
    assert.equal(seen[0].init.cache, 'no-store')
    assert.equal(seen[0].init.credentials, 'same-origin')
    assert.equal(seen[0].init.headers.accept, 'application/json')
    assert.equal(seen[0].init.headers['content-type'], undefined)

    await I.callHost({ config: { maxRetries: 1 } }, 'SIGNAL')
    assert.equal(seen[1].init.method, 'POST')
    assert.equal(seen[1].init.headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(seen[1].init.body), { config: { maxRetries: 1 } })
    assert.equal(seen[1].init.signal, 'SIGNAL')
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('A25 callHost：400 带 issues / 503 / 坏 body / 网络失败都抛可显示的错误', async () => {
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = () =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ ok: false, error: '配置不合法', issues: [{ field: 'maxRetries', message: '太大' }] }),
      })
    await assert.rejects(
      () => I.callHost({ config: {} }, null),
      (err) => {
        assert.equal(err.status, 400)
        assert.equal(err.message, '配置不合法')
        assert.deepEqual(err.issues, [{ field: 'maxRetries', message: '太大' }])
        return true
      },
    )

    globalThis.fetch = () => Promise.resolve({ ok: false, status: 503, json: () => Promise.reject(new Error('no body')) })
    await assert.rejects(
      () => I.callHost(null, null),
      (err) => {
        assert.equal(err.status, 503)
        assert.match(err.message, /HTTP 503/)
        return true
      },
    )

    globalThis.fetch = () => Promise.reject(new Error('boom'))
    await assert.rejects(
      () => I.callHost(null, null),
      (err) => {
        assert.match(err.message, /网络错误/)
        return true
      },
    )
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('A26 describeBadge 对齐冻结契约：source=disabled / provider-always / 无 maxRetries', () => {
  const t = I.makeTranslator(null)
  // 未接管也可以由 effective.source==='disabled' 判定（不只靠 config.enabled）
  assert.equal(I.describeBadge(t, cfg({ enabled: true }), { source: 'disabled', mode: 'normal' }).tone, 'off')
  assert.equal(I.describeBadge(t, cfg({ enabled: true }), { source: 'disabled', mode: 'normal' }).text, '未接管（内置默认 5 次）')
  // 提供方强制无限（config.mode 仍是 inherit，且 always 模式下 effective 没有 maxRetries）
  const badge = I.describeBadge(t, cfg({ mode: 'inherit' }), { source: 'provider-always', mode: 'always' })
  assert.equal(badge.text, '接管中（无限重试 / 指数退避）')
  assert.ok(!/undefined/.test(badge.text))
  // 有限模式：effective.maxRetries 缺省时回落到 config.maxRetries，不得渲染 undefined
  const finite = I.describeBadge(t, cfg({ maxRetries: 4 }), { source: 'config', mode: 'normal' })
  assert.equal(finite.text, '接管中（当前 4 次 / 指数退避）')
  assert.ok(!/undefined/.test(finite.text))
})

test('A27 computePreview：提供方强制 always 时显示无限，并用服务端 10 条 preview', () => {
  const config = cfg({ mode: 'inherit', maxRetries: 3 })
  const delays = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000]
  const preview = I.computePreview(config, { config: cfg({ mode: 'inherit', maxRetries: 3 }), delays }, { mode: 'always', source: 'provider-always' })
  assert.equal(preview.unlimited, true)
  assert.equal(preview.calibrated, true)
  assert.deepEqual(preview.delays, delays)
  // 脏草稿（服务端 effective 描述的是旧配置）时不采纳
  const stale = I.computePreview(cfg({ mode: 'inherit', maxRetries: 5 }), { config, delays }, { mode: 'always' })
  assert.equal(stale.unlimited, false)
  assert.equal(stale.calibrated, false)
  assert.deepEqual(stale.delays, [1000, 2000, 4000, 8000, 16000])
})

/* ================================================================== B. 注册参数 + apply 健壮性 */

function makeCtx(overrides) {
  const state = { registered: [], effects: [], dicts: [], label: null, injected: [] }
  const ctx = {
    slots: {
      inject(name, callback) {
        state.injected.push(name)
        callback()
      },
      register(options, Component) {
        state.registered.push({ options, Component })
        return () => {}
      },
    },
    locale: {
      register(ns, dicts) {
        state.dicts.push({ ns, dicts })
        return () => {
          state.disposed = true
        }
      },
      bind: () => (key) => I.COPY_ZH[key] || key,
    },
    effect(fn) {
      const dispose = fn()
      state.effects.push(dispose)
      return dispose
    },
  }
  Object.assign(ctx, overrides || {})
  return { ctx, state }
}

test('B1 注册参数与官方 settings.section 样例一致，label() 返回中文', () => {
  const { ctx, state } = makeCtx()
  mod.apply(ctx)

  assert.deepEqual(state.injected, ['settings.section'])
  assert.equal(state.registered.length, 1)
  const options = state.registered[0].options
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'dsh-retry-policy')
  assert.equal(options.order, 60)
  assert.equal(options.locale, 'settings.retryPolicy')
  assert.equal(typeof options.label, 'function')
  assert.equal(options.label(), '模型重试策略')
  assert.equal(state.registered[0].Component, mod.RetryPolicySection)

  // 文案字典内联注册（官方 agent-preset 2343 行同款）+ 由 ctx.effect 持有 disposer
  assert.equal(state.dicts.length, 1)
  assert.equal(state.dicts[0].ns, 'settings.retryPolicy')
  assert.ok(state.dicts[0].dicts.zh.nav === '模型重试策略')
  assert.ok(state.dicts[0].dicts.en.nav)
  assert.equal(typeof state.effects[0], 'function')
  state.effects[0]()
  assert.equal(state.disposed, true, '卸载时必须调用 locale disposer')
})

test('B2 locale 完全缺失时 apply 不抛错，label 仍返回中文', () => {
  const { ctx, state } = makeCtx({ locale: undefined })
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.equal(state.registered.length, 1)
  assert.equal(state.registered[0].options.label(), '模型重试策略')
})

test('B3 locale.register 抛错（重复注册）时页面注册不受影响', () => {
  const { ctx, state } = makeCtx()
  ctx.locale.register = () => {
    throw new Error('locale namespace "settings.retryPolicy" already has locale "zh"')
  }
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.equal(state.registered.length, 1)
  assert.equal(state.registered[0].options.label(), '模型重试策略')
})

test('B4 只有 ctx.get 能拿到服务时也能注册（惰性服务解析）', () => {
  const { ctx, state } = makeCtx()
  const services = { slots: ctx.slots, locale: ctx.locale }
  delete ctx.slots
  delete ctx.locale
  ctx.get = (key) => services[key]
  mod.apply(ctx)
  assert.equal(state.registered.length, 1)
  assert.equal(state.dicts.length, 1)
})

test('B5 没有 slots 服务时不抛错（插件保持不激活而不是崩掉）', () => {
  assert.doesNotThrow(() => mod.apply({}))
  assert.doesNotThrow(() => mod.apply(null))
})

/* ================================================================== C. 组件行为（jsdom，可选） */

const NM_CANDIDATES = [
  process.env.DSH_TEST_NODE_MODULES,
  path.join(PKG, 'node_modules'),
  '/Users/ljt/project/deepseek-harness/node_modules',
].filter((entry) => typeof entry === 'string' && entry !== '')

/** 优先本地 node_modules（`npm install` 装好 devDependencies 后即可跑），再退回开发机上的检出。 */
const NM = NM_CANDIDATES.find((dir) => {
  try {
    if (!fs.existsSync(path.join(dir, 'jsdom'))) return false
    return fs.existsSync(path.join(dir, 'react')) || fs.existsSync(path.join(dir, '.pnpm'))
  } catch {
    return false
  }
}) || NM_CANDIDATES[0]
const PNPM = NM + '/.pnpm'

/** 依次尝试候选 spec，兼容 npm 布局（node_modules/react）与 pnpm 布局（.pnpm/react@x/…）。 */
function requireFirst(req, specs) {
  let lastError
  for (const spec of specs) {
    try {
      return req(spec)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

let dom = null
let React = null
let ReactDOMAct = null
let createRoot = null
let domSkip = ''

try {
  const req = createRequire(NM + '/')
  const { JSDOM } = req('jsdom')
  dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://127.0.0.1:62484/' })
  const { window } = dom
  globalThis.window = window
  globalThis.document = window.document
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // react-dom 在模块求值时就计算 canUseDOM —— 必须先装好 window/document 再 require（dsh-quadrant 同款经验）。
  React = requireFirst(req, [
    'react',
    path.join(NM, 'react'),
    PNPM + '/react@18.3.1/node_modules/react',
  ])
  ReactDOMAct = React.act
  createRoot = requireFirst(req, [
    'react-dom/client',
    path.join(NM, 'react-dom', 'client.js'),
    PNPM + '/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/client.js',
  ]).createRoot
} catch (error) {
  domSkip = 'jsdom/react-dom 不可用（离线环境未提供），跳过 DOM 行为测试：' + (error && error.message)
}

const DOM = { skip: domSkip || false }

/** 独立按 SPEC §3 手算的宿主 preview（不复用被测代码），用于校准断言。 */
const HOST_DEFAULT_CONFIG = {
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
const HOST_DEFAULT_PREVIEW = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000]

function hostPayload(config, over) {
  const cfg = Object.assign({}, HOST_DEFAULT_CONFIG, config || {})
  const preview = []
  const count = cfg.mode === 'always' ? 10 : Math.min(cfg.maxRetries, 10)
  for (let attempt = 1; attempt <= count; attempt++) {
    let base
    if (cfg.strategy === 'fixed') base = cfg.initialDelayMs
    else if (cfg.strategy === 'linear') base = cfg.initialDelayMs * attempt
    else base = cfg.initialDelayMs * Math.pow(cfg.multiplier, Math.min(attempt - 1, 64))
    base = Math.min(base, cfg.maxDelayMs)
    preview.push(Math.max(Math.min(Math.round(base), cfg.maxDelayMs), 1))
  }
  return Object.assign(
    {
      ok: true,
      entryId: 'dsh-retry-policy',
      editable: true,
      config: cfg,
      defaults: HOST_DEFAULT_CONFIG,
      effective: {
        mode: cfg.mode === 'always' ? 'always' : 'normal',
        maxRetries: cfg.maxRetries,
        strategy: cfg.strategy,
        initialDelayMs: cfg.initialDelayMs,
        maxDelayMs: cfg.maxDelayMs,
        jitterRatio: cfg.jitterRatio,
        source: cfg.enabled ? 'config' : 'builtin',
        preview,
      },
      providerPolicies: [{ provider: 'loomy', mode: 'normal', maxRetries: 5 }],
      strategyOptions: [
        { id: 'fixed', label: '固定间隔' },
        { id: 'linear', label: '线性增长' },
        { id: 'exponential', label: '指数退避' },
      ],
      codeOptions: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'AUTH'],
    },
    over || {},
  )
}

/** 造一个「可断言」的宿主：记录请求，GET/POST 行为可编程。 */
function makeHost(options) {
  const opts = options || {}
  const requests = []
  const host = {
    requests,
    payload: opts.payload || hostPayload(null),
    postHandler: opts.postHandler || null, // (body) => { status, payload } | null(成功)
    mode: 'ok', // ok | network | abortable
    deferred: null,
    window: dom ? dom.window : null,
  }
  const fetchImpl = (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null
    requests.push({
      url: String(url),
      method: (init && init.method) || 'GET',
      body,
      cache: init && init.cache,
      credentials: init && init.credentials,
      headers: (init && init.headers) || {},
      signal: init && init.signal,
    })
    if (host.mode === 'network') return Promise.reject(new Error('connection refused'))
    if (host.mode === 'abortable') {
      return new Promise((resolve) => {
        host.deferred = { resolve: () => resolve({ ok: true, status: 200, json: () => Promise.resolve(host.payload) }) }
      })
    }
    if (body && host.postHandler) {
      const outcome = host.postHandler(body, host)
      if (outcome) {
        return Promise.resolve({ ok: outcome.status >= 200 && outcome.status < 300, status: outcome.status, json: () => Promise.resolve(outcome.payload) })
      }
    }
    if (body) {
      const merged = hostPayload(body.reset ? null : body.config)
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            Object.assign({}, merged, {
              saved: body.dryRun ? false : true, // 真实契约：dryRun 成功 saved:false
              config: body.reset ? HOST_DEFAULT_CONFIG : body.config,
              effective: Object.assign({}, merged.effective, {
                preview: body.dryRun ? [111, 222, 333] : merged.effective.preview,
              }),
              strategyOptions: undefined,
              codeOptions: undefined,
              providerPolicies: undefined,
            }),
          ),
      })
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(host.payload) })
  }
  dom.window.fetch = fetchImpl
  globalThis.fetch = fetchImpl
  return host
}

async function mountSection(host, props) {
  const { mod: fresh } = loadClient(React)
  const Comp = fresh.RetryPolicySection
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  await ReactDOMAct(async () => {
    root.render(React.createElement(Comp, props || {}))
  })
  await flush()
  return {
    container,
    root,
    mod: fresh,
    unmount: async () => {
      await ReactDOMAct(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

async function flush() {
  await ReactDOMAct(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function text(container) {
  return container.textContent || ''
}

test('C1 挂载即 GET 拉取，10 项内容齐全，徽标与 preview 与宿主一致', DOM, async () => {
  const host = makeHost({})
  const view = await mountSection(host)
  try {
    assert.equal(host.requests.length, 1)
    assert.equal(host.requests[0].method, 'GET')
    assert.equal(host.requests[0].url, '/dsh-retry-policy/policy')

    const body = text(view.container)
    for (const label of [
      '模型重试策略', // 标题
      '接管中（当前 10 次 / 指数退避）', // ① 状态徽标
      '启用接管', // ②
      '无限重试', // ③
      '重试次数', // ④
      '固定间隔',
      '线性增长',
      '指数退避', // ⑤
      '初始等待（ms）',
      '最大等待（ms）',
      '增长倍数',
      '抖动比例', // ⑥
      '快捷值', // ⑥ 初始等待的 0.5s/1s/2s/5s 快捷值
      '500ms',
      '5.0s',
      '参与重试的失败码', // ⑦
      '优先听提供方 Retry-After', // ⑧
      '实时预览', // ⑨
      '保存',
      '恢复默认',
      '重新读取', // ⑩
      '预览校验（dryRun）',
      'AUTH',
      'loomy：有限重试，最多 5 次',
    ]) {
      assert.ok(body.includes(label), '页面缺少内容：' + label)
    }

    const steps = view.container.querySelector('[data-role="preview-steps"]').textContent
    assert.match(steps, /第 1 次 1\.0s → 第 2 次 2\.0s/)
    assert.match(steps, /（共 10 次，累计 ~/)
    for (const ms of HOST_DEFAULT_PREVIEW) {
      assert.ok(steps.includes(I.formatDuration(ms)), 'preview 缺少 ' + ms)
    }
    assert.match(view.container.querySelector('[data-role="preview-meta"]').textContent, /服务端已校准/)
    assert.equal(view.container.querySelector('[data-role="badge"]').dataset.tone, 'on')
    assert.match(view.container.querySelector('[data-role="preview-meta"]').textContent, /由本页配置决定/)
    // 开关语义
    const toggle = view.container.querySelector('[data-role="enabled"]')
    assert.equal(toggle.getAttribute('role'), 'switch')
    assert.equal(toggle.getAttribute('aria-checked'), 'true')
  } finally {
    await view.unmount()
  }
})

test('C2 编辑即本地即时预览（不发 POST），保存后改用服务端 preview', DOM, async () => {
  const host = makeHost({})
  const view = await mountSection(host)
  try {
    const strategyBtn = view.container.querySelector('[data-strategy="fixed"]')
    await ReactDOMAct(async () => {
      strategyBtn.click()
    })
    assert.equal(host.requests.filter((r) => r.method === 'POST').length, 0, '编辑不得触发写请求')
    assert.match(text(view.container), /第 1 次 1\.0s → 第 2 次 1\.0s/)
    assert.match(view.container.querySelector('[data-role="preview-meta"]').textContent, /本地即时预览/)

    // 改次数：input 需要走原生 setter 才能触发 React onChange
    const input = view.container.querySelector('[data-field="maxRetries"]')
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    await ReactDOMAct(async () => {
      setValue.call(input, '3')
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    assert.match(text(view.container), /（共 3 次，累计 ~3\.0s）/)

    await ReactDOMAct(async () => {
      view.container.querySelector('[data-action="save"]').click()
    })
    await flush()
    const posts = host.requests.filter((r) => r.method === 'POST')
    assert.equal(posts.length, 1)
    assert.equal(posts[0].body.dryRun, undefined, '保存不得带 dryRun')
    assert.equal(posts[0].body.reset, undefined)
    assert.equal(posts[0].body.config.maxRetries, 3)
    assert.equal(posts[0].body.config.strategy, 'fixed')
    assert.match(text(view.container), /已保存并生效。/)
    // POST 响应没有 codeOptions，必须保留 GET 那份（AUTH 仍在）
    assert.ok(text(view.container).includes('AUTH'), '保存后失败码选项不得消失')
  } finally {
    await view.unmount()
  }
})

test('C3 dryRun 预览校验：POST { dryRun:true } 并用服务端 preview 校准', DOM, async () => {
  const host = makeHost({})
  const view = await mountSection(host)
  try {
    await ReactDOMAct(async () => {
      view.container.querySelector('[data-action="dryRun"]').click()
    })
    await flush()
    const posts = host.requests.filter((r) => r.method === 'POST')
    assert.equal(posts.length, 1)
    assert.equal(posts[0].body.dryRun, true)
    assert.equal(typeof posts[0].body.config, 'object')
    const steps = view.container.querySelector('[data-role="preview-steps"]').textContent
    assert.match(steps, /第 1 次 111ms → 第 2 次 222ms → 第 3 次 333ms/)
    assert.match(text(view.container), /已按服务端公式校准预览。/)
    assert.ok(!text(view.container).includes('已保存并生效。'), 'dryRun 不得被显示成已保存')
    assert.match(view.container.querySelector('[data-role="preview-meta"]').textContent, /服务端已校准/)
  } finally {
    await view.unmount()
  }
})

test('C4 恢复默认：POST { reset:true } 并回到默认值', DOM, async () => {
  const host = makeHost({})
  const view = await mountSection(host)
  try {
    await ReactDOMAct(async () => {
      view.container.querySelector('[data-action="reset"]').click()
    })
    await flush()
    const posts = host.requests.filter((r) => r.method === 'POST')
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0].body, { reset: true })
    assert.match(text(view.container), /已恢复默认值。/)
  } finally {
    await view.unmount()
  }
})

test('C5 400 + issues：错误条显示 issue 文本，且不落盘', DOM, async () => {
  const host = makeHost({
    postHandler: (body) =>
      body.config
        ? { status: 400, payload: { ok: false, error: '配置不合法', issues: [{ field: 'maxRetries', message: '必须是 0 ~ 1000 的整数' }] } }
        : null,
  })
  const view = await mountSection(host)
  try {
    await ReactDOMAct(async () => {
      view.container.querySelector('[data-action="save"]').click()
    })
    await flush()
    const banner = view.container.querySelector('[data-role="error-banner"]')
    assert.ok(banner, '网络/接口失败必须可见')
    assert.match(banner.textContent, /配置不合法/)
    assert.match(banner.textContent, /maxRetries：必须是 0 ~ 1000 的整数/)
    assert.ok(view.container.querySelector('[data-action="save"]'), '失败后页面仍然可操作')
  } finally {
    await view.unmount()
  }
})

test('C6 只读态 editable:false：输入与按钮全部禁用 + 提示原因', DOM, async () => {
  const host = makeHost({ payload: hostPayload(null, { editable: false }) })
  const view = await mountSection(host)
  try {
    assert.match(text(view.container), /当前只读/)
    for (const el of view.container.querySelectorAll('input, button')) {
      assert.equal(el.disabled, true, '只读态必须禁用：' + (el.dataset.action || el.dataset.field || el.dataset.role))
    }
    assert.equal(view.container.querySelectorAll('input, button').length > 8, true)
  } finally {
    await view.unmount()
  }
})

test('C7 网络失败可见，重新读取可恢复', DOM, async () => {
  const host = makeHost({})
  host.mode = 'network'
  const view = await mountSection(host)
  try {
    const banner = view.container.querySelector('[data-role="error-banner"]')
    assert.ok(banner, '网络失败必须显示错误条')
    assert.match(banner.textContent, /网络错误/)
    assert.match(banner.textContent, /connection refused/)
    // 没有配置时：徽标不冒充「接管中」，也不渲染预览/输入
    assert.equal(view.container.querySelector('[data-role="badge"]').dataset.tone, 'unknown')
    assert.equal(view.container.querySelector('[data-role="preview"]'), null)
    assert.equal(view.container.querySelector('[data-action="save"]').disabled, true)
    assert.equal(view.container.querySelector('[data-action="reload"]').disabled, false)

    host.mode = 'ok'
    await ReactDOMAct(async () => {
      view.container.querySelector('[data-action="reload"]').click()
    })
    await flush()
    assert.equal(view.container.querySelector('[data-role="error-banner"]'), null)
    assert.match(text(view.container), /接管中（当前 10 次 /)
  } finally {
    await view.unmount()
  }
})

test('C8 卸载：abort 在途请求，且之后不得 setState', DOM, async () => {
  const host = makeHost({})
  host.mode = 'abortable'
  const controllers = []
  const RealAbortController = dom.window.AbortController
  class RecordingAbortController extends RealAbortController {
    constructor() {
      super()
      controllers.push(this)
    }
  }
  dom.window.AbortController = RecordingAbortController
  globalThis.AbortController = RecordingAbortController

  const errors = []
  const realError = console.error
  console.error = (...args) => {
    errors.push(args.map(String).join(' '))
  }
  const view = await mountSection(host)
  try {
    assert.equal(controllers.length, 1, '组件应当为在途请求建了一个 AbortController')
    assert.equal(controllers[0].signal.aborted, false)
    await view.unmount()
    assert.equal(controllers[0].signal.aborted, true, '卸载必须 abort 在途请求')

    // 请求随后才回来：alive 标志必须挡住 setState（这里以「无任何 React 报错」为准）
    host.deferred.resolve()
    await flush()
    assert.deepEqual(errors, [])
  } finally {
    await view.unmount().catch(() => {})
    console.error = realError
    dom.window.AbortController = RealAbortController
    globalThis.AbortController = RealAbortController
  }
})

test('C9 传入 shell 的 t（locale 绑定的 props.t）时用它的文案', DOM, async () => {
  const host = makeHost({})
  const t = (key, params) => {
    const raw = I.COPY_ZH[key] || key
    return params ? I.formatTemplate(raw, params) : raw
  }
  const view = await mountSection(host, { t, close: () => {} })
  try {
    assert.match(text(view.container), /模型重试策略/)
    assert.ok(view.container.querySelector('[data-action="save"]'))
  } finally {
    await view.unmount()
  }
})

test('C10 未接管（enabled 关掉）时徽标变为内置默认，预览按内置常量算', DOM, async () => {
  const host = makeHost({})
  const view = await mountSection(host)
  try {
    await ReactDOMAct(async () => {
      view.container.querySelector('[data-role="enabled"]').click()
    })
    assert.match(text(view.container), /未接管（内置默认 5 次）/)
    const steps = view.container.querySelector('[data-role="preview-steps"]').textContent
    assert.match(steps, /第 1 次 500ms → 第 2 次 1\.0s → 第 3 次 2\.0s/)
    assert.match(steps, /（共 5 次，累计 ~15\.5s）/)
  } finally {
    await view.unmount()
  }
})

test('C11 提供方强制无限：徽标显示无限、来源注明提供方，但「无限重试」开关仍是用户自己的选择', DOM, async () => {
  const payload = hostPayload(null)
  payload.effective = {
    mode: 'always',
    strategy: 'exponential',
    initialDelayMs: 1000,
    maxDelayMs: 60000,
    jitterRatio: 0.1,
    multiplier: 2,
    respectRetryAfter: true,
    source: 'provider-always',
    preview: [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000],
  }
  const host = makeHost({ payload })
  const view = await mountSection(host)
  try {
    assert.match(view.container.querySelector('[data-role="badge"]').textContent, /接管中（无限重试 \/ 指数退避）/)
    assert.match(view.container.querySelector('[data-role="preview-meta"]').textContent, /提供方要求无限重试/)
    assert.match(view.container.querySelector('[data-role="preview-steps"]').textContent, /无限重试，以下为前 10 次/)
    assert.equal(view.container.querySelector('[data-role="unlimited"]').getAttribute('aria-checked'), 'false')
    assert.ok(view.container.querySelector('[data-field="maxRetries"]'), '用户选的还是有限模式，次数输入应保留')
    assert.ok(!/undefined/.test(text(view.container)), '界面上不得出现 undefined')
  } finally {
    await view.unmount()
  }
})

test('C12 未接管（source=disabled）：徽标为内置默认、预览按内置常量、注明来源', DOM, async () => {
  const payload = hostPayload({ enabled: false })
  payload.effective = {
    mode: 'normal',
    maxRetries: 5,
    strategy: 'exponential',
    initialDelayMs: 500,
    maxDelayMs: 10000,
    jitterRatio: 0.1,
    multiplier: 2,
    source: 'disabled',
    preview: [500, 1000, 2000, 4000, 8000],
  }
  const host = makeHost({ payload })
  const view = await mountSection(host)
  try {
    const badge = view.container.querySelector('[data-role="badge"]')
    assert.equal(badge.dataset.tone, 'off')
    assert.match(badge.textContent, /未接管（内置默认 5 次）/)
    assert.match(view.container.querySelector('[data-role="preview-meta"]').textContent, /未接管，走内置默认/)
    assert.match(view.container.querySelector('[data-role="preview-steps"]').textContent, /第 1 次 500ms → 第 2 次 1\.0s/)
    assert.equal(view.container.querySelector('[data-role="enabled"]').getAttribute('aria-checked'), 'false')
  } finally {
    await view.unmount()
  }
})
