package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
)

const maxProviderModelsResponseBytes = 2 << 20

type HTTPStatusError struct {
	Status  int
	Message string
}

func (e *HTTPStatusError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

type ProviderModelsResult struct {
	ContentType string
	Body        []byte
}

var codexModelsSuffixes = []string{
	"/chat/completions",
	"/responses",
	"/response",
}

func FetchProviderModels(
	ctx context.Context,
	req ProviderModelsRequestBody,
) (*ProviderModelsResult, error) {
	return fetchProviderModelsWithClient(ctx, req, newSafeOutboundHTTPClient(0))
}

func fetchProviderModelsWithClient(
	ctx context.Context,
	req ProviderModelsRequestBody,
	client outboundHTTPClient,
) (*ProviderModelsResult, error) {
	providerType := strings.TrimSpace(req.Type)
	baseURL := strings.TrimSpace(req.BaseURL)
	apiKey := strings.TrimSpace(req.APIKey)
	if baseURL == "" || apiKey == "" {
		return nil, &HTTPStatusError{
			Status:  http.StatusBadRequest,
			Message: "base_url and api_key are required",
		}
	}

	modelsURL, err := buildProviderModelsURL(providerType, baseURL)
	if err != nil {
		return nil, &HTTPStatusError{
			Status:  http.StatusBadRequest,
			Message: err.Error(),
		}
	}

	upstreamReq, err := http.NewRequestWithContext(ctx, http.MethodGet, modelsURL, nil)
	if err != nil {
		return nil, &HTTPStatusError{
			Status:  http.StatusBadRequest,
			Message: "invalid provider models URL",
		}
	}

	upstreamReq.Header.Set("Content-Type", "application/json")
	if providerType == "gemini" {
		upstreamReq.Header.Set("x-goog-api-key", apiKey)
	} else {
		upstreamReq.Header.Set("Authorization", "Bearer "+apiKey)
		upstreamReq.Header.Set("x-api-key", apiKey)
	}
	if providerType == "claude_code" {
		upstreamReq.Header.Set("anthropic-version", "2023-06-01")
	}

	resp, err := client.Do(upstreamReq)
	if err != nil {
		if isSafeOutboundBlockedError(err) {
			return nil, &HTTPStatusError{
				Status:  http.StatusBadRequest,
				Message: "provider models URL is not allowed",
			}
		}
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxProviderModelsResponseBytes))
	if err != nil {
		return nil, &HTTPStatusError{
			Status:  http.StatusBadGateway,
			Message: "failed to read provider model response",
		}
	}

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return nil, &HTTPStatusError{
			Status:  mapUpstreamProviderStatus(resp.StatusCode),
			Message: extractUpstreamErrorMessage(body, resp.Status),
		}
	}

	if !json.Valid(body) {
		return nil, &HTTPStatusError{
			Status:  http.StatusBadGateway,
			Message: "provider model response is not valid JSON",
		}
	}

	contentType := strings.TrimSpace(resp.Header.Get("Content-Type"))
	if contentType == "" {
		contentType = "application/json"
	}

	return &ProviderModelsResult{
		ContentType: contentType,
		Body:        body,
	}, nil
}

func buildProviderModelsURL(providerType string, baseURL string) (string, error) {
	normalizedBaseURL := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if normalizedBaseURL == "" {
		return "", errors.New("base_url is required")
	}

	switch providerType {
	case "claude_code", "codex", "gemini":
	default:
		return "", errors.New("unsupported provider type")
	}

	if providerType == "codex" {
		lower := strings.ToLower(normalizedBaseURL)
		for _, suffix := range codexModelsSuffixes {
			if strings.HasSuffix(lower, suffix) {
				normalizedBaseURL = normalizedBaseURL[:len(normalizedBaseURL)-len(suffix)]
				break
			}
		}
	}
	if providerType == "gemini" {
		lower := strings.ToLower(normalizedBaseURL)
		for _, suffix := range []string{":streamgeneratecontent", ":generatecontent"} {
			if strings.HasSuffix(lower, suffix) {
				normalizedBaseURL = normalizedBaseURL[:len(normalizedBaseURL)-len(suffix)]
				break
			}
		}
		if modelsIndex := strings.LastIndex(strings.ToLower(normalizedBaseURL), "/models"); modelsIndex >= 0 {
			afterModels := normalizedBaseURL[modelsIndex+len("/models"):]
			if afterModels == "" || strings.HasPrefix(afterModels, "/") {
				normalizedBaseURL = normalizedBaseURL[:modelsIndex]
			}
		}
	}

	parsed, err := url.Parse(normalizedBaseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("base_url must be an absolute URL")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("base_url cannot contain query parameters or fragments")
	}
	if err := validateParsedOutboundHTTPURL(parsed); err != nil {
		return "", errors.New("base_url is not allowed")
	}

	if providerType == "gemini" {
		normalizedPath := strings.TrimRight(parsed.Path, "/")
		if strings.HasSuffix(strings.ToLower(normalizedPath), "/models") {
			parsed.Path = normalizedPath
		} else if isGeminiVersionPath(normalizedPath) {
			parsed.Path = normalizedPath + "/models"
		} else {
			parsed.Path = normalizedPath + "/v1beta/models"
		}
		return parsed.String(), nil
	}

	if strings.HasSuffix(strings.TrimRight(parsed.Path, "/"), "/v1") {
		parsed.Path = strings.TrimRight(parsed.Path, "/") + "/models"
	} else {
		parsed.Path = strings.TrimRight(parsed.Path, "/") + "/v1/models"
	}

	return parsed.String(), nil
}

func isGeminiVersionPath(path string) bool {
	path = strings.TrimRight(strings.ToLower(path), "/")
	return path == "/v1" || path == "/v1beta" ||
		strings.HasSuffix(path, "/v1") || strings.HasSuffix(path, "/v1beta")
}

func mapUpstreamProviderStatus(status int) int {
	switch status {
	case http.StatusUnauthorized,
		http.StatusForbidden,
		http.StatusNotFound,
		http.StatusConflict,
		http.StatusTooManyRequests:
		return status
	default:
		return http.StatusBadGateway
	}
}

func extractUpstreamErrorMessage(body []byte, fallback string) string {
	text := strings.TrimSpace(string(body))
	if text == "" {
		return fallback
	}

	var payload any
	if err := json.Unmarshal(body, &payload); err == nil {
		if message := findStructuredErrorMessage(payload, 0); message != "" {
			return message
		}
	}

	return text
}

func findStructuredErrorMessage(value any, depth int) string {
	if depth > 4 || value == nil {
		return ""
	}

	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case []any:
		for _, item := range typed {
			if nested := findStructuredErrorMessage(item, depth+1); nested != "" {
				return nested
			}
		}
	case map[string]any:
		for _, key := range []string{"error", "message", "detail", "details", "errorMessage", "msg", "title"} {
			if nested := findStructuredErrorMessage(typed[key], depth+1); nested != "" {
				return nested
			}
		}
	}

	return ""
}
