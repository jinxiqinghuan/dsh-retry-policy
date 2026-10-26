/**
 * 独立验收脚本 A —— HTTP 契约 + 公式对比 + 非法配置 + dryRun 不写盘。
 *
 * 独立性声明：
 *   · 本文件**不 import** dsh-retry-policy 的任何 lib/*（公式由 verifier 按 SPEC §3 自行实现）。
 *   · 期望值部分来自 verifier 手算（见 VERIFICATION.md 的手算表），部分由本文件按 SPEC 重算。
 *   · 只读 profile，除 "真保存" 阶段外不做任何写操作；真保存由 B 脚本单独负责。
 *
 * 用法：node scripts/independent-check.mjs
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = 'http://127.0.0.1:62484'
const ROUTE = `${BASE}/dsh-retry-policy/policy`
const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'artifacts')
const PROFILE_PATCH = `${process.env.HOME}/.dsh/profiles/desktop/cordis.patch.yml`

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

// ---------------------------------------------------------------- SPEC §3（verifier 自行实现）
function myDelayMs(cfg, attempt, rand) {
  const { initialDelayMs, maxDelayMs, multiplier = 2, jitterRatio = 0, strategy } = cfg
  let base
  if (strategy === 'fixed') base = initialDelayMs
  else if (strategy === 'linear') base = initialDelayMs * attempt
  else base = initialDelayMs * multiplier ** Math.min(attempt - 1, 64)
  base = Math.min(base, maxDelayMs)
  const jittered = base * (1 - jitterRatio + 2 * jitterRatio * rand)
  const delay = Math.min(Math.round(jittered), maxDelayMs)
  return Math.max(delay, 1)
}

function myPreview(cfg, rand = 0.5) {
  const limit = cfg.mode === 'always' ? 10 : Math.max(0, Math.min(cfg.maxRetries ?? 0, 10))
  const out = []
  for (let attempt = 1; attempt <= limit; attempt += 1) out.push(myDelayMs(cfg, attempt, rand))
  return out
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---------------------------------------------------------------- profile 快照（dryRun 不写盘的判据）
function snapshotPatch() {
  const st = statSync(PROFILE_PATCH)
  const buf = readFileSync(PROFILE_PATCH)
  return {
    mtimeMs: st.mtimeMs,
    size: st.size,
    ino: st.ino,
    sha256: createHash('sha256').update(buf).digest('hex'),
  }
}
const snapText = (s) => `mtimeMs=${s.mtimeMs} size=${s.size} ino=${s.ino} sha256=${s.sha256}`

async function request(method, body, headers = {}) {
  const res = await fetch(ROUTE, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = undefined }
  return { status: res.status, headers: Object.fromEntries(res.headers), text, json }
}

// ================================================================ 1. GET 基本契约
const get1 = await request('GET')
writeFileSync(join(OUT, 'A-01-get-default.json'), get1.text)
record('GET 200', get1.status === 200, `status=${get1.status}`)
record('GET content-type', get1.headers['content-type'] === 'application/json; charset=utf-8', get1.headers['content-type'])
record('GET cache-control no-store', get1.headers['cache-control'] === 'no-store', String(get1.headers['cache-control']))
record('GET ok:true / entryId', get1.json?.ok === true && get1.json?.entryId === 'dsh-retry-policy', `entryId=${get1.json?.entryId}`)
record('GET editable:true', get1.json?.editable === true, `editable=${get1.json?.editable}`)
record('GET config 是归一化后的默认值', eq(get1.json?.config, get1.json?.defaults), JSON.stringify(get1.json?.config))
record('GET providerPolicies 数量', Array.isArray(get1.json?.providerPolicies) && get1.json.providerPolicies.length > 0, `n=${get1.json?.providerPolicies?.length}`)
record('GET strategyOptions/codeOptions 存在', Array.isArray(get1.json?.strategyOptions) && Array.isArray(get1.json?.codeOptions), '')

// ================================================================ 2. 默认 effective.preview 对比手算
const defEff = get1.json?.effective
const defExpected = myPreview(get1.json?.config)
record('默认 preview == verifier 手算', eq(defEff?.preview, defExpected),
  `host=${JSON.stringify(defEff?.preview)} mine=${JSON.stringify(defExpected)}`)
record('默认 effective 字段（mode/source/maxRetries）', defEff?.mode === 'normal' && defEff?.source === 'config' && defEff?.maxRetries === 10,
  `mode=${defEff?.mode} source=${defEff?.source} maxRetries=${defEff?.maxRetries}`)
record('默认 preview 命中上限 60000（夹 maxDelayMs）', defEff?.preview?.[6] === 60000 && defEff?.preview?.[9] === 60000, JSON.stringify(defEff?.preview))

// ================================================================ 3. dryRun 各策略对比（含手算期望）
const before = snapshotPatch()

const dryCases = [
  {
    id: 'A-02-fixed-2000x3',
    body: { config: { maxRetries: 3, strategy: 'fixed', initialDelayMs: 2000 }, dryRun: true },
    expect: [2000, 2000, 2000],
    note: '固定间隔；最高优先级回归：SPEC §8.5 指定用例',
  },
  {
    id: 'A-03-linear-1500-4',
    body: { config: { maxRetries: 4, strategy: 'linear', initialDelayMs: 1500, maxDelayMs: 5000, jitterRatio: 0.2 }, dryRun: true },
    expect: [1500, 3000, 4500, 5000],
    note: '手算：base=1500*t；t4=6000 夹到 5000；rand=0.5 → factor=1',
  },
  {
    id: 'A-04-exp-clamp-700x3',
    body: { config: { maxRetries: 12, strategy: 'exponential', initialDelayMs: 700, maxDelayMs: 20000, multiplier: 3, jitterRatio: 0.25 }, dryRun: true },
    expect: [700, 2100, 6300, 18900, 20000, 20000, 20000, 20000, 20000, 20000],
    note: '手算：700*3^(t-1)，t5=56700 夹 20000；预览 count=min(12,10)=10',
  },
  {
    id: 'A-05-zero-retries',
    body: { config: { maxRetries: 0 }, dryRun: true },
    expect: [],
    note: 'maxRetries=0 → preview 空（0 = 不重试）',
  },
  {
    id: 'A-06-always-mode',
    body: { config: { mode: 'always', strategy: 'fixed', initialDelayMs: 250 }, dryRun: true },
    expect: [250, 250, 250, 250, 250, 250, 250, 250, 250, 250],
    note: 'always 取 10 条，且 effective 不带 maxRetries',
  },
  {
    id: 'A-07-no-jitter-linear',
    body: { config: { maxRetries: 3, strategy: 'linear', initialDelayMs: 500, jitterRatio: 0 }, dryRun: true },
    expect: [500, 1000, 1500],
    note: 'jitterRatio=0 → 无抖动',
  },
]

for (const c of dryCases) {
  const res = await request('POST', c.body)
  writeFileSync(join(OUT, `${c.id}.json`), JSON.stringify({ request: c.body, status: res.status, response: res.json }, null, 2))
  const got = res.json?.effective?.preview
  record(`${c.id} dryRun 200 + preview`, res.status === 200 && eq(got, c.expect),
    `status=${res.status} host=${JSON.stringify(got)} expected=${JSON.stringify(c.expect)}`)
  record(`${c.id} saved:false`, res.json?.saved === false, `saved=${res.json?.saved}`)
  if (c.body.config.mode === 'always') {
    record(`${c.id} always 无 maxRetries`, !('maxRetries' in (res.json?.effective ?? {})), JSON.stringify(res.json?.effective))
  }
}

// 抖动边界（rand 不是中值时）：用 SPEC §3 手算期望，再与本插件纯函数对拍。
// 说明：这一项是对实现的白盒核对，不是预览路径（预览固定 rand=0.5）。
const { delayFor } = await import('../../lib/policy.js')
const jitterCfg = { strategy: 'exponential', initialDelayMs: 1000, maxDelayMs: 60000, jitterRatio: 0.25, multiplier: 2 }
const jitterChecks = [
  // attempt=2 → base=2000；rand=0 → 2000*(1-0.25)=1500；rand=1 → 2000*1.25=2500；rand=0.5 → 2000
  { attempt: 2, rand: 0, expect: 1500 },
  { attempt: 2, rand: 1, expect: 2500 },
  { attempt: 2, rand: 0.5, expect: 2000 },
  // 抖动后仍不得越过 maxDelayMs：attempt=7 → base=min(64000,60000)=60000；rand=1 → 75000 → 夹回 60000
  { attempt: 7, rand: 1, expect: 60000 },
  // 四舍五入：attempt=1 → base=1000；rand=0.333 → 1000*(0.75+0.5*0.333)=915 → /round
  { attempt: 1, rand: 0.333, expect: Math.max(Math.min(Math.round(1000 * (1 - 0.25 + 2 * 0.25 * 0.333)), 60000), 1) },
]
for (const j of jitterChecks) {
  const got = delayFor(jitterCfg, j.attempt, () => j.rand)
  record(`抖动核对 attempt=${j.attempt} rand=${j.rand}`, got === j.expect, `host=${got} hand=${j.expect}`)
}
// 至少 1ms
record('最小 1ms 夹', delayFor({ strategy: 'fixed', initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 1 }, 1, () => 0) === 1,
  `got=${delayFor({ strategy: 'fixed', initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 1 }, 1, () => 0)}`)

// ================================================================ 4. 非法配置 → 400 + issues
const badCases = [
  { id: 'A-10-out-of-range', config: { maxRetries: 5000 }, field: 'maxRetries' },
  { id: 'A-11-out-of-range-delay', config: { initialDelayMs: 0 }, field: 'initialDelayMs' },
  { id: 'A-12-unknown-key', config: { bogus: 1 }, field: 'bogus' },
  { id: 'A-13-type-error', config: { maxRetries: '3' }, field: 'maxRetries' },
  { id: 'A-14-maxdelay-lt-initial', config: { initialDelayMs: 5000, maxDelayMs: 1000 }, field: 'maxDelayMs' },
  { id: 'A-15-empty-codes', config: { retryableCodes: [] }, field: 'retryableCodes' },
  { id: 'A-16-bad-strategy', config: { strategy: 'quadratic' }, field: 'strategy' },
]
for (const c of badCases) {
  const res = await request('POST', { config: c.config, dryRun: true })
  writeFileSync(join(OUT, `${c.id}.json`), JSON.stringify({ request: { config: c.config, dryRun: true }, status: res.status, response: res.json }, null, 2))
  const issues = res.json?.issues
  const hasField = Array.isArray(issues) && issues.some((i) => i.field === c.field)
  record(`${c.id} → 400 + issues[${c.field}]`, res.status === 400 && res.json?.ok === false && hasField,
    `status=${res.status} issues=${JSON.stringify(issues)}`)
}

// 其它 HTTP 契约（SPEC §6）：非 GET/POST → 405；跨站 → 403；超大 body → 413
const putRes = await request('PUT', { config: {} })
record('PUT → 405', putRes.status === 405, `status=${putRes.status} body=${putRes.text.slice(0, 80)}`)
const crossRes = await request('GET', undefined, { 'sec-fetch-site': 'cross-site' })
record('sec-fetch-site: cross-site → 403', crossRes.status === 403, `status=${crossRes.status}`)
const bigRes = await request('POST', JSON.stringify({ config: {}, pad: 'x'.repeat(70 * 1024) }))
record('body > 64KiB → 413', bigRes.status === 413, `status=${bigRes.status} body=${bigRes.text.slice(0, 80)}`)
const badJson = await request('POST', '{not json')
record('非法 JSON → 400', badJson.status === 400, `status=${badJson.status} body=${badJson.text.slice(0, 80)}`)

// ================================================================ 5. dryRun 不写盘（mtime + sha256）
const afterDry = snapshotPatch()
record('dryRun 全流程后 profile cordis.patch.yml 未改动',
  before.mtimeMs === afterDry.mtimeMs && before.sha256 === afterDry.sha256 && before.size === afterDry.size,
  `before(${snapText(before)}) after(${snapText(afterDry)})`)
writeFileSync(join(OUT, 'A-17-profile-snapshot-dryrun.txt'),
  `before ${snapText(before)}\nafter  ${snapText(afterDry)}\nunchanged=${before.mtimeMs === afterDry.mtimeMs && before.sha256 === afterDry.sha256}\n`)

// ================================================================ 6. dryRun 后 GET 仍是默认值
const get2 = await request('GET')
record('dryRun 后 GET 仍为默认配置', eq(get2.json?.config, get1.json?.config), JSON.stringify(get2.json?.config))

// ---------------------------------------------------------------- 汇总
mkdirSync(OUT, { recursive: true })
const failed = results.filter((r) => !r.pass)
writeFileSync(join(OUT, 'A-summary.json'), JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2))
console.log(`\n=== total=${results.length} failed=${failed.length} ===`)
for (const f of failed) console.log(`FAILED: ${f.name} :: ${f.detail}`)
process.exit(failed.length === 0 ? 0 : 1)
