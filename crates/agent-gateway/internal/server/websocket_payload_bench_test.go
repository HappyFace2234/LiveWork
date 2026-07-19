package server

// v1（protojson 塑形 + JSON 编码）与 v2（proto 直接编码）响应路径的微基准对照，
// 用同一份 history.list 载荷。运行：
//
//	go test ./internal/server -bench BenchmarkResponseEncoding -benchmem -run '^$'

import (
	"encoding/json"
	"fmt"
	"testing"

	"google.golang.org/protobuf/proto"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func benchmarkHistoryListResponse() *gatewayv1.HistoryListResponse {
	conversations := make([]*gatewayv1.ConversationSummary, 0, 50)
	for i := 0; i < 50; i++ {
		conversations = append(conversations, &gatewayv1.ConversationSummary{
			Id:           fmt.Sprintf("conversation-%04d", i),
			Title:        fmt.Sprintf("对话标题 %d：关于 WebSocket 协议迁移的讨论", i),
			MessageCount: int32(20 + i),
			CreatedAt:    1_752_800_000 + int64(i)*3600,
			UpdatedAt:    1_752_800_000 + int64(i)*7200,
			ProviderId:   "builtin-codex",
			Model:        "gpt-5.4-mini",
			SessionId:    fmt.Sprintf("session-%04d", i),
			Cwd:          "/home/user/projects/example-workspace",
			IsPinned:     i%7 == 0,
		})
	}
	return &gatewayv1.HistoryListResponse{
		Conversations: conversations,
		TotalCount:    500,
	}
}

// BenchmarkResponseEncodingV1JSON 复刻 v1 出站路径：proto → 手工 map → JSON 信封编码。
func BenchmarkResponseEncodingV1JSON(b *testing.B) {
	resp := benchmarkHistoryListResponse()
	b.ReportAllocs()
	var lastSize int
	for b.Loop() {
		conversations := make([]map[string]any, 0, len(resp.GetConversations()))
		for _, conversation := range resp.GetConversations() {
			conversations = append(conversations, websocketConversationSummaryPayload(conversation))
		}
		payload := map[string]any{
			"conversations": conversations,
			"total_count":   resp.GetTotalCount(),
		}
		data, err := json.Marshal(websocketEnvelope{
			ID:      "bench-1",
			Type:    "response",
			Payload: payload,
		})
		if err != nil {
			b.Fatal(err)
		}
		lastSize = len(data)
	}
	b.ReportMetric(float64(lastSize), "wire-bytes")
}

// BenchmarkResponseEncodingV2Proto 为 v2 出站路径：信封装帧 + 一次 proto.Marshal。
func BenchmarkResponseEncodingV2Proto(b *testing.B) {
	resp := benchmarkHistoryListResponse()
	b.ReportAllocs()
	var lastSize int
	for b.Loop() {
		frame := &gatewayv2.WebServerFrame{
			RequestId: "bench-1",
			Payload: &gatewayv2.WebServerFrame_AgentResponse{
				AgentResponse: &gatewayv1.AgentEnvelope{
					RequestId: "bench-1",
					Payload: &gatewayv1.AgentEnvelope_HistoryListResp{
						HistoryListResp: resp,
					},
				},
			},
		}
		data, err := proto.Marshal(frame)
		if err != nil {
			b.Fatal(err)
		}
		lastSize = len(data)
	}
	b.ReportMetric(float64(lastSize), "wire-bytes")
}
