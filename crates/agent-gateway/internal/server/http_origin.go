package server

import (
	"net/http"

	"github.com/liveagent/agent-gateway/internal/protocol/shared"
)

// originAllowed delegates to the shared origin check (moved to
// internal/protocol/shared so the v2 protocol endpoints reuse it).
func originAllowed(r *http.Request) bool {
	return shared.OriginAllowed(r)
}
