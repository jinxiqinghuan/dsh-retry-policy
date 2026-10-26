# dsh-retry-policy —— 独立验收报告（verifier）

- 验收对象：`dsh-retry-policy@0.1.0`（已安装到 desktop profile，`link:` 到本工作区）
- 冻结契约：`SPEC.md`（§8 验收标准）；本报告按 §8 逐条出证据
- 验收方：teammate `verifier`（共享任务 `task-3`）
- 环境：macOS / Node v22.22.0 / Harness Web GUI `http://127.0.0.1:62484` / profile `~/.dsh/profiles/desktop`
- 结论时间：2026-10-26 17:31–17:45 (+08:00)
- 写作用域：本报告与 `verification/**` 由 verifier 写入；`lib/**`、`tests/**`、`package.json`、
  `cordis.patch.yml`、`locale/**`、`SPEC.md`、profile 目录**未被 verifier 修改**（profile 补丁由被验收插件的
  configEditor 在自己的 POST 保存路径上写入，验收结束已恢复原状，见 §4.6）

---

## 0. 被验收版本（哈希绑定，防止“验收后代码又变”）

本报告的所有结论绑定到下列内容（验收期间 `lib/**`、`tests/**`、`package.json`、`cordis.patch.yml`、`SPEC.md`
均未被任何人在 17:30 之后改动；只有 `README.md` 在 17:34 被**其它队友**更新过，与代码无关）：

| 文件 | mtime | sha256 |
|---|---|---|
| `lib/policy.js` | 16:36:22 | `c13125c2f3c3a23a0e19a6778e0de13fa74f60b00911bad14fa65a7e54d451d6` |
| `lib/host.js` | 16:41:56 | `6dd28d2e17095108ea9e0302a9a3a0b4def992857fa6a02e34a3cba96d1a7489` |
| `lib/client.js` | 16:44:45 | `3caf9e5cfdff255d2eeaa41e564c207bf75c778e154cae94b06358acf248ee47` |
| `tests/policy.test.mjs` | 16:40:14 | `d01110c4e7107824695438891d1e0572446d9825442df447f8fe925f24d45c31` |
| `tests/host.test.mjs` | 16:42:02 | `1829088a1959f6df20172b2a14aa66d3fdc878c970634bf175f7eb3d526767e9` |
| `tests/client.test.mjs` | 16:45:33 | `76555b6e3da3815fb89350c84daac9448ebfbdc0be4e7ef5e62f457a45395cd4` |
| `package.json` | 16:43:33 | `121b9a64b9e137ce58ddfdf9f757139c95161fe380ec2b0709c512b7e99b7b5f` |
| `cordis.patch.yml` | 16:29:17 | `ed6032009ff5d3c8d80dc6a9bcc6d240717efae611fdc6a654dc88dee5717037` |
| `SPEC.md` | 16:43:33 | `c300aa372b969a8c75201fae25cb13621507e4bdb3642c5e35923bf6cfcabf87` |

> 任何上述文件在此之后被修改，本报告的通过结论即作废、需重跑三个脚本。

---

## 1. 结论表

| # | SPEC §8 验收条目 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | `node --check` 三文件 + `node --test tests/` 全绿 | ✅ 通过 | 3 个文件 OK；`# pass 111 / # fail 0`（`artifacts/D-01-node-check-and-tests.txt`） |
| 2 | `install_bundle` → `applied`、无 `failed`/`overridden` | ✅ 通过（旁证） | **未由 verifier 复跑**（`plugin_manager` 任何 action 都需审批，本会话审批被自动拒绝）。改以落盘产物 + 生效效果核验：profile `package.json` 有 `"dsh-retry-policy": "link:…"`、`dsh.profile.bundles` 末位为 `dsh-retry-policy`、`node_modules/dsh-retry-policy` symlink 可解析、patch 的两项效果都在（llm-retry 行 inactive + 本插件入口存在且路由应答） |
| 3 | Inspect 确认 `llm-retry` 行 disabled、`dsh-retry-policy` 行 active；`agent/request-error` 链上只有本插件一个重试执行器 | ✅ 通过 | `Config.listConfigs`：`include:llm-retry` → **inactive**；`include:dsh-retry-policy` → 存在（status `absent` = 未 export Config schema，非“未激活”，见 §4.3）；运行时 asar 源码阅读 + profile 内全部第三方插件扫描证明无第二个重试执行器 |
| 4 | `GET /dsh-retry-policy/policy` → `ok:true`、`editable:true`、默认 `maxRetries`、`effective.preview` 与 §3 一致 | ✅ 通过 | 200 + 头正确；`preview=[1000,2000,4000,8000,16000,32000,60000,60000,60000,60000]`，与 verifier 手算逐项相同（§4.4） |
| 5 | `POST {…dryRun:true}` 返回固定间隔预览；**dryRun 不得改动** profile 补丁 | ✅ 通过 | `[2000,2000,2000]`；dryRun 全流程前后 profile 补丁 `mtimeMs/size/ino/sha256` 完全一致（§4.5） |
| 6 | 真保存后 GET 返回新值、profile 补丁出现 `- id: dsh-retry-policy`；结束前恢复默认 | ✅ 通过 | 保存后 GET `maxRetries=3/strategy=fixed`；补丁出现整行新配置；`reset` 后 GET 回默认，**补丁 sha256 回到验收开始前的 `8270359e…`（逐字节一致）**（§4.6） |
| 7 | 客户端 client bundle 被 index 注入且含 `settings.section`；无浏览器控制时如实报“渲染未验证” | ⚠️ 部分通过（渲染与 index 未验证） | 静态证据齐（`exports["./client"]` 解析到 `lib/client.js`、`dsh.client` 声明、`__ModuleLoader__.load`、`settings.section` + 标题、主题令牌 16 个、0 硬编码颜色、0 官方 Client 包 import）；`GET /` → **401**、bundle 路由需启动期随机 `rev`（不可猜）→ **index 注入与渲染未验证** |
| 8 | 独立性：verifier 自算 2~3 组公式 + 构造非法配置 | ✅ 通过 | 手算 fixed/linear/exponential（含夹上限与抖动中值）全部命中；7 组非法配置全部 400 + `issues`（含任务要求的 4 类）（§4.4、§4.5） |
| 9 | 重试链路证据（事件形状 + 预算 + 延迟），并说明未覆盖部分 | ✅ 通过（假 ctx 探针） | verifier 自写假 ctx 探针 **28 项全过**：事件字段集逐字比对、预算计数/清零/按 provider 独立、耗尽必 `next()`、always 下游优先、Retry-After、取消排空；**未真实触发 provider 失败**（§4.9） |

任务描述里 7 条必做项 → 覆盖情况：#1→§4.4；#2→§4.5；#3→§4.5；#4→§4.6；#5→§4.3；#6→§4.7；#7→§4.9。

---

## 2. 我**没有**验证的部分（先说清楚）

| 项 | 为什么没验证 | 影响 |
|---|---|---|
| 浏览器里的设置页渲染、交互、明暗主题并排对比 | 无已连接页面控制；客户端 Inspect 查询必然超时；`GET /` 需要认证（401）。按 `references/verification.md`：不允许为截图去启动额外浏览器、改 HOME、找 token 或自造渲染器 | §8.7 的“渲染未验证”，只能给静态证据 |
| index（`window.__DSH_BOOT__`）里确实出现本插件 client bundle | 同上（401 拿不到 index）；bundle 直取路由是 `/plugins/<id>/client.js?rev=<启动期随机 nonce-序号>`，rev 运行时分配、无法推断（源码 `allocateInitialRevision()` 返回 `${nonce}-${counter}`） | “被 index 注入”属间接推断 |
| 真实 provider 失败触发的端到端重试（含真实 `Math.random` 抖动） | 未构造真实网络/上游失败；不想为验收打断用户会话 | 端到端链路只有假 ctx 探针覆盖 |
| `plugin_manager install_bundle` 的原始返回（`application: applied` 等） | 该 action 需审批，本会话审批被自动拒绝（verifier 权限固定，不能提权） | §8.2 只有旁证 |
| 并发保存 / 进程崩溃时 dryRun 不写盘 | 需要并发与故障注入，超出本次边界 | §4.5 结论限定“串行调用” |
| `previewDelays(config, count, rand)` 中 `count` 参数在 HTTP 层的暴露 | HTTP 契约里没有 count 入参（预览条数由 effective 决定），属纯函数，不构成风险 | 无 |

---

## 3. 验收方法与脚本（可复现）

| 脚本 | 作用 |
|---|---|
| `verification/scripts/independent-check.mjs` | HTTP 契约 + verifier 自算公式对拍 + 非法配置 + dryRun 不写盘（43 项） |
| `verification/scripts/real-save-restore.mjs` | 真保存 → 立刻读回 → 补丁落行 → `reset` 恢复（失败也会在 `finally` 强制恢复） |
| `verification/scripts/retry-chain-probe.mjs` | verifier 自写假 ctx 的重试引擎探针（28 项） |

复现（无需改动仓库内任何文件，也不需要审批）：

```bash
cd dsh-retry-policy
node --check lib/policy.js && node --check lib/host.js && node --check lib/client.js
node --test --test-timeout=60000 "tests/**/*.test.mjs"
node verification/scripts/independent-check.mjs      # 只读 + 只写 verification/artifacts
node verification/scripts/retry-chain-probe.mjs      # 只读 + 只写 verification/artifacts
node verification/scripts/real-save-restore.mjs      # 会真写 profile 补丁，但 finally 必恢复默认
```

> 注意：`node --test tests/` 在 Node 22.22 下会因参数被当成文件而失败，正确写法是
> `node --test "tests/**/*.test.mjs"`（SPEC §8.1 的字面写法按此解释）。

---

## 4. 逐条证据

### 4.1 §8.1 语法与测试（通过）

```console
$ node --check lib/policy.js && node --check lib/host.js && node --check lib/client.js
OK lib/policy.js
OK lib/host.js
OK lib/client.js

$ node --test --test-timeout=60000 "tests/**/*.test.mjs"
1..111
# tests 111
# suites 0
# pass 111
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5196.511125
EXIT=0
```

完整输出存档：`verification/artifacts/D-01-node-check-and-tests.txt`。

### 4.2 §8.2 安装结果（旁证通过）

```console
$ grep -n "dsh-retry-policy" ~/.dsh/profiles/desktop/package.json
  "dsh-retry-policy": "link:/Users/ljt/Documents/DS/临时对话/dsh-retry-policy",
        "dsh-retry-policy"            ← dsh.profile.bundles 末尾

$ ls -la ~/.dsh/profiles/desktop/node_modules/dsh-retry-policy
lrwxr-xr-x  dsh-retry-policy -> ../../../../Documents/DS/临时对话/dsh-retry-policy
```

生效效果（配置层）三项都在：`include:llm-retry → inactive`、`include:dsh-retry-policy` 入口存在、
精确路由 200。**未复跑 `install_bundle`**（审批受限）——不把 Lead 的原始返回当作自己的证据，仅作旁证。

### 4.3 §8.3 接管是否真的生效（判断式核查，通过）

判据一（官方重试器已关）：Inspect `Config.listConfigs`（三次分页，`total: 213`）中

```json
{ "id": "include:llm-retry", "patchId": "llm-retry", "name": "@deepseek-ai/dsh-llm-retry", "status": "inactive" }
```

判据二（本插件入口在活树上）：

```json
{ "id": "include:dsh-retry-policy", "patchId": "dsh-retry-policy", "name": "dsh-retry-policy",
  "status": "absent", "packageDir": "/Users/ljt/.dsh/profiles/desktop/node_modules/dsh-retry-policy" }
```

`status: absent` 的含义是**该入口没有 export Config schema**（SPEC §1 明确禁止 export `Config`），
不是“未激活”——被关掉的行显示 `inactive`，两者在同一份目录里可对照。真正的“活着”凭据是行为证据：

1. `GET /dsh-retry-policy/policy` → 200，且该路由是在 `apply()` 内部的 `ctx.inject(['webServer'], …)` 里注册的
   ⇒ `apply()` 确实执行过；
2. 响应 `editable:true` ⇒ `ctx.get('configEditor').entries()` 里含 `ctx.fiber.entry` ⇒ Loader 行在 configEditor 的
   可编辑入口表中；
3. `POST` 保存后**立刻** GET 就返回新值（`live` 是 `apply` 期捕获的闭包，未重载不可能变），
   且路由重注册没有撞上 `webServer` 的重复路径检查（否则旧 handler 会继续服务、GET 仍显示旧值）。

判据三（链上只有本插件一个重试执行器）：

- 运行时 asar 源码（`…/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm-retry/lib/index.js`，共 186 行，与
  `/Users/ljt/project/deepseek-harness/packages/llm/llm-retry/lib/index.js` 同源同内容）第 175 行
  `ctx.on("agent/request-error", …)` —— 官方唯一的重试执行器，已 inactive。
- 运行时 asar 的 `dsh-compaction-basic/lib/index.js` 第 861 行也有一个 `agent/request-error` 监听器，
  但第 862 行 `if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next();`
  ⇒ 它是上下文压缩恢复，不是重试执行器；且 live 状态为 `inactive`。
  `image-offload` 行 live 状态为 `absent`（源码里也搜不到该事件注册）。
- 全仓（排除 tests）只有两处非测试注册：`llm-retry`、`compaction-basic`；本插件是第三处且是唯一启用的。
- 另扫 profile 里**所有其它第三方插件**（dsh-quadrant / dsh-work-log / dsh-our-free-model / dsh-media-dock /
  dsh-plugin-whale-pet / @ywleeo/dsh-browser-mcp）：**0 处** `agent/request-error`。
- 事件契约（Inspect `Event.listEvents`，waterfall）本身也印证语义：
  “A listener returns `{ kind: 'retry' }` without calling `next()` when it owns recovery”。
  本插件在“不归自己管”与“预算耗尽”时都 `return next()`（探针 §4.9 实测 nextCalls=1）。

结论：**接管成立且自洽**（官方行关、本插件活、链上无第二个重试执行器）。

### 4.4 §8.4 + §8.8 公式手算对拍（通过）

原始 GET（节选）：

```console
$ curl -s -i http://127.0.0.1:62484/dsh-retry-policy/policy
HTTP/1.1 200 OK
content-type: application/json; charset=utf-8
cache-control: no-store

{"ok":true,"entryId":"dsh-retry-policy","editable":true,
 "config":{...,"maxRetries":10,"strategy":"exponential","initialDelayMs":1000,"maxDelayMs":60000,
           "multiplier":2,"jitterRatio":0.1,...},
 "effective":{"mode":"normal","strategy":"exponential","multiplier":2,"initialDelayMs":1000,
   "maxDelayMs":60000,"jitterRatio":0.1,"respectRetryAfter":true,"source":"config","maxRetries":10,
   "preview":[1000,2000,4000,8000,16000,32000,60000,60000,60000,60000]},
 "providerPolicies":[14 项，全部 normal/maxRetries=5],
 "strategyOptions":[fixed/linear/exponential],"codeOptions":[10 个码]}
```

**手算 1 —— 默认 exponential（initial=1000, maxDelay=60000, multiplier=2, jitter=0.1, rand=0.5）**
rand=0.5 ⇒ factor = 1 − 0.1 + 2×0.1×0.5 = **1.0**（抖动取中值即不改变 base）：

| attempt | base = 1000·2^(n−1) | 夹 maxDelayMs | ×factor | round | min(·,max) | 结果 |
|---|---|---|---|---|---|---|
| 1 | 1000 | 1000 | 1000.0 | 1000 | 1000 | 1000 |
| 2 | 2000 | 2000 | 2000.0 | 2000 | 2000 | 2000 |
| 3 | 4000 | 4000 | 4000.0 | 4000 | 4000 | 4000 |
| 4 | 8000 | 8000 | 8000.0 | 8000 | 8000 | 8000 |
| 5 | 16000 | 16000 | 16000.0 | 16000 | 16000 | 16000 |
| 6 | 32000 | 32000 | 32000.0 | 32000 | 32000 | 32000 |
| 7 | 64000 | **60000** | 60000.0 | 60000 | 60000 | 60000 |
| 8 | 128000 | **60000** | 60000.0 | 60000 | 60000 | 60000 |
| 9 | 256000 | **60000** | 60000.0 | 60000 | 60000 | 60000 |
| 10 | 512000 | **60000** | 60000.0 | 60000 | 60000 | 60000 |

手算 = `[1000,2000,4000,8000,16000,32000,60000,60000,60000,60000]` = 宿主返回 ✅

**手算 2 —— fixed（initial=2000, maxRetries=3）**：base 恒为 2000，无一被夹，factor=1.0（默认 jitter 0.1）⇒
`[2000,2000,2000]` = 宿主返回 ✅（SPEC §8.5 指定用例）

**手算 3 —— linear（initial=1500, maxRetries=4, maxDelayMs=5000, jitterRatio=0.2, rand=0.5）**
factor = 1 − 0.2 + 2×0.2×0.5 = 1.0：

| attempt | base = 1500·n | 夹 5000 | 结果 |
|---|---|---|---|
| 1 | 1500 | 1500 | 1500 |
| 2 | 3000 | 3000 | 3000 |
| 3 | 4500 | 4500 | 4500 |
| 4 | 6000 | **5000** | 5000 |

手算 = `[1500,3000,4500,5000]` = 宿主返回 ✅

**手算 4 —— exponential 夹上限（initial=700, multiplier=3, maxDelayMs=20000, maxRetries=12, jitter=0.25）**
预览条数 = min(12,10) = 10；attempt 5 起 700·3^4=56700 被夹到 20000：
手算 = `[700,2100,6300,18900,20000,20000,20000,20000,20000,20000]` = 宿主返回 ✅

**抖动非中值（白盒核对实现 vs 手算）**：policy `exponential/1000/60000/0.25/2`

| attempt | rand | 手算 | 实现 |
|---|---|---|---|
| 2 | 0.0 | 2000×0.75 = 1500 | 1500 ✅ |
| 2 | 0.5 | 2000×1.00 = 2000 | 2000 ✅ |
| 2 | 1.0 | 2000×1.25 = 2500 | 2500 ✅ |
| 7 | 1.0 | base 夹到 60000 → 75000 → **再夹回 60000** | 60000 ✅ |
| 1 | 0.333 | 1000×(0.75+0.1665)=916.5 → round **917** | 917 ✅ |
| 1（fixed 1ms, jitter=1, rand=0） | 0.0 | 1×0 = 0 → **max(·,1) = 1** | 1 ✅ |

**边界用例**：`maxRetries:0` → `preview:[]`（0 = 不重试）；`mode:'always'` → 10 条且 `effective` **无 `maxRetries` 字段**
（符合 SPEC §4“设置页不能假设 maxRetries 一定存在”）；`jitterRatio:0` → 无抖动。全部命中。

HTTP 契约附加核对：`PUT` → 405；`sec-fetch-site: cross-site` → 403；body 70 KiB → 413；非法 JSON → 400；
响应头 `content-type: application/json; charset=utf-8` + `cache-control: no-store` 齐全。

### 4.5 §8.5 / 任务 #2#3 dryRun 不写盘 + 非法配置（通过）

非法配置（全部 `dryRun:true`，均为 verifier 自构造）：

| 用例 | 请求 config | 结果 |
|---|---|---|
| 越界 | `{"maxRetries":5000}` | 400 `[{"field":"maxRetries","message":"maxRetries 必须在 0 ~ 1000 之间（当前 5000）"}]` |
| 越界 | `{"initialDelayMs":0}` | 400 `[{"field":"initialDelayMs","message":"initialDelayMs 必须在 1 ~ 3600000 之间（当前 0）"}]` |
| 未知键 | `{"bogus":1}` | 400 `[{"field":"bogus","message":"未知配置项 bogus"}]` |
| 类型错 | `{"maxRetries":"3"}` | 400 `[{"field":"maxRetries","message":"maxRetries 必须是整数"}]` |
| 跨字段 | `{"initialDelayMs":5000,"maxDelayMs":1000}` | 400 `[{"field":"maxDelayMs","message":"maxDelayMs 不能小于 initialDelayMs"}]` |
| 空码表 | `{"retryableCodes":[]}` | 400 `[{"field":"retryableCodes","message":"retryableCodes 不能为空"}]` |
| 枚举错 | `{"strategy":"quadratic"}` | 400 `[{"field":"strategy","message":"strategy 只能是 fixed / linear / exponential"}]` |

**dryRun 不写盘**（43 项脚本里覆盖全部 dryRun 调用，含 7 组非法 + 6 组合法预览）：

```console
before mtimeMs=1793003099290.262 size=2568 ino=378968035 sha256=8270359ea973c912d4fc0c9ee8f1e562ae85813466fc61e2d817f61e88e90379
after  mtimeMs=1793003099290.262 size=2568 ino=378968035 sha256=8270359ea973c912d4fc0c9ee8f1e562ae85813466fc61e2d817f61e88e90379
unchanged=true
```

`mtimeMs` 连小数位都相同 ⇒ 文件既没被重写也没被 touch（仅比 sha256 更强）。dryRun 之后 GET 仍为默认配置。
汇总：`artifacts/A-summary.json`（total 43 / failed 0）；单例原始响应见 `artifacts/A-0*.json`、`A-1*.json`。

### 4.6 §8.6 真保存 → 读回 → 补丁落行 → 恢复默认（通过）

验收开始时已把 profile 补丁与 package.json 只读备份到 `verification/artifacts/`。

```console
[snapshot BEFORE-SAVE] mtimeMs=1793003099290.262 size=2568 sha256=8270359ea973c912d4fc0c9ee8f1e562ae85813466fc61e2d817f61e88e90379
[GET before] status=200 maxRetries=10 strategy=exponential
[profile 补丁里是否已有 dsh-retry-policy 行] 0 行

$ curl -X POST …/dsh-retry-policy/policy -d '{"config":{"enabled":true,"mode":"inherit","maxRetries":3,
      "strategy":"fixed","initialDelayMs":2000,"maxDelayMs":60000,"multiplier":2,"jitterRatio":0.1,
      "retryableCodes":["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"],"respectRetryAfter":true}}'
{"ok":true,"saved":true,"editable":true,
 "config":{…"maxRetries":3,"strategy":"fixed","initialDelayMs":2000…},
 "effective":{"mode":"normal","strategy":"fixed","source":"config","maxRetries":3,"preview":[2000,2000,2000]}}

[GET after save] status=200 config={…"maxRetries":3,"strategy":"fixed","initialDelayMs":2000…}
[GET after save] providerPolicies n=14          ← 重载后没有重复/丢失
[读回是否等于新值] true
[snapshot AFTER-SAVE] mtimeMs=1793007624414.80 size=2925 sha256=ba8a3992…   ← 文件确实被写

[profile 补丁 dsh-retry-policy 行内容]
- id: dsh-retry-policy
  name: dsh-retry-policy
  config:
    enabled: true
    mode: inherit
    maxRetries: 3
    strategy: fixed
    initialDelayMs: 2000
    maxDelayMs: 60000
    multiplier: 2
    jitterRatio: 0.1
    retryableCodes:
      - EMPTY_RESPONSE
      - RATE_LIMIT
      - SERVER
      - TIMEOUT
      - TRANSPORT
    respectRetryAfter: true
```

重载判据：`live` 是 `apply` 期捕获的闭包，GET 立刻返回 3/fixed ⇒ 本插件被 Loader 重载且路由被干净地重注册
（若旧路由未摘除，`webServer.register` 会撞重复路径并只记 warn，旧 handler 会继续返回 10/exponential；
实测没有这种情况）。日志文件不可得（`~/.dsh` 下无 log 文件），故以行为为证。

恢复默认：

```console
$ curl -X POST …/dsh-retry-policy/policy -d '{"reset":true}'
{"ok":true,"saved":true,"editable":true,"config":{…默认值…},"effective":{…"maxRetries":10,
 "preview":[1000,2000,4000,8000,16000,32000,60000,60000,60000,60000]}}

[GET after restore] status=200
[GET after restore] config={"enabled":true,"mode":"inherit","maxRetries":10,"strategy":"exponential",
 "initialDelayMs":1000,"maxDelayMs":60000,"multiplier":2,"jitterRatio":0.1,
 "retryableCodes":["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"],"respectRetryAfter":true}
[GET after restore] effective={"mode":"normal","strategy":"exponential",…,"maxRetries":10,
 "preview":[1000,2000,4000,8000,16000,32000,60000,60000,60000,60000]}
[恢复后 config === defaults] true
[恢复后 profile 补丁 dsh-retry-policy 行内容]   ← 空：configEditor 把等于继承值的行整条删掉了
[恢复后补丁 sha256 是否回到保存前] true
=== restored=true failed=false ===
```

**最终状态复核**（验收结束时）：

```console
$ shasum -a 256 artifacts/profile-cordis.patch.yml.before ~/.dsh/profiles/desktop/cordis.patch.yml
8270359ea973c912d4fc0c9ee8f1e562ae85813466fc61e2d817f61e88e90379  …/profile-cordis.patch.yml.before
8270359ea973c912d4fc0c9ee8f1e562ae85813466fc61e2d817f61e88e90379  ~/.dsh/profiles/desktop/cordis.patch.yml
$ diff artifacts/profile-cordis.patch.yml.before ~/.dsh/profiles/desktop/cordis.patch.yml && echo IDENTICAL
IDENTICAL
$ curl -s http://127.0.0.1:62484/dsh-retry-policy/policy   → 默认值 + 默认 preview（见 artifacts/F-01-get-final.raw.txt）
```

⇒ 用户的 profile 补丁**没有留下任何残留**（不含 `- id: dsh-retry-policy` 行，sha256 与验收开始时逐字节一致）。
恢复后状态另存为 `artifacts/B-profile-patch.after-restore.yml` / `.final.yml` 与 `artifacts/F-01-get-final.raw.txt`（17:43 抓取，默认值）。

> **⚠️ 验收后状态变动（第三方，非 verifier）**：17:46:18（我的恢复完成、并且已验证逐字节还原之后）profile 补丁
> **被另一个 agent/页面改动**，新增了：
>
> ```yaml
> - id: dsh-retry-policy
>   name: dsh-retry-policy
>   config:
>     …（其余全为默认值）…
>     respectRetryAfter: false
> ```
>
> 影响：`GET` 现在返回 `config.respectRetryAfter=false`（其余默认），补丁 sha256 =
> `5e3ef65e33b127a954d87c834adf6315e5386087201fa760a62091875cd2eebc`，mtime 17:46:18。
> verifier 的脚本**只会 dryRun**，且当时我的保存/恢复流程已在 17:40:24 结束——这不是我的写入。
> 已第一时间 `send_message` 告警 Lead（见 §7），并**没有**擅自改动他人正在测的状态。
> 快照存 `artifacts/profile-patch.observed-17-49.yml`。

### 4.7 §8.7 客户端（静态证据通过；index 注入与渲染**未验证**）

静态证据（`artifacts/E-01-client-static.txt`）：

```console
$ node -e "const{createRequire}=require('module');const r=createRequire('/Users/ljt/.dsh/profiles/desktop/package.json');
          console.log(r.resolve('dsh-retry-policy/client'))"
/Users/ljt/Documents/DS/临时对话/dsh-retry-policy/lib/client.js      ← 包导出解析成功（client-modules 扫描前提）

package.json: exports["./client"]="./lib/client.js"；dsh.client={platform:"web",
              inject:["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-settings"]}

lib/client.js:1430  window.__ModuleLoader__.load({ id: … })
lib/client.js:1458  slots.inject('settings.section', () =>
lib/client.js:1461  name: 'settings.section',
lib/client.js:101   nav: '模型重试策略'
lib/client.js:102   title: '模型重试策略'
lib/client.js:1437  const React = require('react')      ← factory 只 require('react')

unique --dsw-alias-* token count: 16
hardcoded color hits: 0
@deepseek-ai import hits: 0

$ curl -o /dev/null -w '%{http_code}' …   # 客户端资源探测
401  /
401  /index.html
404  /plugins/??dsh-retry-policy/client.js
404  /plugins/dsh-retry-policy/client.js
```

未验证原因（如实报告）：index 需要认证（401 属**正常**，不是缺陷）；bundle 的真实 URL 形如
`/plugins/??<id>/client.js&rev=<rev>`，而 `rev` 由 `allocateInitialRevision()` 在启动期生成为
`${nonce}-${counter}`（不可推断），无认证就拿不到 index 里的那份 URL。因此本项只能给到
“包导出可解析 + client 半边源码含 `settings.section` 与标题 + 主题令牌合规”这一层，
**index 注入与页面渲染按 `references/verification.md` 记为“渲染未验证”**。

### 4.8 §8.8 独立性声明

- `verification/scripts/independent-check.mjs` 里的 §3 公式是 verifier 自己按 SPEC 重写的，**未 import** `lib/policy.js`；
  非法配置用例、dryRun 判据、手算期望值也都是自造（唯一白盒处是“抖动非中值”那 6 项，用 `delayFor` 做被测对象、
  期望值由 verifier 手算，已在报告中标注）。
- `verification/scripts/retry-chain-probe.mjs` 的假 ctx 是 verifier 自己写的（未复用 `tests/host.test.mjs`），
  首次运行时抓出的是**我自己探针的 6 处缺陷**（把 `llm/retry-started` 当成了 `llm/retry`）+ 1 处我自己写错的期望
  （误以为 `enabled:false` 会 `next()`），修正后 28 项全过。这些自纠过程也留在报告里，避免“全绿”掩盖方法问题。
- 作者测试（111 项）只作参考，不被当作结论。

### 4.9 §8.9 重试链路证据（假 ctx 探针 28 项全过）

`verification/scripts/retry-chain-probe.mjs`（配置：`maxRetries:2, strategy:fixed, initialDelayMs:1, maxDelayMs:50,
jitterRatio:0, retryableCodes:[SERVER,RATE_LIMIT]`，随机源注入 `()=>0.5`）：

| 类别 | 断言 | 实测 |
|---|---|---|
| 投影注册 | `key='llmRetry'`、`stateVersion=1` | ✅ |
| 事件形状（normal） | `llm/retry` 键集 `delayMs,failure,maxRetries,mode,policyKey,provider,retry,retryId,step,turn` | ✅ 与 SPEC §5.4 完全一致 |
| 事件形状（started） | `llm/retry-started` 键集 `retry,retryId,step,turn` | ✅ |
| 事件形状（always） | 同上去掉 `maxRetries` | ✅ |
| 决定重试 | 返回 `{kind:'retry'}` 且 **nextCalls=0**（真正短路） | ✅ |
| 预算计数 | retry=1→2，同串共用 `retryId` | ✅ |
| 预算耗尽 | `previousRetry >= maxRetries` → **nextCalls=1**（交回瀑布，非 `undefined`） | ✅ |
| 预算清零 | `step/start` 后 retry 回到 1 | ✅ |
| 预算隔离 | 换 provider → 各自从 1 计数；换 strategy → `policyKey` 变化（策略/倍数进键） | ✅ |
| 非管辖码 | `AUTH` → next() 且 0 事件 | ✅ |
| always 下游优先 | 下游给 `{kind:'retry'}` → 原样采纳且本插件不写事件；下游不管 → 兜底重试 | ✅ |
| Retry-After | 7ms（< maxDelay）→ `delayMs=7`（而非本地公式 1ms）；`respectRetryAfter:false` → 1ms；9999（> maxDelay）且 normal → next() | ✅ |
| enabled:false | 用内置常量继续执行：`maxRetries=5`、`delayMs=500(rand=0.5)`、nextCalls=0；非官方码仍 next() | ✅（符合 SPEC §4/§9） |
| 取消 | abort 后 3000ms 等待被立刻中断、返回 `undefined`、**不写 `llm/retry-started`** | ✅ |
| 卸载排空 | `Promise.allSettled(disposers)` 0ms 内结算；effect 标签 `…abort and drain active recovery`、`…policy route` | ✅ |
| 模型可见性 | 会话里只出现 `llm/retry` / `llm/retry-started` 两种事件 | ✅ |

**未覆盖**：没有真实触发一次 provider 失败（没有打真实上游错误、没有真实 `Math.random` 抖动、没有跨进程
持久化/恢复回放、没有与 agent-loop 真实调用链对接）。这部分只有源码级阅读（§4.3）与假 ctx 行为证据。

---

## 5. 存疑项与观察（不美化）

| # | 级别 | 内容 |
|---|---|---|
| S1 | ⚠️ 未验证 | 客户端 index 注入 + 页面渲染未验证（401 + bundle `rev` 不可推断 + 无已连接页面）。静态替代证据见 §4.7。**不能宣称“设置页可用”**，只能说“包裹与注册代码在位”。 |
| S2 | ⚠️ 未验证 | 未真实触发 provider 失败，端到端重试未经实测。 |
| S3 | ℹ️ 旁证 | `install_bundle` 的原始返回未由 verifier 复跑（审批受限）；§8.2 以落盘产物 + 生效效果为证。 |
| S4 | ✅ 已被 README 覆盖 | 本插件 `policyKey` 含 `strategy`/`multiplier`（SPEC §5.2 要求），与官方 llm-retry 的键格式不同 ⇒ **切换/升级到本插件后，旧会话里已记录的 `llmRetry` 预算键不会命中**，重试预算会从 1 重新计数。功能上安全（当前只有本插件一个执行器）。README 第 176–177 行（17:34 由其它队友更新）已如实写明该差异。 |
| S5 | ℹ️ 精度差异 | 官方 `localDelay` 不 round、无 `max(·,1)`、指数上限 1024；本插件按 SPEC §3 做 round + 至少 1ms + 上限 64。`maxDelayMs≤3.6e6` 时上限差异到不了（早就被夹住），实际差别 ≤1ms，仅在 `enabled:false`“回落内置”路径上体现为与官方精确值的±1ms 偏差。 |
| S6 | ✅ 已被 README 覆盖 | `enabled:false` **不等于“不重试”**，而是“用内置常量（5 次 / 500→10000 / 0.1）继续由本插件执行”。与 SPEC §4/§9 一致，README 第 172 行写明“关掉「接管」后回落为内置默认 5 次——不会出现「没人重试」的状态”；设置页开关文案“启用接管”仍可能让用户误读，属文案层面建议，非缺陷。 |
| S10 | ℹ️ 事实记录 | 验收进行中（17:34）`README.md` 被**其它队友**改动（8592→8994 字节，现哈希见 §0）；verifier 未改它。本报告对 README 的引用基于 17:44 版本。 |
| S11 | ⚠️ 需 Lead 处置 | 17:46:18 有**第三方**通过设置页/HTTP 保存了 `respectRetryAfter:false`，用户的 profile 补丁因此留下 `- id: dsh-retry-policy` 行（其余默认）。这不是 verifier 的写入（我的流程 17:40:24 已结束且已还原为逐字节一致）。验收结论不受影响，但**用户的配置当前不在默认状态**，需由改动方或 Lead 决定是否 `reset`。 |
| S7 | ℹ️ 覆盖范围 | 抖动只核对了中值（预览）与注入定值（0 / 0.5 / 1 / 0.333）；真实 `Math.random` 未做统计验证。 |
| S8 | ℹ️ 覆盖范围 | “dryRun 不写盘”结论限定于本会话的串行调用；并发保存与崩溃场景未验证。 |
| S9 | ℹ️ 环境事实 | `GET /` 返回 401 是认证要求，**不是缺陷**；精确路由 `/dsh-retry-policy/policy` 无需认证（已验证 200）。 |

**未发现“未通过”项**：SPEC §8 的 1–6、8、9 全部通过；第 7 条通过一半（静态），另一半按环境约束记为“未验证”。

---

## 6. 证据文件清单

| 文件 | 内容 |
|---|---|
| `verification/scripts/independent-check.mjs` | HTTP/公式/非法配置/dryRun 脚本（43 项） |
| `verification/scripts/real-save-restore.mjs` | 真保存→读回→恢复脚本（finally 兜底） |
| `verification/scripts/retry-chain-probe.mjs` | 自写假 ctx 重试引擎探针（28 项） |
| `verification/artifacts/A-summary.json` | 43 项断言与明细 |
| `verification/artifacts/A-01-get-default.json`、`A-02..A-16*.json` | GET 与 13 组 POST（6 合法预览 + 7 非法）原始响应 |
| `verification/artifacts/A-17-profile-snapshot-dryrun.txt` | dryRun 前后 profile 补丁快照（mtime/ino/sha256） |
| `verification/artifacts/B-real-save-restore.log.txt` | 真保存全流程原始日志 |
| `verification/artifacts/B-profile-patch.before-save.yml` / `.after-save.yml` / `.after-restore.yml` / `.final.yml` | 补丁四个阶段快照 |
| `verification/artifacts/B-01-get-after-save.json`、`B-02-get-after-restore.json` | 保存后 / 恢复后 GET 全文 |
| `verification/artifacts/C-retry-chain-probe.json` | 28 项链路探针明细 |
| `verification/artifacts/D-01-node-check-and-tests.txt` | 语法检查 + 111 项测试完整输出 |
| `verification/artifacts/E-01-client-static.txt` | 客户端静态证据与路由探测 |
| `verification/artifacts/F-01-get-final.raw.txt` | 验收结束时的最终 GET（默认值） |
| `verification/artifacts/profile-cordis.patch.yml.before`、`profile-package.json.before` | 验收开始前的 profile 只读备份 |

---

## 7. 与 Lead 的同步（17:50）

已 `send_message` 给 `lead`，明确列出：**无“未通过”项**；存疑/未验证 6 条（客户端 index+渲染、未真实触发 provider 失败、
install_bundle 未复跑、policyKey 差异、内置回落的 ±1ms 精度差、`enabled:false` 语义）；
以及 §4.6 里那条**第三方在 17:46:18 写入 `respectRetryAfter:false`** 的异常，请 Lead 确认归属并决定是否 `reset`。
verifier 未擅自修改该状态（写作用域限制 + 不打断他人测试）。

## 8. 附：证据文件补充

| 文件 | 内容 |
|---|---|
| `verification/artifacts/get-default.raw.txt` | 第一次 GET 的完整原始响应（含响应头，17:32） |
| `verification/artifacts/A-20-client-bundle.raw.txt` | `/plugins/dsh-retry-policy/client.js` 探测原始响应（404） |
| `verification/artifacts/profile-patch.observed-17-49.yml` | 17:46:18 第三方改动后的 profile 补丁快照 |
