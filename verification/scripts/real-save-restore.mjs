/**
 * 独立验收脚本 B —— 真保存一次 + 立刻读回 + profile 补丁落行 + 恢复默认。
 *
 * 写盘风险最高的一步：POST 不带 dryRun 会让 configEditor 写 profile 的 cordis.patch.yml。
 * 因此：
 *   · 保存前把 profile 补丁只读复制到 verification/artifacts/ 存档；
 *   · 无论中途成败，finally 里都必须尝试 POST {"reset":true} 恢复到默认值；
 *   · 恢复后再次 GET，并把结果原样落盘（报告里直接引用）。
 *
 * 用法：node scripts/real-save-restore.mjs
 */

import { createHash } from 'node:crypto'
import { copyFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROUTE = 'http://127.0.0.1:62484/dsh-retry-policy/policy'
const HERE = dirname(fileURLToPath(import.meta.url))
const ART = join(HERE, '..', 'artifacts')
const PATCH = `${process.env.HOME}/.dsh/profiles/desktop/cordis.patch.yml`

const lines = []
function log(msg) {
  lines.push(msg)
  console.log(msg)
}
function snap(tag, copyTo) {
  const st = statSync(PATCH)
  const buf = readFileSync(PATCH)
  const sha = createHash('sha256').update(buf).digest('hex')
  if (copyTo) copyFileSync(PATCH, join(ART, copyTo))
  log(`[snapshot ${tag}] mtimeMs=${st.mtimeMs} size=${st.size} sha256=${sha}${copyTo ? ` copy=${copyTo}` : ''}`)
  return { mtimeMs: st.mtimeMs, size: st.size, sha256: sha, text: buf.toString('utf8') }
}
async function post(body) {
  const res = await fetch(ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => undefined) }
}
async function get() {
  const res = await fetch(ROUTE)
  return { status: res.status, json: await res.json().catch(() => undefined) }
}
/** 从 profile 补丁里抠出 dsh-retry-policy 那一整段（缩进 2 空格的行块）。 */
function extractRow(text) {
  const rows = text.split(/\n(?=- )/)
  return rows.filter((row) => /^- id: dsh-retry-policy$/m.test(row))
}

const SAVE_CONFIG = {
  enabled: true,
  mode: 'inherit',
  maxRetries: 3,
  strategy: 'fixed',
  initialDelayMs: 2000,
  maxDelayMs: 60000,
  multiplier: 2,
  jitterRatio: 0.1,
  retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
  respectRetryAfter: true,
}

let restored = false
let failed = false

try {
  // ---------------------------------------------------------- 保存前
  const before = snap('BEFORE-SAVE', 'B-profile-patch.before-save.yml')
  const getBefore = await get()
  log(`[GET before] status=${getBefore.status} maxRetries=${getBefore.json?.config?.maxRetries} strategy=${getBefore.json?.config?.strategy}`)
  log(`[profile 补丁里是否已有 dsh-retry-policy 行] ${extractRow(before.text).length} 行`)

  // ---------------------------------------------------------- 真保存
  const save = await post({ config: SAVE_CONFIG })
  log(`[POST save] status=${save.status} body=${JSON.stringify(save.json)}`)
  if (save.status !== 200 || save.json?.saved !== true) {
    failed = true
    log(`[FAIL] 保存未成功：status=${save.status} body=${JSON.stringify(save.json)}`)
  }

  // ---------------------------------------------------------- 立刻 GET 读回（重载判据）
  const getAfter = await get()
  const okReadBack = getAfter.status === 200
    && getAfter.json?.config?.maxRetries === 3
    && getAfter.json?.config?.strategy === 'fixed'
    && getAfter.json?.config?.initialDelayMs === 2000
  log(`[GET after save] status=${getAfter.status} config=${JSON.stringify(getAfter.json?.config)}`)
  log(`[GET after save] effective=${JSON.stringify(getAfter.json?.effective)}`)
  log(`[GET after save] providerPolicies n=${getAfter.json?.providerPolicies?.length}`)
  log(`[读回是否等于新值] ${okReadBack}`)
  if (!okReadBack) failed = true
  writeFileSync(join(ART, 'B-01-get-after-save.json'), JSON.stringify(getAfter.json, null, 2))

  // ---------------------------------------------------------- profile 补丁落行
  const after = snap('AFTER-SAVE', 'B-profile-patch.after-save.yml')
  const row = extractRow(after.text)
  log(`[profile 补丁 dsh-retry-policy 行数] ${row.length}`)
  log(`[profile 补丁 dsh-retry-policy 行内容]\n${row.join('\n')}`)
  const mtimeChanged = after.mtimeMs !== before.mtimeMs
  const shaChanged = after.sha256 !== before.sha256
  log(`[补丁 mtime 变化] ${mtimeChanged}  [sha256 变化] ${shaChanged}`)
  if (row.length !== 1 || !/maxRetries: 3/.test(row[0]) || !/strategy: fixed/.test(row[0])) failed = true

  // ---------------------------------------------------------- 恢复默认
  const reset = await post({ reset: true })
  restored = reset.status === 200 && reset.json?.saved === true
  log(`[POST reset] status=${reset.status} body=${JSON.stringify(reset.json)}`)

  const getRestored = await get()
  writeFileSync(join(ART, 'B-02-get-after-restore.json'), JSON.stringify(getRestored.json, null, 2))
  const defaults = getRestored.json?.defaults
  const isDefault = JSON.stringify(getRestored.json?.config) === JSON.stringify(defaults)
  log(`[GET after restore] status=${getRestored.status}`)
  log(`[GET after restore] config=${JSON.stringify(getRestored.json?.config)}`)
  log(`[GET after restore] effective=${JSON.stringify(getRestored.json?.effective)}`)
  log(`[恢复后 config === defaults] ${isDefault}`)
  if (!restored || !isDefault) failed = true

  const final = snap('AFTER-RESTORE', 'B-profile-patch.after-restore.yml')
  const finalRow = extractRow(final.text)
  log(`[恢复后 profile 补丁 dsh-retry-policy 行内容]\n${finalRow.join('\n')}`)
  log(`[恢复后补丁 sha256 是否回到保存前] ${final.sha256 === before.sha256}`)
} catch (error) {
  failed = true
  log(`[EXCEPTION] ${error && error.stack}`)
} finally {
  if (!restored) {
    log('[WARN] 正常路径未确认恢复成功，finally 里强制再 reset 一次')
    try {
      const again = await post({ reset: true })
      log(`[finally reset] status=${again.status} body=${JSON.stringify(again.json)}`)
      const g = await get()
      log(`[finally GET] config=${JSON.stringify(g.json?.config)}`)
      restored = again.status === 200 && JSON.stringify(g.json?.config) === JSON.stringify(g.json?.defaults)
      log(`[finally 恢复成功] ${restored}`)
    } catch (error) {
      log(`[finally reset 失败] ${error && error.message}`)
    }
  }
  snap('FINAL', 'B-profile-patch.final.yml')
  writeFileSync(join(ART, 'B-real-save-restore.log.txt'), `${lines.join('\n')}\n`)
  log(`=== restored=${restored} failed=${failed} ===`)
  process.exit(failed || !restored ? 1 : 0)
}
