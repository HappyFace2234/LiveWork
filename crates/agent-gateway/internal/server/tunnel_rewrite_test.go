package server

import (
	"net/http"
	"strings"
	"testing"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func TestTunnelResponseRewriteKindFor(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		method  string
		status  int
		headers http.Header
		want    tunnelResponseRewriteKind
	}{
		{
			name:   "html",
			method: http.MethodGet,
			status: http.StatusOK,
			headers: http.Header{
				"Content-Type": []string{"text/html; charset=utf-8"},
			},
			want: tunnelResponseRewriteHTML,
		},
		{
			name:   "javascript",
			method: http.MethodGet,
			status: http.StatusOK,
			headers: http.Header{
				"Content-Type": []string{"application/javascript"},
			},
			want: tunnelResponseRewriteNone,
		},
		{
			name:   "css",
			method: http.MethodGet,
			status: http.StatusOK,
			headers: http.Header{
				"Content-Type": []string{"text/css"},
			},
			want: tunnelResponseRewriteCSS,
		},
		{
			name:   "compressed response",
			method: http.MethodGet,
			status: http.StatusOK,
			headers: http.Header{
				"Content-Type":     []string{"text/html; charset=utf-8"},
				"Content-Encoding": []string{"gzip"},
			},
			want: tunnelResponseRewriteNone,
		},
		{
			name:   "head request",
			method: http.MethodHead,
			status: http.StatusOK,
			headers: http.Header{
				"Content-Type": []string{"text/html; charset=utf-8"},
			},
			want: tunnelResponseRewriteNone,
		},
		{
			name:   "json",
			method: http.MethodGet,
			status: http.StatusOK,
			headers: http.Header{
				"Content-Type": []string{"application/json"},
			},
			want: tunnelResponseRewriteNone,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			if got := tunnelResponseRewriteKindFor(tt.method, tt.status, tt.headers); got != tt.want {
				t.Fatalf("tunnelResponseRewriteKindFor() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestRewriteTunnelHTMLBodyPrefixesRootRelativeAttributes(t *testing.T) {
	t.Parallel()

	tunnel := tunnelRewriteTestSummary()
	input := strings.Join([]string{
		`<link rel="stylesheet" href="/styles.css" />`,
		`<script src='/app.js'></script>`,
		`<form action=/api/messages></form>`,
		`<a href="/api/health?check=1#ready">health</a>`,
		`<a href="//cdn.example.com/lib.js">cdn</a>`,
		`<a href="https://example.com/page">external</a>`,
		`<a href="/t/test-slug/already">already</a>`,
		`<a href="http://127.0.0.1:3100/api/showcase">absolute target</a>`,
		`<use xlink:href="/icons.svg#check"></use>`,
	}, "\n")

	body, changed := rewriteTunnelResponseBody([]byte(input), tunnel, tunnelResponseRewriteHTML)
	if !changed {
		t.Fatal("rewriteTunnelResponseBody() did not report a change")
	}
	output := string(body)

	assertContains(t, output, `href="/t/test-slug/styles.css"`)
	assertContains(t, output, `src="/t/test-slug/app.js"`)
	assertContains(t, output, `action="/t/test-slug/api/messages"`)
	assertContains(t, output, `href="/t/test-slug/api/health?check=1#ready"`)
	assertContains(t, output, `href="//cdn.example.com/lib.js"`)
	assertContains(t, output, `href="https://example.com/page"`)
	assertContains(t, output, `href="/t/test-slug/already"`)
	assertContains(t, output, `href="/t/test-slug/api/showcase"`)
	assertContains(t, output, `xlink:href="/t/test-slug/icons.svg#check"`)
	assertNotContains(t, output, `/t/test-slug/t/test-slug`)
}

func TestRewriteTunnelBodyStripsTargetBasePath(t *testing.T) {
	t.Parallel()

	tunnel := &gatewayv1.TunnelSummary{
		Slug:      "base-slug",
		TargetUrl: "http://127.0.0.1:3100/app",
	}
	input := strings.Join([]string{
		`<script src="/app/assets/main.js"></script>`,
		`<link rel="stylesheet" href="/app/styles.css" />`,
		`<a href="/api/health">root api</a>`,
	}, "\n")

	body, changed := rewriteTunnelResponseBody([]byte(input), tunnel, tunnelResponseRewriteHTML)
	if !changed {
		t.Fatal("rewriteTunnelResponseBody() did not report a change")
	}
	output := string(body)

	assertContains(t, output, `src="/t/base-slug/assets/main.js"`)
	assertContains(t, output, `href="/t/base-slug/styles.css"`)
	assertContains(t, output, `href="/t/base-slug/api/health"`)
	assertNotContains(t, output, `/t/base-slug/app/`)

	jsBody, changed := rewriteTunnelResponseBody(
		[]byte(`fetch("/app/api/health?check=1#ready")`),
		tunnel,
		tunnelResponseRewriteJavaScript,
	)
	if changed {
		t.Fatal("rewriteTunnelResponseBody() reported an unsafe JavaScript change")
	}
	assertContains(t, string(jsBody), `fetch("/app/api/health?check=1#ready")`)

	cssBody, changed := rewriteTunnelResponseBody(
		[]byte(`body { background: url(/app/images/bg.png); }`),
		tunnel,
		tunnelResponseRewriteCSS,
	)
	if !changed {
		t.Fatal("rewriteTunnelResponseBody() did not report a CSS change")
	}
	assertContains(t, string(cssBody), `url(/t/base-slug/images/bg.png)`)
}

func TestRewriteTunnelJavaScriptBodyDoesNotRewriteStrings(t *testing.T) {
	t.Parallel()

	tunnel := tunnelRewriteTestSummary()
	input := strings.Join([]string{
		`requestJson('/api/showcase')`,
		`fetch("/api/health?check=1")`,
		`const root = "/"`,
		`const external = "https://example.com/api"`,
		`const cdn = "//cdn.example.com/app.js"`,
		`const already = "/t/test-slug/api/health"`,
	}, "\n")

	body, changed := rewriteTunnelResponseBody([]byte(input), tunnel, tunnelResponseRewriteJavaScript)
	if changed {
		t.Fatal("rewriteTunnelResponseBody() reported an unsafe JavaScript change")
	}
	output := string(body)

	assertContains(t, output, `requestJson('/api/showcase')`)
	assertContains(t, output, `fetch("/api/health?check=1")`)
	assertContains(t, output, `const root = "/"`)
	assertContains(t, output, `const external = "https://example.com/api"`)
	assertContains(t, output, `const cdn = "//cdn.example.com/app.js"`)
	assertContains(t, output, `const already = "/t/test-slug/api/health"`)
	assertNotContains(t, output, `/t/test-slug/t/test-slug`)
}

func TestRewriteTunnelHTMLBodyUsesHTMLParsingBoundaries(t *testing.T) {
	t.Parallel()

	tunnel := tunnelRewriteTestSummary()
	input := strings.Join([]string{
		`<div style="background: url('/images/bg.png')"></div>`,
		`<script>const markup = '<a href="/api/not-real">';</script>`,
	}, "\n")

	body, changed := rewriteTunnelResponseBody([]byte(input), tunnel, tunnelResponseRewriteHTML)
	if !changed {
		t.Fatal("rewriteTunnelResponseBody() did not report a change")
	}
	output := string(body)

	assertContains(t, output, `style="background: url(&#39;/t/test-slug/images/bg.png&#39;)"`)
	assertContains(t, output, `<script>const markup = '<a href="/api/not-real">';</script>`)
	assertNotContains(t, output, `/t/test-slug/api/not-real`)
}

func TestRewriteTunnelCSSBodyPrefixesRootRelativeURLs(t *testing.T) {
	t.Parallel()

	tunnel := tunnelRewriteTestSummary()
	input := strings.Join([]string{
		`body { background: url(/images/bg.png); }`,
		`.icon { mask-image: url('/icons/check.svg'); }`,
		`.remote { background: url("https://example.com/bg.png"); }`,
		`.cdn { background: url("//cdn.example.com/bg.png"); }`,
		`.already { background: url(/t/test-slug/images/bg.png); }`,
	}, "\n")

	body, changed := rewriteTunnelResponseBody([]byte(input), tunnel, tunnelResponseRewriteCSS)
	if !changed {
		t.Fatal("rewriteTunnelResponseBody() did not report a change")
	}
	output := string(body)

	assertContains(t, output, `url(/t/test-slug/images/bg.png)`)
	assertContains(t, output, `url('/t/test-slug/icons/check.svg')`)
	assertContains(t, output, `url("https://example.com/bg.png")`)
	assertContains(t, output, `url("//cdn.example.com/bg.png")`)
	assertContains(t, output, `url(/t/test-slug/images/bg.png)`)
	assertNotContains(t, output, `/t/test-slug/t/test-slug`)
}

func TestRewriteTunnelCSSBodyIgnoresEmptyURLTokens(t *testing.T) {
	t.Parallel()

	tunnel := tunnelRewriteTestSummary()
	input := strings.Join([]string{
		`.empty { background: url(   ); }`,
		`.icon { background: url(/icons/check.svg); }`,
	}, "\n")

	body, changed := rewriteTunnelResponseBody([]byte(input), tunnel, tunnelResponseRewriteCSS)
	if !changed {
		t.Fatal("rewriteTunnelResponseBody() did not report a change")
	}
	output := string(body)

	assertContains(t, output, `url(   )`)
	assertContains(t, output, `url(/t/test-slug/icons/check.svg)`)
}

func TestParseTunnelPublicPathWithoutTrailingSlash(t *testing.T) {
	t.Parallel()

	slug, ok := parseTunnelPublicPathWithoutTrailingSlash("/t/test-slug")
	if !ok || slug != "test-slug" {
		t.Fatalf("parseTunnelPublicPathWithoutTrailingSlash() = %q, %v", slug, ok)
	}

	for _, path := range []string{"/t/test-slug/", "/t/test-slug/api", "/t/", "/api/test-slug"} {
		if slug, ok := parseTunnelPublicPathWithoutTrailingSlash(path); ok {
			t.Fatalf("parseTunnelPublicPathWithoutTrailingSlash(%q) = %q, true; want false", path, slug)
		}
	}
}

func TestRewriteTunnelLocationPreservesQueryAndFragment(t *testing.T) {
	t.Parallel()

	tunnel := tunnelRewriteTestSummary()
	if got := rewriteTunnelLocation("/api/health?check=1#ready", tunnel); got != "/t/test-slug/api/health?check=1#ready" {
		t.Fatalf("rewriteTunnelLocation root path = %q", got)
	}
	if got := rewriteTunnelLocation("http://127.0.0.1:3100/api/showcase#item", tunnel); got != "/t/test-slug/api/showcase#item" {
		t.Fatalf("rewriteTunnelLocation absolute target = %q", got)
	}
	if got := rewriteTunnelLocation("https://example.com/api#item", tunnel); got != "https://example.com/api#item" {
		t.Fatalf("rewriteTunnelLocation external = %q", got)
	}
}

func tunnelRewriteTestSummary() *gatewayv1.TunnelSummary {
	return &gatewayv1.TunnelSummary{
		Slug:      "test-slug",
		TargetUrl: "http://127.0.0.1:3100",
	}
}

func assertContains(t *testing.T, value string, needle string) {
	t.Helper()
	if !strings.Contains(value, needle) {
		t.Fatalf("expected output to contain %q, got:\n%s", needle, value)
	}
}

func assertNotContains(t *testing.T, value string, needle string) {
	t.Helper()
	if strings.Contains(value, needle) {
		t.Fatalf("expected output not to contain %q, got:\n%s", needle, value)
	}
}
