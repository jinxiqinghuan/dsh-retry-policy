# dsh-retry-policy —— 模型重试策略

> DSH（DeepSeek Harness）插件：**接管模型请求失败后的重试**，让「重试几次」和「每次等多久」
> 变成你可以随时改的设置，而不是写死的 5 次 + 固定指数退避。

- 宿主半边：可配置的重试执行器（挂在 agent loop 的 `agent/request-error` 瀑布上）
- 客户端半边：`设置 → 模型重试策略` 一整页可视化配置，保存即生效
- 兼容性：继续写官方同款的 `llm/retry` / `llm/retry-started` 事件和 `llmRetry` 会话投影，
  会话气泡里的「模型重试」节点、轨迹视图、会话格式迁移全部零改动

---

## 1. 它解决什么问题

DSH 默认的模型请求重试完全由 provider 适配器配置里的 `retryPolicy` 决定：

| 项 | 默认值 | 出处 |
|---|---|---|
| 模式 | `normal`（有限次） | `@deepseek-ai/dsh-llm` 的 `resolveRetryPolicy()` |
| 重试次数 | **5** | 同上（`DEFAULT_MAX_RETRIES = 5`） |
| 首次等待 / 上限 | 500 ms / 10 000 ms | 同上 |
| 抖动 | 10% | 同上 |
| 参与重试的失败码 | `EMPTY_RESPONSE` `RATE_LIMIT` `SERVER` `TIMEOUT` `TRANSPORT` | 同上 |

这份策略是适配器**注册路由时快照**下来的，运行期改不了；执行重试的
`@deepseek-ai/dsh-llm-retry` 自己也没有任何配置项
（它的 `Config` 只用来报错：`retryPolicy belongs under each provider configuration`）。

结果就是：**失败 5 次就放弃，等待曲线也改不了**。

本插件的做法：

```
bundle patch:
  ├─ id: llm-retry      disabled: true          # 关掉内置执行器
  └─ insert: dsh-retry-policy                    # 挂上本插件，由它接管
```

本插件读取自己的配置（次数 + 等待策略），复刻官方的判定顺序、事件字段集、会话投影与
「延迟可取消、释放时排空」语义，因此对上层完全透明。

---

## 2. 安装

### 2.1 从 GitHub 安装（推荐）

```bash
# 方式一：让 Agent 用插件管理器装（自动加进 profile 的 bundle 列表）
#   plugin_manager { action: "install_bundle", target: "github:jinxiqinghuan/dsh-retry-policy" }

# 方式二：dsh CLI
dsh plugin --profile desktop add "github:jinxiqinghuan/dsh-retry-policy"
```

- 仓库所属 GitHub 用户名为 `jinxiqinghuan`；fork / 迁移后把上面的用户名换掉即可。
- 锁定版本：`github:jinxiqinghuan/dsh-retry-policy#v0.1.0`（仓库里先打好 tag，见 CHANGELOG）。
- 安装时先做 GitHub 连接检查，再交给 pnpm；网络受限时先配好代理。
- 装完刷新页面（⌘R）——客户端半边需要页面重载一次才会出现在「设置」里。

### 2.2 本地开发安装

已经装进 `desktop` profile 的话可以跳过。

```bash
# 方式一：让 Agent 用插件管理器装（推荐）
#   plugin_manager { action: "install_bundle", target: "/绝对路径/dsh-retry-policy" }

# 方式二：命令行
dsh plugin --profile desktop add "link:/绝对路径/dsh-retry-policy"
```

宿主半边由 `dsh-hmr` 监听 profile `package.json` 自动重算，通常无需重启 app。

> 注意：本插件的补丁会把内置的 `llm-retry` 行置为 `disabled: true`。
> 卸载本 bundle 后该行会恢复启用（回到内置 5 次）。

---

## 3. 配置

### 3.1 设置页（推荐）

`设置（左下角齿轮）→ 模型重试策略`：

1. **接管开关** —— 关掉 = 退回内置默认策略（normal / 5 次 / 500→10000 / 抖动 10%）。
2. **无限重试**（`mode: always`）—— 一直重试到成功、取消或插件卸载；对永久性错误
   （鉴权、配额、参数非法）也会一直重试，成本与延迟自负。
3. **重试次数** `maxRetries`（0~1000，不含首次请求）。
4. **等待策略**：固定间隔 / 线性增长 / 指数退避。
5. **初始等待 / 最大等待 / 增长倍数 / 抖动比例**。
6. **参与重试的失败码**多选。
7. **优先听提供方 `Retry-After`**。
8. **实时预览**：`第 1 次 1.0s → 第 2 次 2.0s → …`，含累计等待。

保存经 `configEditor` 写进 profile 的用户层补丁（`cordis.patch.yml`），
走 Loader 正常重载路径即时生效，重启后仍在。

### 3.2 直接改补丁

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: dsh-retry-policy
  name: dsh-retry-policy
  config:
    enabled: true
    mode: inherit          # inherit | always
    maxRetries: 10
    strategy: exponential  # exponential | linear | fixed
    initialDelayMs: 1000
    maxDelayMs: 60000
    multiplier: 2
    jitterRatio: 0.1
    retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]
    respectRetryAfter: true
```

### 3.3 字段速查

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | `false` = 不接管，用内置默认策略 |
| `mode` | `inherit` \| `always` | `inherit` | `always` = 强制无限重试（提供方本身声明 `always` 时也会无限） |
| `maxRetries` | int 0~1000 | `10` | 有限模式下的重试预算 |
| `strategy` | `exponential` \| `linear` \| `fixed` | `exponential` | 等待曲线 |
| `initialDelayMs` | int 1~3 600 000 | `1000` | 首次等待 |
| `maxDelayMs` | int ≥ `initialDelayMs` | `60000` | 单次等待上限 |
| `multiplier` | number 1~100 | `2` | 仅指数策略使用 |
| `jitterRatio` | number 0~1 | `0.1` | 对称抖动比例 |
| `retryableCodes` | string[] | 官方 5 个码 | 非空、去重 |
| `respectRetryAfter` | boolean | `true` | 提供方 `Retry-After` 不超过 `maxDelayMs` 时优先采纳 |

---

## 4. 等待时间策略（公式）

```
第 n 次重试（n 从 1 开始）：
  fixed:        base = initialDelayMs
  linear:       base = initialDelayMs * n
  exponential:  base = initialDelayMs * multiplier ** min(n - 1, 64)

  base     = min(base, maxDelayMs)
  jittered = base * (1 - jitterRatio + 2 * jitterRatio * rand)   # rand ∈ [0,1)
  delay    = clamp(round(jittered), 1, maxDelayMs)
```

示例（`initialDelayMs = 1000`、`maxDelayMs = 60000`、`jitterRatio = 0`）：

| 策略 | 第 1~6 次等待（秒） |
|---|---|
| `fixed` | 1, 1, 1, 1, 1, 1 |
| `linear` | 1, 2, 3, 4, 5, 6 |
| `exponential`（×2） | 1, 2, 4, 8, 16, 32 |

抖动取中值时预览显示的就是上表。

---

## 5. 行为细节

- **重试边界**：只重试 agent 回合内的模型请求（agent loop 的 step 边界）。
  直接调用 `ctx.llm.stream()` 的消费者仍是单次尝试——这是官方架构限制，不是本插件的取舍。
- **预算计数**：按 `(provider, 策略)` 独立计数，`step/start`、`turn/end` 时清零，
  与官方一致。更换 provider 或改了策略会开一段新的计数历史。
- **对模型不可见**：重试事件、等待、失败片段都不会进入模型可见历史；
  重试在同一回合、同一份持久历史之上重跑该 step。
- **持久优先**：每次重试在等待之前先写 `llm/retry` 事件，等待结束后、真正重试前写
  `llm/retry-started`，所以崩溃/取消都不会留下看不见的待办重试。
- **可取消**：会话取消或插件卸载会立刻中断等待并排空在途恢复；
  卸载后捕获的旧回调 fail closed。
- **不抢占别人的恢复路径**：`agent/request-error` 是瀑布，链上还有压缩类恢复
  （`CONTEXT_WINDOW_EXCEEDED`、`IMAGE_OFFLOAD_REQUIRED`）。本插件只有在**自己决定重试**时
  才短路，其余情况一律 `return next()`，把这些失败交回下游。
- **HTTP 接口**（设置页使用，同源）：
  - `GET /dsh-retry-policy/policy` → 当前配置、默认值、生效策略与等待预览、提供方策略提示
  - `POST /dsh-retry-policy/policy`，body `{ config, dryRun?: true }` / `{ reset: true }`

---

## 6. 已知边界

- 无限重试（`mode: always`）会对永久性错误一直重试，务必自己控制成本。
- 本插件的预算与压缩等其他恢复机制的预算互不相通（官方行为）。
- `fixed` / `linear` 是本插件自有的等待曲线；官方只支持带上下界的指数退避，
  所以这两条曲线在卸载本插件后不可用。
- 关掉「接管」后回落为内置默认 5 次——不会出现「没人重试」的状态。
- 设置页走的是宿主同源路由（与 `dsh-quadrant` 同款做法，只做了 `sec-fetch-site: cross-site` 拦截）：
  本机上的其它进程也能读写这份配置。它只能改写本插件的重试参数，不能执行代码，
  但如果你在意，可以不用设置页、直接手改 `cordis.patch.yml`。
- 会话记录里的 `llm/retry` 事件由本插件写入，字段与官方逐字节一致；
  但 `policyKey` 的内容会因多出 `strategy` / `multiplier` 而与官方不同（只影响分组，不影响界面）。

---

## 7. 文件结构

```
dsh-retry-policy/
├── .github/workflows/ci.yml  # CI：语法检查 + 测试 + 打包清单 dry-run
├── .gitignore / .gitattributes
├── package.json          # bundle + dsh.client 清单
├── cordis.patch.yml      # 关闭内置 llm-retry + 挂载本插件
├── icon.svg / locale/    # 展示资源
├── lib/policy.js         # 纯逻辑：配置校验、等待公式、生效策略解析
├── lib/host.js           # 宿主：重试引擎 + llmRetry 投影 + HTTP 路由
├── lib/client.js         # 客户端：设置页
├── tests/                # node --test
├── verification/         # 独立验收脚本与报告（artifacts/ 为机器相关产物，不入库）
└── SPEC.md               # 冻结接口契约（开发依据）
```

## 8. 开发与自检

```bash
cd dsh-retry-policy
npm run check    # node --check 三个文件
npm test         # node --test "tests/**/*.test.mjs"
```

`tests/client.test.mjs` 的 DOM 行为测试（C 段）需要 jsdom / react / react-dom：
`npm install` 装好 devDependencies 后会全量运行；取不到依赖时该段自动 skip，A/B 段照常跑。

CI（GitHub Actions）跑同一套检查，另加 `npm pack --dry-run` 校验发布内容。

License: MIT
