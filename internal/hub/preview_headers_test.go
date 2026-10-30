package hub

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPreviewCSPAllowsOnlyImagesFromBlob(t *testing.T) {
	x := setup(t)
	response := httptest.NewRecorder()
	x.h.Handler().ServeHTTP(response, httptest.NewRequest("GET", "/healthz", nil))
	policy := response.Header().Get("Content-Security-Policy")
	if !strings.Contains(policy, "img-src 'self' data: blob:") || !strings.Contains(policy, "script-src 'self';") || !strings.Contains(policy, "object-src 'none';") {
		t.Fatalf("unexpected preview CSP: %s", policy)
	}
}
