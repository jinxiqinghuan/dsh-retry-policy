# dsh-retry-policy —— 冻结接口契约（SPEC）

> 本文件是**并行开发的唯一真相**。宿主半边、设置页半边、验收方都按本文件实现/核对；
> 任何一方要改契约，必须先在共享任务里提出，由 Lead 更新本文件后再动代码。

## 0. 背景与目标

- 现象：模型请求失败后**固定重试 5 次**就不再调用，且等待时间是内置指数退避（500ms → 10s、抖动 10%），
  运行期不可改。
- 原因（已核实）：
  - 重试次数与退避参数来自 **provider 适配器配置**里的 `retryPolicy`
    （`@deepseek-ai/dsh-llm` 的 `resolveRetryPolicy()`，缺省 `normal` + `maxRetries: 5`
     + `initialDelayMs: 500` / `maxDelayMs: 10000` / `jitterRatio: 0.1`
     + codes `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`）。
  - 适配器在注册路由时**一次性快照**该策略（`llm.providerRetryPolicy()` 返回已解析对象），
    运行时无法改。
  - 真正执行重试的是 `@deepseek-ai/dsh-llm-retry`：它监听 `agent/request-error` 瀑布，
    按 payload 里的 `retryPolicy` 计算延迟并返回 `{ kind: 'retry' }`。
- 目标：本插件**接管**重试执行器，自带可配置的“次数 + 等待时间策略”，并提供设置页即时保存生效。
- 做法：bundle patch 把官方 `llm-retry` 行 `disabled: true`，再插入本插件宿主行；
  本插件复刻官方的事件与投影（`llm/retry`、`llm/retry-started`、`llmRetry` 投影），
  因此会话界面、轨迹、会话格式迁移全部零改动。

## 1. 文件与职责（写作用域）

| 路径 | 归属 | 职责 |
|---|---|---|
| `package.json` `cordis.patch.yml` `locale/*.json` `icon.svg` `SPEC.md` `README.md` `CHANGELOG.md` `LICENSE` | **Lead** | 清单、补丁、展示资源、文档 |
| `lib/policy.js` | **host-dev** | 纯函数：配置归一化/校验、等待时间计算、effective 解析、事件与投影定义；无 IO、无 cordis 依赖 |
| `lib/host.js` | **host-dev** | cordis 宿主插件：重试引擎 + 投影注册 + HTTP 路由 |
| `tests/policy.test.mjs` `tests/host.test.mjs` | **host-dev** | 单测 + 假 ctx 集成测试 |
| `lib/client.js` | **ui-dev** | 浏览器半边：设置页 `settings.section` |
| `tests/client.test.mjs` | **ui-dev** | 客户端纯函数/渲染测试 |
| `verification/**` | **verifier** | 独立验收证据 |

**禁止越界**：host-dev 不碰 `lib/client.js`；ui-dev 不碰 `lib/host.js` / `lib/policy.js`；
两人都不改 `package.json`、`cordis.patch.yml`、`locale/*`（需要改动就在群里提，由 Lead 改）。

**依赖约束**：`lib/*.js` 只允许 import `node:*` 内置模块和包内相对路径。
**不要 import 任何 `@deepseek-ai/*` 包**——本地 link 安装的包解析不到它们
（`dsh-quadrant` / `dsh-work-log` 同样只用 node 内置模块）。也不要 export `Config`
（没有 schema 时 Loader 直接透传 `config`，由 `lib/policy.js` 自己校验）。

## 2. 配置模型（`lib/policy.js` 的 `DEFAULTS` / `normalizeConfig`）

宿主行的 `config`（也是设置页保存进 profile 用户层的值）：

| 字段 | 类型 | 默认 | 约束 |
|---|---|---|---|
| `enabled` | boolean | `true` | false = 本插件**不接管**，退回官方内置策略（normal / 5 次 / 500→10000 / 0.1 抖动） |
| `mode` | `'inherit' \| 'always'` | `'inherit'` | `always` = 对所有提供方强制无限重试 |
| `maxRetries` | int | `10` | 0 ~ 1000（不含首次请求；0 = 不重试） |
| `strategy` | `'exponential' \| 'linear' \| 'fixed'` | `'exponential'` | 见 §3 |
| `initialDelayMs` | int | `1000` | 1 ~ 3_600_000 |
| `maxDelayMs` | int | `60000` | 1 ~ 3_600_000，且 ≥ `initialDelayMs` |
| `multiplier` | number | `2` | 1 ~ 100，仅 `exponential` 用 |
| `jitterRatio` | number | `0.1` | 0 ~ 1 |
| `retryableCodes` | string[] | `['EMPTY_RESPONSE','RATE_LIMIT','SERVER','TIMEOUT','TRANSPORT']` | 非空、去重、全为非空字符串 |
| `respectRetryAfter` | boolean | `true` | 见 §5.3 |

`normalizeConfig(raw)` 语义：缺省 → 默认值；类型错/越界/未知键 → **抛 `PolicyError`**
（带 `issues: [{field, message}]`）。宿主 `apply()` 里必须 try/catch：
配置非法时记 warning 并**整体退回 DEFAULTS**（插件绝不能因为配置坏掉就不加载）。

`configToPatchRow(config)`：把归一化后的配置转成写进 profile 补丁的**纯 JSON 对象**（键顺序固定）。

## 3. 等待时间策略（唯一真相）

```
attempt ∈ 1..n（第 1 次重试 = attempt 1）
fixed:        base = initialDelayMs
linear:       base = initialDelayMs * attempt
exponential:  base = initialDelayMs * multiplier ** min(attempt - 1, 64)
base = min(base, maxDelayMs)
jittered = base * (1 - jitterRatio + 2 * jitterRatio * rand)      // rand ∈ [0,1)，对称抖动
delayMs  = min(round(jittered), maxDelayMs)                        // 再夹一次上限
delayMs  = max(delayMs, 1)                                         // 至少 1ms
```

- `rand` 由参数注入（宿主传 `Math.random`，测试传定值），保证可测。
- `previewDelays(config, count, rand = () => 0.5)`：返回 `count` 个延迟，**抖动取中值**
  （rand=0.5 时 jittered === base），用于设置页预览；`count = min(effective 上限, 10)`，
  `always` 模式取 10 个。
- 官方内置默认策略的延迟公式与上表 `exponential` 等价（`enabled: false` 时按内置常量算）。

## 4. 生效策略（effective）

```
resolveEffectivePolicy(config, providedPolicy):
  if (!config.enabled)              → BUILTIN_DEFAULT（normal, 5, 500/10000/0.1, 官方 codes）
  if (config.mode === 'always')     → always + 本插件 backoff
  if (providedPolicy?.mode === 'always') → always + 本插件 backoff   // 提供方要无限，尊重它
  否则                               → normal, maxRetries = config.maxRetries,
                                       retryableCodes = config.retryableCodes,
                                       backoff = 本插件 backoff
```

返回对象形状（与官方 `ResolvedRetryPolicy` 同构，便于直接喂给官方公式）：

```js
// normal
{ mode: 'normal', maxRetries, retryableCodes: string[], initialDelayMs, maxDelayMs, jitterRatio, strategy, multiplier, source }
// always
{ mode: 'always', initialDelayMs, maxDelayMs, jitterRatio, strategy, multiplier, source }
```

`source` ∈ `'config' | 'provider-always' | 'disabled'`，只用于展示与事件 `policyKey`：

- `'config'`：用户配置生效（normal）；
- `'provider-always'`：提供方声明了 always，被尊重；
- `'disabled'`：`enabled:false`，退回官方内置默认（常量 `BUILTIN_DEFAULT` 自身带 `source:'builtin'`，
  但 GET 的 `effective.source` 在未接管时报告 `'disabled'`，设置页按 `enabled===false || source==='disabled'` 判“未接管”）。

`effective` 上还会附加 `multiplier` 与 `respectRetryAfter`（§5.3 需要），设置页因此**不能假设
`effective.maxRetries` 一定存在**（always 模式没有该字段）。

## 5. 重试引擎（`lib/host.js`）

### 5.1 挂载形态

```js
const name = 'dsh-retry-policy'
const inject = ['agents', 'sessionProjections']   // 与官方 llm-retry 一致
function apply(ctx, config) { ... }
export { apply, inject, name }
```

内部（建议直接以官方实现为蓝本改写）：

- `ctx.sessionProjections.register({ key: 'llmRetry', stateVersion: 1, stateSchema, init, apply })`
  —— **必须与官方逐字节同构**：
  - `stateSchema`：`record(string, { retry: int ≥ 0, retryId: string })`
  - `apply(state, event)`：`step/start` 或 `turn/end` → `{}`；非 `llm/retry` → 原样；
    否则 `key = JSON.stringify([event.data.provider, event.data.policyKey])`，
    相同 `retry`+`retryId` 时返回原 state，否则写入 `{ retry, retryId }`。
- `const dispose = ctx.on('agent/request-error', (payload, next) => track(recover(payload, next)))`
- `ctx.effect(() => async () => { dispose(); lifetime.abort(new Error('dsh-retry-policy plugin disposed')); await Promise.allSettled([...active]) }, 'dsh-retry-policy: abort and drain active recovery')`
- `track(op)`：把 promise 放进 `active` Set，settle 后移除。

### 5.2 判定顺序

```
recover({ agent, turn, step, provider, failure, retryPolicy, signal }, next):
  1. signal/lifetime 已 abort → 直接返回（不 next）
  2. effective = resolveEffectivePolicy(config, retryPolicy)
  3. effective.mode === 'always':
       a. 先 await 下游（settleDownstream(next)）——保持官方“下游优先”语义
       b. 下游返回 { kind:'retry' } → 原样返回；下游抛错只记 warn，继续走本插件兜底
  4. 否则（normal）：effective.retryableCodes 不含 failure.code → return next()
  5. policyKey = retryPolicyKey(effective)（稳定、含全部影响行为的字段，codes 排序）
  6. previous = ctx.sessionProjections.stateOf(agent.session, 'llmRetry')[JSON.stringify([provider, policyKey])]
  7. normal 且 (previous?.retry ?? 0) >= effective.maxRetries → return next()
  8. retry = (previous?.retry ?? 0) + 1；retryId = previous?.retryId ?? randomUUID()
  9. 计算 delayMs（§5.3）
 10. backoff(): append 事件 → 等延迟 → append started → return { kind: 'retry' }
```

关键点（**已修正，必须遵守**）：

1. 本插件是唯一的重试执行器（官方 `llm-retry` 行已 disabled），因此**不存在第二份重试预算**。
2. **决定不重试时必须 `return next()`**，绝不能直接 `return undefined`。原因是
   `agent/request-error` 是瀑布，链上还有别的恢复策略：
   - `@deepseek-ai/dsh-compaction-basic`：处理 `CONTEXT_WINDOW_EXCEEDED`（当前 profile 里是 inactive，但用户随时可开）；
   - `@deepseek-ai/dsh-compaction-image-offload`：处理 `IMAGE_OFFLOAD_REQUIRED`（当前 absent）。
   这两个监听器在“不归自己管”时都会 `return next()`。我们若直接返回 `undefined`，
   会把它们的恢复路径整条掐掉（agent-loop README：handling listener 返回 `{kind:'retry'}` 且不调 `next()`，
   未被处理的失败即终态）。
3. 只有**真正决定重试**时才短路：`return { kind: 'retry' }` 且不调 `next()`。
4. `always` 模式保持官方语义：先 `settleDownstream(next)`，下游给出 retry 就采纳；
   下游抛错只 warn，然后本插件兜底重试。

### 5.3 延迟与 `Retry-After`

```
providerRetryAfterMs 有限且 > 0：
   ≤ maxDelayMs 且 respectRetryAfter → delayMs = providerRetryAfterMs
   >  maxDelayMs → normal: return next()（放弃）；always: delayMs = 本地公式
否则 → delayMs = 本地公式（§3，attempt = retry）
```

`cancellableDelay(delayMs, signal)`：与官方一致（`setTimeout` + `abort` 时清 timer 返回 false），
signal 用 `AbortSignal.any([signal, lifetime.signal])`。

### 5.4 事件（字段集必须完全一致）

```js
// normal
agent.session.append('llm/retry', { retryId, turn, step, provider, mode: 'normal',
  policyKey, retry, maxRetries, delayMs, failure })
// always
agent.session.append('llm/retry', { retryId, turn, step, provider, mode: 'always',
  policyKey, retry, delayMs, failure })
// 延迟结束、真正重试前
agent.session.append('llm/retry-started', { retryId, turn, step, retry })
```

`failure` 原样透传（`{ message, code, status?, providerRetryAfterMs?, ... }`）。
**不要**给模型可见历史写任何东西（官方语义：重试对模型不可见）。

`RetryId` 直接用 `crypto.randomUUID()` 字符串即可（官方只是 brand，无运行时校验）。

### 5.5 已生效配置的读取

`apply(ctx, config)` 收到的 `config` 即当前生效配置（设置页保存后 Loader 会重新加载本插件，
`apply` 会带着新 config 重新执行）。引擎里用 `let live = normalizeConfigSafe(config)`，
并把 `configEditor` 保存后的新值**以重新加载为准**，不要自己搞一份内存副本。

## 6. HTTP 契约（宿主路由）

沿用 `dsh-quadrant` 的成熟做法：`ctx.inject(['webServer'], (s) => s.webServer.register({ kind:'exact', path, handler }))`。

- 路径：`/dsh-retry-policy/policy`
- 同源检查：`sec-fetch-site: cross-site` → 403
- 方法：GET / POST，其他 → 405
- Body 上限 64 KiB，超出 → 413
- 响应头：`content-type: application/json; charset=utf-8`、`cache-control: no-store`

### GET

```json
{
  "ok": true,
  "entryId": "dsh-retry-policy",
  "editable": true,
  "config": { ...归一化后的当前配置... },
  "defaults": { ...DEFAULTS... },
  "effective": { "mode": "normal", "maxRetries": 10, "strategy": "exponential",
                 "initialDelayMs": 1000, "maxDelayMs": 60000, "jitterRatio": 0.1,
                 "source": "config", "preview": [1000, 2000, 4000, ...] },
  "providerPolicies": [ { "provider": "loomy", "mode": "normal", "maxRetries": 5 } ],
  "strategyOptions": [ { "id": "fixed", "label": "固定间隔" }, ... ],
  "codeOptions": ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", "AUTH", "QUOTA", "INVALID_REQUEST", "PROTOCOL", "CONTEXT_OVERFLOW"]
}
```

- `editable`：`configEditor` 服务在、且本插件的 Loader entry 在 `configEditor.entries()` 里 → true；
  否则设置页只读并提示原因。
- `providerPolicies`：`ctx.get('llm')?.listProviders()` + `providerRetryPolicy(id)` 得到的**只读**
  提示信息（说明“提供方默认 5 次”，便于用户理解为什么改了才有用）；取不到就返回 `[]`，绝不抛错。

### POST

```jsonc
// 预览（不落盘）
{ "config": { ... }, "dryRun": true }
// 保存
{ "config": { ... } }
// 恢复默认
{ "reset": true }
```

成功：

```json
{ "ok": true, "saved": true, "config": {...}, "effective": {...}, "editable": true }
```

失败：HTTP 400 + `{ "ok": false, "error": "配置不合法", "issues": [{ "field": "maxRetries", "message": "..." }] }`；
`configEditor` 缺失/不可编辑 → 503 + `{ ok:false, error }`；保存抛错 → 500 + `{ ok:false, error }`。

保存实现：`ctx.get('configEditor').edit(entry, (current, inherited) => next)`，
`entry` 是 `apply` 里捕获的 `ctx.fiber.entry`；`next` 为 `reset ? DEFAULTS_RAW : normalizedRaw`。
保存成功后 Loader 会重载本插件，GET 即返回新值。

## 7. 设置页契约（`lib/client.js`）

- 形态：IIFE + `window.__ModuleLoader__.load({ id: 'dsh-retry-policy', factory })`，
  `factory(require)` 只 `require('react')`；导出 `{ inject: ['slots'], apply(ctx) }`。
  （照抄 `dsh-quadrant/lib/client.js` 的骨架；`dsh.client.inject` 已在 package.json 声明
  `@deepseek-ai/dsh-client-ui-settings`。）
- 注册：`ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dsh-retry-policy', order: 60, label: () => '模型重试策略', locale: <NS> }, View))`
  —— 以官方 `dsh-client-ui-agent-preset` / `dsh-client-ui-settings-plugins` 的注册参数为准。
- 页面内容（中文硬编码，主题只走 `--dsw-alias-*` CSS 变量）：
  1. 顶部状态徽标：`接管中（当前 N 次 / 策略）` 或 `未接管（内置默认 5 次）`；
  2. 「启用接管」开关（`enabled`）；
  3. 「无限重试」开关（`mode: always`，开启后隐藏次数与上限约束说明）；
  4. 重试次数（数字输入 `maxRetries`，0~1000）；
  5. 等待策略三段选择：固定间隔 / 线性增长 / 指数退避；
  6. 初始等待 `initialDelayMs`（ms，含 0.5s/1s/2s/5s 快捷值）、最大等待 `maxDelayMs`、
     增长倍数 `multiplier`（仅指数时可用）、抖动比例 `jitterRatio`（0~100%）；
  7. 参与重试的失败码多选（`retryableCodes`）；
  8. 「优先听提供方 Retry-After」开关；
  9. 实时预览：把 `preview` 渲染成“第 1 次 1.0s → 第 2 次 2.0s → …（共 N 次，累计 ~X）”；
     编辑时本地按同一公式即时预览，保存/加载后用服务端 `preview` 校准；
 10. 底部按钮：保存（POST config）/ 恢复默认（POST reset）/ 重新读取（GET）；
     显示保存中、成功（短暂提示）、失败（展示 `issues` 或 error 文本）。
- 所有网络失败必须在页面上可见，不允许静默失败；组件卸载后不得 setState。
- 只读态（`editable:false`）时禁用输入与按钮并显示提示。

## 8. 验收标准（verifier 按此出具证据）

1. `node --check` 三个文件通过；`node --test tests/` 全绿。
2. `plugin_manager install_bundle` 安装后：`application: applied`，无 `failed`/`overridden`。
3. `cordis_inspect_query`（Service `Event` / Config）确认：
   - `llm-retry` 行为 disabled，`dsh-retry-policy` 行为 active；
   - `agent/request-error` 的监听者里只有本插件这一个重试执行器。
4. `curl http://127.0.0.1:62484/dsh-retry-policy/policy` 返回 `ok:true`、`editable:true`，
   `config.maxRetries` 为补丁默认值，`effective.preview` 与 §3 公式一致。
5. `curl -X POST ... -d '{"config":{"maxRetries":3,"strategy":"fixed","initialDelayMs":2000},"dryRun":true}'`
   返回按固定间隔的预览；**dryRun 不得改动** profile 的 `cordis.patch.yml`。
6. 真正 POST 保存后：`curl GET` 返回新值，profile 的 `cordis.patch.yml` 里出现
   `- id: dsh-retry-policy` + 新 config，并在验收结束前**恢复到默认值**。
7. 客户端：`/`(index) 注入的 bundle 列表里出现 `dsh-retry-policy` 的 client bundle，
   且该 bundle 文本里含 `settings.section` 与页面标题；无浏览器控制时按
   `references/verification.md` 如实报告“渲染未验证”。
8. 独立性：verifier 不能只跑作者写的测试当结论，必须自己按 §3 公式手算 2~3 组
   （固定/线性/指数各一）与 `preview` 对比；并构造一次非法配置验证拒绝路径。
9. 重试链路的证据：至少给出一份“事件形状 + 预算 + 延迟”的验证
   （假 ctx 集成测试或动态插件探针均可），并说明未覆盖的部分。

## 9. 已知边界（必须在 README 里如实写）

- 只有 agent 回合内的模型请求会重试；直接用 `ctx.llm.stream()` 的外部调用仍是单次尝试（官方限制）。
- 无限重试会对永久性错误（鉴权/配额/参数非法）一直重试，成本与延迟由用户负责。
- 本插件的预算是**按 (provider, 策略) 独立计数**，每次 `step/start`、`turn/end` 清零；与压缩等
  其他恢复机制的预算互不相通。
- 关闭本插件接管后回落为内置默认 5 次（不会回到“插件不存在但官方行还被禁用”的状态）。
