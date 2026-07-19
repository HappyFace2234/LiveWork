package observability

import "sync/atomic"

// ProtoUsage 统计 v1（已弃用）与 v2 协议链路使用量：进程内原子计数，经 /api/status 的
// protocol_usage 字段暴露；v1 计数停增且 active 归零即可安全删除 v1 代码。
type ProtoUsage struct {
	V1WSConnectionsTotal         atomic.Int64
	V1WSConnectionsActive        atomic.Int64
	V1WSRequestsTotal            atomic.Int64
	V1TerminalWSConnectionsTotal atomic.Int64
	V1GRPCAgentConnectsTotal     atomic.Int64
	V1GRPCAgentActive            atomic.Int64
	V1GRPCTerminalConnectsTotal  atomic.Int64

	V2BrowserConnectionsTotal  atomic.Int64
	V2BrowserConnectionsActive atomic.Int64
	V2BrowserRequestsTotal     atomic.Int64
	V2AgentConnectsTotal       atomic.Int64
	V2AgentActive              atomic.Int64
	V2TerminalConnectsTotal    atomic.Int64
}

// Usage 是进程级单例；各协议层直接打点。
var Usage ProtoUsage

// Snapshot 导出当前计数（键名即对外 JSON 字段名）。
func (u *ProtoUsage) Snapshot() map[string]int64 {
	return map[string]int64{
		"v1_ws_connections_total":          u.V1WSConnectionsTotal.Load(),
		"v1_ws_connections_active":         u.V1WSConnectionsActive.Load(),
		"v1_ws_requests_total":             u.V1WSRequestsTotal.Load(),
		"v1_terminal_ws_connections_total": u.V1TerminalWSConnectionsTotal.Load(),
		"v1_grpc_agent_connects_total":     u.V1GRPCAgentConnectsTotal.Load(),
		"v1_grpc_agent_active":             u.V1GRPCAgentActive.Load(),
		"v1_grpc_terminal_connects_total":  u.V1GRPCTerminalConnectsTotal.Load(),
		"v2_browser_connections_total":     u.V2BrowserConnectionsTotal.Load(),
		"v2_browser_connections_active":    u.V2BrowserConnectionsActive.Load(),
		"v2_browser_requests_total":        u.V2BrowserRequestsTotal.Load(),
		"v2_agent_connects_total":          u.V2AgentConnectsTotal.Load(),
		"v2_agent_active":                  u.V2AgentActive.Load(),
		"v2_terminal_connects_total":       u.V2TerminalConnectsTotal.Load(),
	}
}
