package handler

import (
	"context"
	"errors"
	"net/http"
	"testing"
)

func TestBuildProviderModelsURLForGemini(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		"https://generativelanguage.googleapis.com":                                                    "https://generativelanguage.googleapis.com/v1beta/models",
		"https://generativelanguage.googleapis.com/v1beta":                                             "https://generativelanguage.googleapis.com/v1beta/models",
		"https://generativelanguage.googleapis.com/v1beta/models":                                      "https://generativelanguage.googleapis.com/v1beta/models",
		"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent":       "https://generativelanguage.googleapis.com/v1beta/models",
		"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent": "https://generativelanguage.googleapis.com/v1beta/models",
	}

	for input, want := range cases {
		got, err := buildProviderModelsURL("gemini", input)
		if err != nil {
			t.Fatalf("buildProviderModelsURL(%q) error = %v", input, err)
		}
		if got != want {
			t.Fatalf("buildProviderModelsURL(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestBuildProviderModelsURLRejectsLoopback(t *testing.T) {
	t.Parallel()

	if _, err := buildProviderModelsURL("codex", "http://127.0.0.1:11434"); err == nil {
		t.Fatal("buildProviderModelsURL() error = nil, want loopback rejection")
	}
}

func TestBuildProviderModelsURLRejectsIPv4MappedLoopback(t *testing.T) {
	t.Parallel()

	if _, err := buildProviderModelsURL("codex", "http://[::ffff:127.0.0.1]:11434"); err == nil {
		t.Fatal("buildProviderModelsURL() error = nil, want IPv4-mapped loopback rejection")
	}
}

func TestFetchProviderModelsRejectsUnsafeURL(t *testing.T) {
	t.Parallel()

	_, err := FetchProviderModels(context.Background(), ProviderModelsRequestBody{
		Type:    "codex",
		BaseURL: "http://127.0.0.1:11434",
		APIKey:  "test-key",
	})
	if err == nil {
		t.Fatal("FetchProviderModels() error = nil, want unsafe URL rejection")
	}
	var statusErr *HTTPStatusError
	if !errors.As(err, &statusErr) {
		t.Fatalf("FetchProviderModels() error = %T, want *HTTPStatusError", err)
	}
	if statusErr.Status != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", statusErr.Status, http.StatusBadRequest)
	}
}
