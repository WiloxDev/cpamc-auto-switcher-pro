package plugin

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestTelemetrySnapshot_BuildAndWriteAtomic(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "auto-switcher-pro-state.json")
	authDir := filepath.Join(tempDir, "auth-files")
	_ = os.MkdirAll(authDir, 0755)

	t.Setenv("AUTO_SWITCHER_STATE_FILE", stateFile)
	t.Setenv("AUTO_SWITCHER_AUTH_DIR", authDir)

	reg := NewPoolRegistry(stateFile)
	defaultRegistryInstance = reg
	defaultRegistryOnce.Do(func() {})

	// Crear pool de prueba
	pool := PoolDefinition{
		ID:           "Pool-01-gemini",
		BasePrefix:   "agy",
		Family:       "gemini",
		LeaderAuth:   "antigravity-leader.json",
		Reserves:     []string{"antigravity-reserve1.json"},
		ActiveLeader: "antigravity-leader.json",
	}
	_ = reg.SavePool(pool)

	// Crear archivos de auth
	_ = os.WriteFile(filepath.Join(authDir, "antigravity-leader.json"), []byte(`{"email":"leader@gmail.com","type":"antigravity","provider":"antigravity"}`), 0644)
	_ = os.WriteFile(filepath.Join(authDir, "antigravity-reserve1.json"), []byte(`{"email":"reserve1@gmail.com","type":"antigravity","provider":"antigravity"}`), 0644)
	_ = os.WriteFile(filepath.Join(authDir, "antigravity-standalone.json"), []byte(`{"email":"standalone@gmail.com","type":"antigravity","provider":"antigravity"}`), 0644)

	// Inyectar telemetría viva en PredictiveEngine
	pe := GetPredictiveEngine()
	pe.RecordLiveQuota(AccountQuotaTelemetry{
		AccountKey:      "leader@gmail.com",
		Family:          "gemini",
		Window5hPct:     85.5,
		WeeklyPct:       92.0,
		Window5hResetIn: 3600,
		WeeklyResetIn:   72000,
		UpdatedAt:       time.Now(),
	})

	// 1. Verificar BuildTelemetrySnapshot
	snapshot := BuildTelemetrySnapshot()
	if !snapshot.OK {
		t.Fatalf("expected snapshot.OK to be true")
	}
	if len(snapshot.Pools) != 1 {
		t.Fatalf("expected 1 pool in snapshot, got %d", len(snapshot.Pools))
	}
	pSumm := snapshot.Pools[0]
	if pSumm.PoolID != "Pool-01-gemini" {
		t.Errorf("expected PoolID 'Pool-01-gemini', got '%s'", pSumm.PoolID)
	}
	if pSumm.LeaderEmail != "leader@gmail.com" {
		t.Errorf("expected LeaderEmail 'leader@gmail.com', got '%s'", pSumm.LeaderEmail)
	}
	if pSumm.Window5hPct != 85.5 {
		t.Errorf("expected Window5hPct 85.5, got %f", pSumm.Window5hPct)
	}
	if len(pSumm.Reserves) != 1 || pSumm.Reserves[0] != "antigravity-reserve1.json" {
		t.Errorf("unexpected reserves: %+v", pSumm.Reserves)
	}

	// 2. Verificar escritura atómica a disco
	if err := WriteAtomicTelemetrySnapshot(); err != nil {
		t.Fatalf("WriteAtomicTelemetrySnapshot failed: %v", err)
	}

	targetFile := filepath.Join(tempDir, "auto-switcher-pro-telemetry.json")
	data, err := os.ReadFile(targetFile)
	if err != nil {
		t.Fatalf("failed to read persisted telemetry snapshot file: %v", err)
	}

	var readSnapshot TelemetrySnapshot
	if err := json.Unmarshal(data, &readSnapshot); err != nil {
		t.Fatalf("failed to unmarshal persisted snapshot: %v", err)
	}
	if len(readSnapshot.Pools) != 1 || readSnapshot.Pools[0].PoolID != "Pool-01-gemini" {
		t.Errorf("persisted snapshot content mismatch: %+v", readSnapshot)
	}

	// 3. Probar endpoint HTTP /auto-switcher-pro/telemetry/live
	reqPayload := ManagementRequestPayload{
		Method: "GET",
		Path:   "/v0/management/auto-switcher-pro/telemetry/live",
	}
	rawResp, err := handleTelemetryLiveHTTP(reqPayload)
	if err != nil {
		t.Fatalf("handleTelemetryLiveHTTP returned error: %v", err)
	}

	var envelope struct {
		Result struct {
			StatusCode int                 `json:"statusCode"`
			Headers    map[string][]string `json:"headers"`
			Body       string              `json:"body"`
		} `json:"result"`
	}
	if err := json.Unmarshal(rawResp, &envelope); err != nil {
		t.Fatalf("unmarshal HTTP envelope failed: %v, raw: %s", err, string(rawResp))
	}
	if envelope.Result.StatusCode != http.StatusOK {
		t.Fatalf("expected status 200, got %d", envelope.Result.StatusCode)
	}

	bodyBytes, err := base64.StdEncoding.DecodeString(envelope.Result.Body)
	if err != nil {
		t.Fatalf("decode base64 body failed: %v", err)
	}

	var httpSnapshot TelemetrySnapshot
	if err := json.Unmarshal(bodyBytes, &httpSnapshot); err != nil {
		t.Fatalf("unmarshal HTTP snapshot body failed: %v", err)
	}
	if httpSnapshot.Pools[0].ActiveLeader != "antigravity-leader.json" {
		t.Errorf("expected active leader 'antigravity-leader.json', got '%s'", httpSnapshot.Pools[0].ActiveLeader)
	}
}
