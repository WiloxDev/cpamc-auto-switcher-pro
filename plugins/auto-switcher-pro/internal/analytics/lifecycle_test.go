package analytics

import (
	"testing"
)

func TestMapReasonToBadge(t *testing.T) {
	cases := []struct {
		reason     string
		status     int
		expected   string
	}{
		{"shadow_inference_prompt_cache", 200, "[Prompt Cache]"},
		{"leader_fatigue_75pct_threshold", 200, "[Fatiga 80%]"},
		{"rate_limit_exceeded", 429, "[HTTP 429]"},
		{"quota exceeded for account", 200, "[HTTP 429]"},
		{"proactive_session_rebalance", 200, "[Histéresis Δ]"},
		{"hysteresis_delta", 200, "[Histéresis Δ]"},
		{"circuit_breaker_tripped", 200, "[Bucle Interc.]"},
		{"manual_operator_switch", 200, "[Manual Hook]"},
		{"warmup_ghost_routine", 200, "[Ghost Warmup]"},
		{"network_timeout_econnreset", 504, "[Red Upstream]"},
		{"custom_short", 200, "[custom_short]"},
	}

	for _, tc := range cases {
		t.Run(tc.reason, func(t *testing.T) {
			got := MapReasonToBadge(tc.reason, tc.status)
			if got != tc.expected {
				t.Errorf("for reason '%s' (status %d), expected '%s', got '%s'", tc.reason, tc.status, tc.expected, got)
			}
		})
	}
}
