# v2 协议迁移与 v1 移除计划

本文档记录 v1 → v2（WebSocket+Protobuf 统一线协议）迁移的现状、观察指标
与最终删除 v1 的操作清单。协议合同见 [protocols.md](./protocols.md)。

## 迁移现状

| 组件 | 状态 |
|---|---|
| Gateway v2 服务端（`internal/protocol/pbws`，三链路） | ✅ 已上线，与 v1 并行服务 |
| 内嵌 WebUI | ✅ 已切换 v2（与网关同版本发布，lockstep） |
| 桌面端 Rust 客户端 | ✅ 新版走 v2，握手层失败自动回退 gRPC（兼容旧网关） |
| v1 弃用标记 | ✅ Go `// Deprecated:` / Rust `#[deprecated]` / TS `@deprecated` / proto `option deprecated` |
| v1 运行时打点 | ✅ `/api/status` → `protocol_usage`，v1 连接建立打 WARN 日志 |

## 版本偏斜矩阵

| 客户端 | 网关 | 行为 |
|---|---|---|
| 旧浏览器标签页（v1 bundle） | 新网关 | 继续走 `/ws` v1，正常工作 |
| 新内嵌 WebUI | 新网关 | 走 `/ws/v2`（构建即 lockstep，不存在新 UI 配旧网关） |
| 新桌面端 | 旧网关（无 `/ws/v2/agent`） | 握手 404 → 同一次连接尝试内回退 gRPC；每次重连先试 v2 |
| 新桌面端 | 新网关 | 走 `/ws/v2/agent` |
| 旧桌面端 | 新网关 | 继续走 gRPC v1，正常工作 |

鉴权被拒（`ServerHello{ok:false}`）不触发回退——那是配置错误，不是版本偏斜。

## 删除 v1 的前置条件

1. `/api/status` 的 `protocol_usage` 在一个完整观察窗（建议 ≥ 2 个桌面端
   发版周期）内满足：
   - `v1_ws_connections_total` / `v1_ws_requests_total` 不再增长；
   - `v1_grpc_agent_connects_total` / `v1_grpc_terminal_connects_total` 不再增长；
   - `v1_ws_connections_active` 与 `v1_grpc_agent_active` 持续为 0。
2. 桌面端自动更新覆盖率达标（旧版桌面端不再活跃）。
3. 网关日志中 `deprecated v1 ... established` WARN 不再出现。

## 删除清单（未来版本执行）

Go 网关：

- [ ] 删除 `internal/server/websocket*.go` 全部 v1 文件（envelope/路由表/
      16 个 handler/payloads/terminal_stream/roundtrip 残留）及其测试
- [ ] 删除 `internal/server/grpc.go` 与 `cmd/gateway` 中 gRPC 监听、TLS、
      keepalive、拦截器（`internal/auth` 的 gRPC 部分）装配
- [ ] 删除 `internal/chatwire` 中仅 v1 需要的 JSON 塑形（注意：入口塑形被
      v2 `payload_json` 复用，需先甄别）
- [ ] `http.go` 移除 `/ws`、`/ws/terminal` 路由与 `?terminal=1` 分支
- [ ] `proto/v1/gateway.proto` 删除 `service AgentGateway`（**消息全部保留**，
      它们是 v2 的载荷）；`buf generate`
- [ ] `go.mod` 移除 `google.golang.org/grpc`（确认无其他引用）
- [ ] `--grpc-addr` 等 gRPC 配置项先转弃用 no-op 一个版本，再删除
- [ ] 移除 `.golangci.yml` 中 v1 路径的 SA1019 豁免
- [ ] 移除 `observability/protousage.go` 中 v1 计数器

桌面端 Rust：

- [ ] 删除 `connect_and_serve_grpc`、`build_grpc_url`、`build_endpoint`、
      `insert_bearer_metadata` 与 gRPC 终端流及回退调度分支
- [ ] `Cargo.toml` 移除 `tonic`/`tonic-prost` 的 transport 依赖
      （prost 生成仍需要 `tonic-prost-build` 或改为纯 `prost-build`）

WebUI：

- [ ] 删除标记为 `@deprecated` 的 v1 线格式残留类型/工具

文档：

- [ ] `protocols.md` 删除 v1 附录；本文件归档
