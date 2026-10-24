package plugin

import (
	"auto-switcher-pro/internal/analytics"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAgentMatrixHandler_GET(t *testing.T) {
	req := ManagementRequestPayload{
		Method: http.MethodGet,
		Path:   "/v0/management/auto-switcher-pro/agent-matrix",
	}

	raw, err := handleAgentMatrixHTTP(req)
	if err != nil {
		t.Fatalf("handleAgentMatrixHTTP failed: %v", err)
	}

	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("unmarshal envelope failed: %v", err)
	}

	var resp ManagementResponsePayload
	if err := json.Unmarshal(env.Result, &resp); err != nil {
		t.Fatalf("unmarshal response payload failed: %v", err)
	}

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got: %d", resp.StatusCode)
	}

	var data AgentMatrixPayload
	bodyBytes, err := base64.StdEncoding.DecodeString(resp.Body)
	if err != nil {
		t.Fatalf("decode base64 failed: %v", err)
	}
	if err := json.Unmarshal(bodyBytes, &data); err != nil {
		t.Fatalf("unmarshal body failed: %v", err)
	}

	if !data.OK {
		t.Errorf("expected OK=true")
	}
	if len(data.GentleAgents) == 0 {
		t.Errorf("expected GentleAgents to be populated")
	}
	if data.Jok3rDetected {
		if len(data.Jok3rAgents) == 0 {
			t.Errorf("expected Jok3rAgents to be populated when Jok3rDetected=true")
		}
	} else {
		if len(data.Jok3rAgents) != 0 {
			t.Errorf("expected Jok3rAgents to be empty when Jok3rDetected=false")
		}
	}

	// Verify Capability Matrix for Thinking
	if val, ok := data.PoolCapabilities["Pool-03-codex"]; ok && val {
		t.Errorf("expected Pool-03-codex to have supports_thinking=false, got true")
	}
	if val, ok := data.PoolCapabilities["Pool-04-claude"]; !ok || !val {
		t.Errorf("expected Pool-04-claude to have supports_thinking=true, got %v", val)
	}
	if levels, ok := data.ModelThinkingLevels["Pool-01-gemini"]; !ok || len(levels) != 4 {
		t.Errorf("expected Pool-01-gemini to have 4 thinking levels, got %v", levels)
	}
	if levels, ok := data.ModelThinkingLevels["Pool-03-codex"]; !ok || len(levels) != 0 {
		t.Errorf("expected Pool-03-codex (gpt-4o) to have 0 thinking levels, got %v", levels)
	}
}

func TestAgentMatrixHandler_POST(t *testing.T) {
	input := map[string]any{
		"agents": []AgentInfo{
			{
				Universe:      "jok3r_pi",
				AgentID:       "orchestrator",
				PrimaryPool:   "Pool-04-claude",
				FallbackPool:  "Pool-01-gemini",
				ThinkingLevel: "high",
				Concurrency:   1,
			},
			{
				Universe:      "gentle_ai",
				AgentID:       "gentle-ai-worker",
				RoleType:      "apply",
				PrimaryPool:   "Pool-03-codex",
				FallbackPool:  "Pool-02-gemini",
				ThinkingLevel: "high", // Should be sanitized to "none" because Codex does not support thinking
				Concurrency:   5,      // Should be sanitized to 1 for writer safety
			},
		},
	}
	body, _ := json.Marshal(input)

	req := ManagementRequestPayload{
		Method: http.MethodPost,
		Path:   "/v0/management/auto-switcher-pro/agent-matrix",
		Body:   body,
	}

	raw, err := handleAgentMatrixHTTP(req)
	if err != nil {
		t.Fatalf("handleAgentMatrixHTTP POST failed: %v", err)
	}

	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("unmarshal envelope failed: %v", err)
	}

	var resp ManagementResponsePayload
	if err := json.Unmarshal(env.Result, &resp); err != nil {
		t.Fatalf("unmarshal response payload failed: %v", err)
	}

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got: %d", resp.StatusCode)
	}

	// Verify persistence sanitized concurrency to 1 for worker
	records, err := analytics.GetAgentProfiles("gentle_ai")
	if err != nil {
		t.Fatalf("GetAgentProfiles failed: %v", err)
	}
	for _, r := range records {
		if r.AgentID == "gentle-ai-worker" {
			if r.Concurrency != 1 {
				t.Errorf("expected worker concurrency to be locked to 1, got %d", r.Concurrency)
			}
		}
	}
}

func TestAgentMatrixHandler_DynamicDiscoveryAndMtime(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("cannot access home directory")
	}

	// 1. Create a dummy subagent markdown file in ~/.pi/agent-j0k3r/subagents/
	subDir := filepath.Join(home, ".pi", "agent-j0k3r", "subagents")
	_ = os.MkdirAll(subDir, 0755)
	dummyPath := filepath.Join(subDir, "security-dynamic-test.md")
	dummyContent := "# 🛡️ Security Dynamic Tester\nDescription: Agente dinámico para pruebas quirúrgicas de seguridad\n"
	if err := os.WriteFile(dummyPath, []byte(dummyContent), 0644); err != nil {
		t.Skip("cannot write dummy subagent")
	}
	defer os.Remove(dummyPath)

	// 2. Perform GET
	req := ManagementRequestPayload{
		Method: http.MethodGet,
		Path:   "/v0/management/auto-switcher-pro/agent-matrix",
	}
	raw, err := handleAgentMatrixHTTP(req)
	if err != nil {
		t.Fatalf("handleAgentMatrixHTTP failed: %v", err)
	}

	var env Envelope
	_ = json.Unmarshal(raw, &env)
	var resp ManagementResponsePayload
	_ = json.Unmarshal(env.Result, &resp)
	var data AgentMatrixPayload
	bodyBytes, _ := base64.StdEncoding.DecodeString(resp.Body)
	_ = json.Unmarshal(bodyBytes, &data)

	// Check if security-dynamic-test was discovered dynamically
	found := false
	for _, a := range data.Jok3rAgents {
		if a.AgentID == "security-dynamic-test" {
			found = true
			if !strings.Contains(a.DisplayName, "Security Dynamic Tester") {
				t.Errorf("expected display name to include title, got %s", a.DisplayName)
			}
			break
		}
	}
	if !found {
		t.Errorf("expected dynamically created agent 'security-dynamic-test' to be discovered")
	}

	// 3. Test Mtime Invalidation: touch subagents.json externally with a custom profile
	jok3rPath := filepath.Join(home, ".pi", "agent-j0k3r", "subagents.json")
	if data, err := os.ReadFile(jok3rPath); err == nil {
		var parsed map[string]any
		if err := json.Unmarshal(data, &parsed); err == nil {
			profiles, ok := parsed["model_profiles"].(map[string]any)
			if !ok {
				profiles = make(map[string]any)
			}
			profiles["security-dynamic-test"] = map[string]any{
				"model":    "cpamc/Pool-04-claude",
				"fallback": "cpamc/Pool-01-gemini",
				"effort":   "high",
			}
			parsed["model_profiles"] = profiles
			out, _ := json.MarshalIndent(parsed, "", "  ")
			_ = os.WriteFile(jok3rPath, out, 0644)
			_ = os.Chtimes(jok3rPath, time.Now().Add(2*time.Second), time.Now().Add(2*time.Second))

			// Next GET should pick up external mtime change
			raw2, _ := handleAgentMatrixHTTP(req)
			var env2 Envelope
			_ = json.Unmarshal(raw2, &env2)
			var resp2 ManagementResponsePayload
			_ = json.Unmarshal(env2.Result, &resp2)
			var data2 AgentMatrixPayload
			bodyBytes2, _ := base64.StdEncoding.DecodeString(resp2.Body)
			_ = json.Unmarshal(bodyBytes2, &data2)

			for _, a := range data2.Jok3rAgents {
				if a.AgentID == "security-dynamic-test" {
					if a.PrimaryPool != "Pool-04-claude" {
						t.Errorf("expected reconciled PrimaryPool=Pool-04-claude from external mtime, got %s", a.PrimaryPool)
					}
					break
				}
			}
		}
	}

	// 4. Test Dry-Run / Ping Route
	pingReq := ManagementRequestPayload{
		Method: http.MethodPost,
		Path:   "/v0/management/auto-switcher-pro/agent-matrix/ping",
		Body:   []byte(`{"pool_id":"Pool-04-claude","target_model":"claude-sonnet-4-6"}`),
	}
	rawPing, err := handleAgentMatrixHTTP(pingReq)
	if err != nil {
		t.Fatalf("handleAgentMatrixHTTP ping failed: %v", err)
	}
	var envPing Envelope
	_ = json.Unmarshal(rawPing, &envPing)
	var respPing ManagementResponsePayload
	_ = json.Unmarshal(envPing.Result, &respPing)
	if respPing.StatusCode != http.StatusOK {
		t.Errorf("expected 200 OK for ping, got %d", respPing.StatusCode)
	}
	var pingRes PingResult
	pingBytes, _ := base64.StdEncoding.DecodeString(respPing.Body)
	_ = json.Unmarshal(pingBytes, &pingRes)
	// 5. Test Dynamic Detection Isolation (when j0k3r-pi is NOT detected)
	t.Setenv("FORCE_JOK3R_DETECTED", "false")
	rawUndetected, err := handleAgentMatrixHTTP(req)
	if err != nil {
		t.Fatalf("handleAgentMatrixHTTP failed: %v", err)
	}
	var envUndetected Envelope
	_ = json.Unmarshal(rawUndetected, &envUndetected)
	var respUndetected ManagementResponsePayload
	_ = json.Unmarshal(envUndetected.Result, &respUndetected)
	var dataUndetected AgentMatrixPayload
	bodyBytesUndetected, _ := base64.StdEncoding.DecodeString(respUndetected.Body)
	_ = json.Unmarshal(bodyBytesUndetected, &dataUndetected)

	if dataUndetected.Jok3rDetected {
		t.Errorf("expected Jok3rDetected=false when FORCE_JOK3R_DETECTED=false")
	}
	if len(dataUndetected.Jok3rAgents) != 0 {
		t.Errorf("expected Jok3rAgents to be completely empty when not detected, got %d", len(dataUndetected.Jok3rAgents))
	}
	if len(dataUndetected.GentleAgents) == 0 {
		t.Errorf("expected GentleAgents to remain available as default universe")
	}

	// 7. Test Triage Shadow Warmup endpoint
	warmupReq := ManagementRequestPayload{
		Method: http.MethodPost,
		Path:   "/v0/management/auto-switcher-pro/agent-matrix/warmup-triage",
		Body:   []byte(`{"target_pools":["Pool-01-gemini","Pool-04-claude"]}`),
	}
	rawWarmup, err := handleAgentMatrixHTTP(warmupReq)
	if err != nil {
		t.Fatalf("handleAgentMatrixHTTP warmup-triage failed: %v", err)
	}
	var envWarmup Envelope
	_ = json.Unmarshal(rawWarmup, &envWarmup)
	var respWarmup ManagementResponsePayload
	_ = json.Unmarshal(envWarmup.Result, &respWarmup)
	if respWarmup.StatusCode != http.StatusOK {
		t.Errorf("expected 200 OK for warmup-triage, got %d", respWarmup.StatusCode)
	}
}

func TestAgentMatrix_RoleBasedPoolAllocation(t *testing.T) {
	// 1. In a Gemini-only multi-pool setup (e.g. Pool-02-gemini and Pool-03-gemini on production):
	geminiOnly := []string{"Pool-02-gemini", "Pool-03-gemini"}
	pWorker, fWorker := resolveBestPoolForRole("apply", "gentle-ai-worker", geminiOnly)
	pVerify, fVerify := resolveBestPoolForRole("verify", "gentle-ai-verify", geminiOnly)

	if pWorker == pVerify {
		t.Errorf("expected worker and verify to be distributed across distinct pools, but both got %s", pWorker)
	}
	if pWorker != "Pool-02-gemini" {
		t.Errorf("expected worker to receive Pool-02-gemini, got %s", pWorker)
	}
	if pVerify != "Pool-03-gemini" {
		t.Errorf("expected verify to receive Pool-03-gemini for quota isolation, got %s", pVerify)
	}
	if fWorker != "Pool-03-gemini" {
		t.Errorf("expected worker fallback to be Pool-03-gemini, got %s", fWorker)
	}
	if fVerify != "Pool-02-gemini" {
		t.Errorf("expected verify fallback to be Pool-02-gemini, got %s", fVerify)
	}

	// 2. In a multi-family setup (Claude + Gemini):
	multiFamily := []string{"Pool-01-gemini", "Pool-02-gemini", "Pool-04-claude"}
	pOrch, _ := resolveBestPoolForRole("orchestrator", "orchestrator", multiFamily)
	pExplore, _ := resolveBestPoolForRole("discovery", "gentle-ai-explore", multiFamily)
	pVer, _ := resolveBestPoolForRole("verify", "gentle-ai-verify", multiFamily)

	if pOrch != "Pool-04-claude" {
		t.Errorf("expected orchestrator to allocate Claude pool, got %s", pOrch)
	}
	if pExplore != "Pool-01-gemini" {
		t.Errorf("expected explore to allocate Gemini 1, got %s", pExplore)
	}
	if pVer != "Pool-02-gemini" {
		t.Errorf("expected verify to allocate Gemini 2, got %s", pVer)
	}
}

func TestAgentMatrix_RealPingDiagnostics(t *testing.T) {
	pingReq := ManagementRequestPayload{
		Method: http.MethodPost,
		Path:   "/v0/management/auto-switcher-pro/agent-matrix/ping",
		Body:   []byte(`{"pool_id":"Pool-02-gemini","target_model":"gemini-3.8-flash-high"}`),
	}
	rawPing, err := handleAgentMatrixHTTP(pingReq)
	if err != nil {
		t.Fatalf("handleAgentMatrixHTTP ping failed: %v", err)
	}
	var env Envelope
	_ = json.Unmarshal(rawPing, &env)
	var resp ManagementResponsePayload
	_ = json.Unmarshal(env.Result, &resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}

	var res PingResult
	bodyBytes, _ := base64.StdEncoding.DecodeString(resp.Body)
	_ = json.Unmarshal(bodyBytes, &res)

	if !res.OK {
		t.Errorf("expected ping to be OK")
	}
	if res.LatencyMs <= 0 {
		t.Errorf("expected real latency > 0ms, got %d", res.LatencyMs)
	}
	if res.Model != "gemini-3.8-flash-high" {
		t.Errorf("expected model gemini-3.8-flash-high, got %s", res.Model)
	}
	if !strings.Contains(res.Message, "Ruta verificada") {
		t.Errorf("expected verification status message, got: %s", res.Message)
	}
}

func TestAgentMatrix_DirectUpstreamModelPersistence(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("cannot access home directory")
	}

	profilesPath := filepath.Join(home, ".gentle-shell", "agent", "profiles.json")
	var backup []byte
	hadProfiles := false
	if data, err := os.ReadFile(profilesPath); err == nil {
		backup = data
		hadProfiles = true
		defer func() {
			_ = os.WriteFile(profilesPath, backup, 0644)
		}()
	} else {
		defer func() {
			if !hadProfiles {
				_ = os.Remove(profilesPath)
			}
		}()
	}
	_ = os.MkdirAll(filepath.Dir(profilesPath), 0755)

	// 1. Save an upstream model selection (e.g. openai-codex/gpt-5.1-sol) for orchestrator in gentle_shell
	input := map[string]any{
		"agents": []AgentInfo{
			{
				Universe:       "gentle_shell",
				AgentID:        "orchestrator",
				DisplayName:    "👑 ORQUESTADOR GENTLE-SHELL",
				RoleType:       "orchestrator",
				IsOrchestrator: true,
				PrimaryPool:    "openai-codex/gpt-5.1-sol",
				FallbackPool:   "Pool-01-gemini",
				ThinkingLevel:  "none",
				Concurrency:    1,
			},
		},
	}
	body, _ := json.Marshal(input)
	postReq := ManagementRequestPayload{
		Method: http.MethodPost,
		Path:   "/v0/management/auto-switcher-pro/agent-matrix",
		Body:   body,
	}
	rawPost, err := handleAgentMatrixHTTP(postReq)
	if err != nil {
		t.Fatalf("POST agent-matrix failed: %v", err)
	}
	var envPost Envelope
	_ = json.Unmarshal(rawPost, &envPost)
	var respPost ManagementResponsePayload
	_ = json.Unmarshal(envPost.Result, &respPost)
	if respPost.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK from POST, got %d", respPost.StatusCode)
	}

	// 2. Verify profiles.json on disk contains "active": "current", the exact model without double "cpamc/" prefix, and "thinking"
	savedDisk, err := os.ReadFile(profilesPath)
	if err != nil {
		t.Fatalf("could not read %s: %v", profilesPath, err)
	}
	var diskStruct struct {
		Kind     string `json:"kind"`
		Version  int    `json:"version"`
		Active   string `json:"active"`
		Profiles struct {
			Current map[string]struct {
				Model    string `json:"model"`
				Fallback string `json:"fallback"`
				Thinking string `json:"thinking"`
				Effort   string `json:"effort"`
			} `json:"current"`
		} `json:"profiles"`
	}
	if err := json.Unmarshal(savedDisk, &diskStruct); err != nil {
		t.Fatalf("failed to unmarshal profiles.json: %v", err)
	}
	if diskStruct.Active != "current" {
		t.Errorf("expected active='current', got '%s'", diskStruct.Active)
	}
	orchEntry, ok := diskStruct.Profiles.Current["orchestrator"]
	if !ok {
		t.Fatalf("expected orchestrator in profiles.current")
	}
	if orchEntry.Model != "openai-codex/gpt-5.1-sol" {
		t.Errorf("expected model='openai-codex/gpt-5.1-sol' without cpamc/ prefix, got '%s'", orchEntry.Model)
	}
	if orchEntry.Fallback != "cpamc/Pool-01-gemini" {
		t.Errorf("expected fallback='cpamc/Pool-01-gemini', got '%s'", orchEntry.Fallback)
	}
	if orchEntry.Thinking != "none" || orchEntry.Effort != "none" {
		t.Errorf("expected thinking=none and effort=none, got thinking=%s effort=%s", orchEntry.Thinking, orchEntry.Effort)
	}

	// 3. Perform GET and verify the model selection is NOT reverted by containsPool
	getReq := ManagementRequestPayload{
		Method: http.MethodGet,
		Path:   "/v0/management/auto-switcher-pro/agent-matrix",
	}
	rawGet, err := handleAgentMatrixHTTP(getReq)
	if err != nil {
		t.Fatalf("GET agent-matrix failed: %v", err)
	}
	var envGet Envelope
	_ = json.Unmarshal(rawGet, &envGet)
	var respGet ManagementResponsePayload
	_ = json.Unmarshal(envGet.Result, &respGet)
	var dataGet AgentMatrixPayload
	bodyBytes, _ := base64.StdEncoding.DecodeString(respGet.Body)
	_ = json.Unmarshal(bodyBytes, &dataGet)

	foundOrch := false
	for _, h := range dataGet.Harnesses {
		if h.ID == "gentle_shell" {
			for _, a := range h.Agents {
				if a.AgentID == "orchestrator" {
					foundOrch = true
					if a.PrimaryPool != "openai-codex/gpt-5.1-sol" {
						t.Errorf("CRITICAL REVERSION BUG: expected PrimaryPool='openai-codex/gpt-5.1-sol', but got reverted to '%s'", a.PrimaryPool)
					}
				}
			}
		}
	}
	if !foundOrch {
		t.Errorf("gentle_shell orchestrator not found in GET response")
	}
}

func TestAgentMatrix_DynamicThinkingLevels(t *testing.T) {
	// 1. Verify resolveModelThinkingLevels
	suppGemini, levelsGemini := resolveModelThinkingLevels("gemini-3.8-flash-high")
	if !suppGemini || len(levelsGemini) != 4 {
		t.Errorf("expected gemini-3.8-flash-high to have 4 levels, got %v", levelsGemini)
	}

	suppLuna, levelsLuna := resolveModelThinkingLevels("gpt-6-luna")
	if !suppLuna || len(levelsLuna) != 5 {
		t.Errorf("expected gpt-6-luna to have 5 levels, got %v", levelsLuna)
	}

	suppCodexReasoning, levelsCodex := resolveModelThinkingLevels("openai/o3-mini")
	if !suppCodexReasoning || len(levelsCodex) != 3 {
		t.Errorf("expected o3-mini to have 3 levels, got %v", levelsCodex)
	}

	suppGpt4o, levelsGpt4o := resolveModelThinkingLevels("openai/gpt-4o")
	if suppGpt4o || len(levelsGpt4o) != 0 {
		t.Errorf("expected gpt-4o to have 0 levels, got %v", levelsGpt4o)
	}

	// 2. Verify POST preserves thinking level on Codex reasoning model
	input := struct {
		Agents []AgentInfo `json:"agents"`
	}{
		Agents: []AgentInfo{
			{
				Universe:      "gentle_ai",
				AgentID:       "orchestrator",
				RoleType:      "orchestrator",
				PrimaryPool:   "openai/o3-mini",
				FallbackPool:  "Pool-01-gemini",
				ThinkingLevel: "high",
				Concurrency:   1,
			},
		},
	}
	body, _ := json.Marshal(input)
	req := ManagementRequestPayload{
		Method: http.MethodPost,
		Path:   "/v0/management/auto-switcher-pro/agent-matrix",
		Body:   body,
	}
	raw, err := handleAgentMatrixHTTP(req)
	if err != nil {
		t.Fatalf("handleAgentMatrixHTTP failed: %v", err)
	}
	var env Envelope
	_ = json.Unmarshal(raw, &env)
	var resp ManagementResponsePayload
	_ = json.Unmarshal(env.Result, &resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	records, _ := analytics.GetAgentProfiles("gentle_ai")
	for _, r := range records {
		if r.AgentID == "orchestrator" {
			if r.ThinkingLevel != "high" {
				t.Errorf("expected thinking=high to be preserved on o3-mini, got %s", r.ThinkingLevel)
			}
		}
	}
}

func TestAgentMatrix_HarnessVersionAudit(t *testing.T) {
	req := ManagementRequestPayload{
		Method: "GET",
		Path:   "/v0/management/auto-switcher-pro/agent-matrix/harness-version?harness=gentle_shell",
	}

	raw, err := handleAgentMatrixHTTP(req)
	if err != nil {
		t.Fatalf("version audit failed: %v", err)
	}

	var env Envelope
	_ = json.Unmarshal(raw, &env)
	var resp ManagementResponsePayload
	_ = json.Unmarshal(env.Result, &resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	var parsed struct {
		OK   bool                `json:"ok"`
		Data HarnessVersionAudit `json:"data"`
	}
	bodyBytes, _ := base64.StdEncoding.DecodeString(resp.Body)
	if len(bodyBytes) == 0 {
		bodyBytes = []byte(resp.Body)
	}
	if err := json.Unmarshal(bodyBytes, &parsed); err != nil {
		t.Fatalf("failed to parse json: %v (raw body: %s)", err, resp.Body)
	}

	if !parsed.OK {
		t.Errorf("expected ok: true")
	}
	if parsed.Data.HarnessID != "gentle_shell" {
		t.Errorf("expected harness_id gentle_shell, got %s", parsed.Data.HarnessID)
	}
	if parsed.Data.NPMVersion == "" {
		t.Errorf("expected NPMVersion to be resolved, got empty")
	}
	if parsed.Data.GitHubVersion == "" {
		t.Errorf("expected GitHubVersion to be resolved, got empty")
	}
}
