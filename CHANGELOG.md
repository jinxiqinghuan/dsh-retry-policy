# Changelog

## 0.1.0

- 首个版本：接管 DSH 的模型请求失败重试执行器（bundle patch 关闭内置
  `@deepseek-ai/dsh-llm-retry`），提供可配置的**重试次数**与**等待时间策略**。
- 等待策略：固定间隔 / 线性增长 / 指数退避，支持增长倍数、最大等待、抖动比例、
  是否优先听提供方 `Retry-After`。
- 继续写官方同款的 `llm/retry`、`llm/retry-started` 事件与 `llmRetry` 会话投影，
  会话界面/轨迹/会话格式迁移零改动。
- 设置页「设置 → 模型重试策略」可视化配置，保存经由 `configEditor` 写入 profile
  用户层补丁并即时生效。
- 宿主 HTTP 接口 `GET/POST /dsh-retry-policy/policy`（含 dryRun 预览与恢复默认）。
