package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"auto-switcher-pro/internal/license"
)

// SSE/Proxy route constants
const (
	healthRoutePath   = "/auto-switcher-pro/healthz"
	readyRoutePath    = "/auto-switcher-pro/readyz"
	sseProxyRoutePath = "/auto-switcher-pro/sse-proxy"
)

// HealthStatus represents the health check response.
type HealthStatus struct {
	Healthy         bool   `json:"healthy"`
	UpstreamLatency int64  `json:"upstream_latency_ms,omitempty"`
	ActivePools     int    `json:"active_pools"`
	LicenseStatus   string `json:"license"`
	Reason          string `json:"reason,omitempty"`
	Timestamp       string `json:"timestamp"`
}

// ReadyStatus represents the readiness check response.
type ReadyStatus struct {
	Ready  bool   `json:"ready"`
	Reason string `json:"reason,omitempty"`
}

// SSEProxyConfig holds configuration for the SSE proxy.
type SSEProxyConfig struct {
	UpstreamBaseURL   string // e.g., "https://generativelanguage.googleapis.com"
	HeartbeatInterval time.Duration
	ReadTimeout       time.Duration
	WriteTimeout      time.Duration
	IdleTimeout       time.Duration
}

// DefaultSSEProxyConfig returns production-ready defaults.
func DefaultSSEProxyConfig() SSEProxyConfig {
	return SSEProxyConfig{
		UpstreamBaseURL:   "https://generativelanguage.googleapis.com",
		HeartbeatInterval: 5 * time.Second,
		ReadTimeout:       120 * time.Second,
		WriteTimeout:      120 * time.Second,
		IdleTimeout:       150 * time.Second,
	}
}

// sseProxyHandler handles SSE streaming with keep-alive to prevent "terminated" errors.
type sseProxyHandler struct {
	config              SSEProxyConfig
	upstream            *url.URL
	client              *http.Client
	mu                  sync.RWMutex
	lastUpstreamLatency int64
}

// newSSEProxyHandler creates a new SSE proxy handler with production defaults.
func newSSEProxyHandler() *sseProxyHandler {
	config := DefaultSSEProxyConfig()
	upstream, _ := url.Parse(config.UpstreamBaseURL)
	return &sseProxyHandler{
		config:   config,
		upstream: upstream,
		client: &http.Client{
			Timeout: 0, // No client-level timeout; we handle via context
			Transport: &http.Transport{
				Proxy:                 http.ProxyFromEnvironment,
				MaxIdleConns:          100,
				MaxIdleConnsPerHost:   100,
				IdleConnTimeout:       90 * time.Second,
				TLSHandshakeTimeout:   10 * time.Second,
				ExpectContinueTimeout: 1 * time.Second,
			},
		},
	}
}

// SetUpstreamBaseURL allows dynamic configuration of upstream (e.g., for different providers).
func (h *sseProxyHandler) SetUpstreamBaseURL(baseURL string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if u, err := url.Parse(baseURL); err == nil {
		h.upstream = u
		h.config.UpstreamBaseURL = baseURL
	}
}

// GetUpstreamLatency returns the last measured upstream latency in milliseconds.
func (h *sseProxyHandler) GetUpstreamLatency() int64 {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.lastUpstreamLatency
}

// ServeHTTP handles the SSE proxy request with keep-alive heartbeat.
func (h *sseProxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Only allow GET for SSE streaming
	if r.Method != http.MethodGet {
		h.writeErrorResponse(w, http.StatusMethodNotAllowed, "method_not_allowed", "only GET allowed for SSE proxy")
		return
	}

	// Verify license allows proxy access
	licStatus := license.GetLicenseStatus()
	if !isLicenseValid(licStatus) {
		h.writeErrorResponse(w, http.StatusPaymentRequired, "license_required", "valid license required for SSE proxy")
		return
	}

	// Critical SSE headers to prevent proxy/load balancer buffering and timeouts
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // Disable nginx buffering
	if origin := r.Header.Get("Origin"); origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
	}
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

	flusher, ok := w.(http.Flusher)
	if !ok {
		h.writeErrorResponse(w, http.StatusInternalServerError, "streaming_not_supported", "response writer does not support flushing")
		return
	}

	// Build upstream URL with original path and query
	targetURL := h.buildUpstreamURL(r)

	// Create upstream request with context
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	upstreamReq, err := http.NewRequestWithContext(ctx, r.Method, targetURL.String(), r.Body)
	if err != nil {
		h.writeErrorResponse(w, http.StatusBadGateway, "bad_gateway", "failed to create upstream request: "+err.Error())
		return
	}

	// Copy headers, but manage hop-by-hop headers
	copyProxyHeaders(upstreamReq.Header, r.Header)

	// Start timing for health metrics
	start := time.Now()

	// Make upstream request
	resp, err := h.client.Do(upstreamReq)
	if err != nil {
		// Record latency even on failure
		h.mu.Lock()
		h.lastUpstreamLatency = time.Since(start).Milliseconds()
		h.mu.Unlock()

		// Determine error code for Pi retry logic
		statusCode := classifyUpstreamError(err)
		h.writeErrorResponse(w, statusCode, "upstream_error", err.Error())
		return
	}
	defer resp.Body.Close()

	// Record successful latency
	h.mu.Lock()
	h.lastUpstreamLatency = time.Since(start).Milliseconds()
	h.mu.Unlock()

	// Copy response headers (excluding hop-by-hop)
	copyProxyHeaders(w.Header(), resp.Header)
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	// Write status code
	w.WriteHeader(resp.StatusCode)

	// Heartbeat ticker to prevent "terminated" (socket cutoff) errors
	heartbeat := time.NewTicker(h.config.HeartbeatInterval)
	defer heartbeat.Stop()

	// Channel for upstream data
	dataCh := make(chan []byte, 100)
	errCh := make(chan error, 1)

	// Goroutine to read from upstream
	go func() {
		buf := make([]byte, 32*1024) // 32KB buffer
		for {
			n, readErr := resp.Body.Read(buf)
			if n > 0 {
				chunk := make([]byte, n)
				copy(chunk, buf[:n])
				select {
				case dataCh <- chunk:
				case <-ctx.Done():
					return
				}
			}
			if readErr != nil {
				if readErr != io.EOF {
					select {
					case errCh <- readErr:
					case <-ctx.Done():
						return
					}
				}
				close(dataCh)
				return
			}
		}
	}()

	// Stream to client with heartbeat
	clientGone := r.Context().Done()
	for {
		select {
		case <-clientGone:
			// Client disconnected cleanly
			return
		case err := <-errCh:
			if err != nil {
				// Log but don't write error (headers already sent)
				return
			}
			return
		case chunk, ok := <-dataCh:
			if !ok {
				// Upstream closed
				return
			}
			if _, err := w.Write(chunk); err != nil {
				return
			}
			flusher.Flush()
		case <-heartbeat.C:
			// Send SSE comment as heartbeat (doesn't interfere with parsing)
			if _, err := fmt.Fprintf(w, ": keep-alive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// buildUpstreamURL constructs the upstream URL preserving path and query.
func (h *sseProxyHandler) buildUpstreamURL(r *http.Request) *url.URL {
	h.mu.RLock()
	defer h.mu.RUnlock()

	target := h.upstream.ResolveReference(&url.URL{
		Path:     r.URL.Path,
		RawQuery: r.URL.RawQuery,
	})
	return target
}

// writeErrorResponse writes a JSON error response with proper status code.
func (h *sseProxyHandler) writeErrorResponse(w http.ResponseWriter, statusCode int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(statusCode)
	json.NewEncoder(w).Encode(map[string]string{
		"error":   code,
		"message": message,
	})
}

// classifyUpstreamError maps upstream errors to HTTP status codes that Pi will retry.
// Returns 502/503/504 for retryable errors, 500 for non-retryable.
func classifyUpstreamError(err error) int {
	errStr := strings.ToLower(err.Error())

	// Network/timeout errors -> 502 Bad Gateway (retryable)
	if strings.Contains(errStr, "timeout") ||
		strings.Contains(errStr, "deadline exceeded") ||
		strings.Contains(errStr, "context deadline exceeded") ||
		strings.Contains(errStr, "i/o timeout") ||
		strings.Contains(errStr, "connection refused") ||
		strings.Contains(errStr, "connection reset") ||
		strings.Contains(errStr, "broken pipe") ||
		strings.Contains(errStr, "no such host") ||
		strings.Contains(errStr, "network is unreachable") ||
		strings.Contains(errStr, "terminated") ||
		strings.Contains(errStr, "eof") {
		return http.StatusBadGateway // 502
	}

	// TLS/handshake errors -> 502
	if strings.Contains(errStr, "tls") ||
		strings.Contains(errStr, "handshake") ||
		strings.Contains(errStr, "certificate") {
		return http.StatusBadGateway // 502
	}

	// Default to 502 for unknown errors (safer to retry)
	return http.StatusBadGateway // 502
}

// copyProxyHeaders copies headers while managing hop-by-hop headers per RFC 7230.
func copyProxyHeaders(dst, src http.Header) {
	hopByHop := map[string]bool{
		"Connection":          true,
		"Keep-Alive":          true,
		"Proxy-Authenticate":  true,
		"Proxy-Authorization": true,
		"Te":                  true,
		"Trailers":            true,
		"Transfer-Encoding":   true,
		"Upgrade":             true,
	}

	for k, vv := range src {
		if hopByHop[strings.ToLower(k)] {
			continue
		}
		for _, v := range vv {
			dst.Add(k, v)
		}
	}
}

// Global SSE proxy handler instance
var sseProxy = newSSEProxyHandler()

// isHealthPath checks if the request path matches the health endpoint.
func isHealthPath(path string) bool {
	return strings.HasSuffix(strings.TrimSpace(path), healthRoutePath)
}

// isReadyPath checks if the request path matches the readiness endpoint.
func isReadyPath(path string) bool {
	return strings.HasSuffix(strings.TrimSpace(path), readyRoutePath)
}

// isSSEProxyPath checks if the request path matches the SSE proxy endpoint.
func isSSEProxyPath(path string) bool {
	normalized := strings.TrimSpace(path)
	return strings.HasPrefix(normalized, sseProxyRoutePath)
}

// isLicenseValid checks if license status allows operations.
func isLicenseValid(lic *license.StatusReport) bool {
	return lic != nil && lic.Status != "expired" && lic.CanRotate
}

// handleHealthHTTP handles GET /healthz - fast in-memory health check without blocking outbound network calls.
func handleHealthHTTP(req ManagementRequestPayload) ([]byte, error) {
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method != http.MethodGet && method != http.MethodHead {
		return jsonManagementResponse(http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
	}

	// Check license status in memory
	licStatus := license.GetLicenseStatus()
	licValid := isLicenseValid(licStatus)

	activePools := 0
	if registry := activeRegistry(); registry != nil {
		pools := registry.ListPools()
		for _, p := range pools {
			if p.IsEnabled() {
				activePools++
			}
		}
	}

	// In-memory readiness: if quota poller is active, verify it is operational
	upstreamHealthy := true
	if poller := GetAutonomousQuotaPoller(); poller != nil {
		poller.mu.Lock()
		upstreamHealthy = poller.running || activePools == 0
		poller.mu.Unlock()
	}

	healthy := licValid && upstreamHealthy

	status := HealthStatus{
		Healthy:         healthy,
		UpstreamLatency: 0, // Fast in-memory resolution (sub-millisecond)
		ActivePools:     activePools,
		LicenseStatus:   mapLicenseStatus(licStatus),
		Timestamp:       time.Now().UTC().Format(time.RFC3339),
	}

	if !healthy {
		reasons := []string{}
		if !isLicenseValid(licStatus) {
			reasons = append(reasons, "license_invalid")
		}
		if !upstreamHealthy {
			reasons = append(reasons, "upstream_unreachable")
		}
		status.Reason = strings.Join(reasons, ", ")
	}

	statusCode := http.StatusOK
	if !healthy {
		statusCode = http.StatusServiceUnavailable
	}

	return jsonManagementResponse(statusCode, status)
}

// handleReadyHTTP handles GET /readyz - readiness check (lightweight, no upstream call).
func handleReadyHTTP(req ManagementRequestPayload) ([]byte, error) {
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method != http.MethodGet && method != http.MethodHead {
		return jsonManagementResponse(http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
	}

	// Check license
	licStatus := license.GetLicenseStatus()

	// Check if plugin is initialized (registry loaded)
	registry := activeRegistry()
	ready := isLicenseValid(licStatus) && registry != nil

	status := ReadyStatus{
		Ready: ready,
	}
	if !ready {
		reasons := []string{}
		if !isLicenseValid(licStatus) {
			reasons = append(reasons, "license_invalid")
		}
		if registry == nil {
			reasons = append(reasons, "registry_not_initialized")
		}
		status.Reason = strings.Join(reasons, ", ")
	}

	statusCode := http.StatusOK
	if !ready {
		statusCode = http.StatusServiceUnavailable
	}

	return jsonManagementResponse(statusCode, status)
}

// handleSSEProxyHTTP handles GET /sse-proxy/* - SSE streaming with keep-alive.
// Note: For true SSE streaming, the host should route directly to GetSSEProxyHandler().
// This management.handle route returns an error directing to direct route.
func handleSSEProxyHTTP(req ManagementRequestPayload) ([]byte, error) {
	return jsonManagementResponse(http.StatusBadRequest, map[string]string{
		"error":   "use_direct_route",
		"message": "SSE proxy requires direct HTTP routing via host, not management.handle",
	})
}

// mapLicenseStatus converts license status to string.
func mapLicenseStatus(lic *license.StatusReport) string {
	if lic == nil {
		return "unknown"
	}
	if lic.Status == "expired" || !lic.CanRotate {
		return "invalid"
	}
	if lic.Status == "trial" && lic.DaysRemaining <= 7 {
		return "trial_expiring_soon"
	}
	if lic.Status == "active" && lic.ExpiresAt != "" && lic.ExpiresAt != "De por vida (Lifetime)" {
		// Check if expires within 7 days
		if expTime, err := time.Parse("2006-01-02", lic.ExpiresAt); err == nil {
			if time.Until(expTime) < 7*24*time.Hour {
				return "expiring_soon"
			}
		}
		return "valid"
	}
	return "valid"
}

// GetSSEProxyHandler returns the SSE proxy http.Handler for direct host registration.
func GetSSEProxyHandler() http.Handler {
	return sseProxy
}
