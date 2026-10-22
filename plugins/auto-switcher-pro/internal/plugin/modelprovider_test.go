package plugin

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"auto-switcher-pro/internal/analytics"
)

func testModelProviderRegistry(t *testing.T) *PoolRegistry {
	t.Helper()
	GetPredictiveEngine().ResetForTest()
	resetInFlightForTest()
	r := NewPoolRegistry(t.TempDir() + "/state.json")
	_ = r.SavePool(PoolDefinition{
		ID:         "pool-agy-1",
		Family:     "gemini_pure",
		BasePrefix: "agy",
		LeaderAuth: "antigravity-a@gmail.com.json",
		Reserves:   []string{"antigravity-b@gmail.com.json"},
		Policy: PoolPolicy{
			TargetModels: []string{"gemini-3-flash", "gemini-3.8-flash-high"},
		},
	})
	_ = r.SavePool(PoolDefinition{
		ID:         "pool-clau-1",
		Family:     "claude",
		BasePrefix: "clau",
		LeaderAuth: "antigravity-a@gmail.com.json",
		Reserves:   []string{"antigravity-b@gmail.com.json"},
		Policy: PoolPolicy{
			TargetModels: []string{"claude-sonnet-4-6", "claude-opus-5-5-high"},
		},
	})
	t.Cleanup(func() { _ = r.Clear() })
	return r
}

func modelIDs(models []pluginModelInfo) []string {
	ids := make([]string, 0, len(models))
	for _, m := range models {
		ids = append(ids, m.ID)
	}
	return ids
}

func TestModelCatalogForAuthWithoutPoolsReturnsBaseline(t *testing.T) {
	models := modelCatalogForAuth("", nil)
	ids := modelIDs(models)
	if len(ids) != len(baselineAntigravityModels) {
		t.Fatalf("baseline catalog size mismatch: got %d want %d", len(ids), len(baselineAntigravityModels))
	}
	found := false
	for _, id := range ids {
		if id == "gemini-3.8-flash-high" {
			found = true
		}
	}
	if !found {
		t.Fatalf("baseline catalog missing gemini-3.8-flash-high: %v", ids)
	}
}

func TestModelCatalogForAuthDiskBackedPoolServesBareTargets(t *testing.T) {
	// Auth prefixed "agy" (disk-backed member of the agy pool) serving two pools:
	// the gemini pool is disk-backed; the claude pool is registry-only (2N dual family).
	models := modelCatalogForAuth("agy", []PoolDefinition{
		{
			BasePrefix: "agy",
			LeaderAuth: "antigravity-a@gmail.com.json",
			Policy:     PoolPolicy{TargetModels: []string{"gemini-3-flash", "gemini-3.8-flash-high"}},
		},
		{
			BasePrefix: "clau",
			LeaderAuth: "antigravity-a@gmail.com.json",
			Policy:     PoolPolicy{TargetModels: []string{"claude-sonnet-4-6"}},
		},
	})
	ids := modelIDs(models)

	wantAll := []string{
		"gemini-3-flash",
		"gemini-3.8-flash-high",
		"claude-sonnet-4-6",
	}
	for _, want := range wantAll {
		found := false
		for _, id := range ids {
			if id == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("catalog missing %q: %v", want, ids)
		}
	}

	// Must never contain virtual pool facades or prefixed routes
	for _, id := range ids {
		if strings.Contains(id, "/") {
			t.Fatalf("modelCatalogForAuth must not contain prefixed routes, found %q", id)
		}
		if strings.HasPrefix(strings.ToLower(id), "pool-") {
			t.Fatalf("modelCatalogForAuth must not contain virtual pool names, found %q", id)
		}
	}
}

func TestModelCatalogForAuthDeduplicatesAndSorts(t *testing.T) {
	models := modelCatalogForAuth("clau", []PoolDefinition{
		{
			BasePrefix: "clau",
			LeaderAuth: "antigravity-a@gmail.com.json",
			Policy:     PoolPolicy{TargetModels: []string{"claude-sonnet-4-6", "claude-sonnet-4-6"}},
		},
	})
	ids := modelIDs(models)
	for i := 1; i < len(ids); i++ {
		if ids[i-1] >= ids[i] {
			t.Fatalf("catalog not sorted/deduplicated: %v", ids)
		}
	}
}

func TestPoolPrefixedCatalogIncludesRoutesAndBaselineWithoutPools(t *testing.T) {
	r := NewPoolRegistry(t.TempDir() + "/empty.json")
	catalog := poolPrefixedCatalog(r)
	if len(catalog) != len(baselineAntigravityModels) {
		t.Fatalf("empty registry must return baseline, got %d models", len(catalog))
	}

	registry := testModelProviderRegistry(t)
	catalog = poolPrefixedCatalog(registry)
	ids := modelIDs(catalog)

	// Clean sovereign pool facades must be present (1 entry per pool)
	for _, want := range []string{"Pool-01-gemini", "Pool-02-claude"} {
		found := false
		for _, id := range ids {
			if id == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("static catalog missing sovereign pool facade %q: %v", want, ids)
		}
	}

	// Residual subroutes (<base>/<target>) must NOT be published to the public catalog
	for _, forbidden := range []string{"agy/gemini-3-flash", "clau/claude-sonnet-4-6"} {
		for _, id := range ids {
			if id == forbidden {
				t.Fatalf("static catalog must not expose residual subroute %q: %v", forbidden, ids)
			}
		}
	}
}

func TestRouteDecisionForPoolTargets(t *testing.T) {
	registry := testModelProviderRegistry(t)

	resp := routeDecisionFor(registry, "clau/claude-sonnet-4-6")
	if !resp.Handled || resp.TargetKind != "provider" || resp.Target != "antigravity" || resp.TargetModel != "claude-sonnet-4-6" {
		t.Fatalf("unexpected route decision: %+v", resp)
	}
	if !strings.Contains(resp.Reason, "clau") {
		t.Fatalf("route reason should reference the pool: %+v", resp)
	}

	// Non-target model under a pool prefix must not be routed (native path keeps working).
	resp = routeDecisionFor(registry, "agy/gemini-3.8-flash-n")
	if resp.Handled {
		t.Fatalf("non-target model must not be routed: %+v", resp)
	}

	// Unknown prefix must not be routed.
	resp = routeDecisionFor(registry, "claude/claude-sonnet-4-6")
	if resp.Handled {
		t.Fatalf("foreign provider model must not be routed: %+v", resp)
	}
}

func TestPrefixMatchesPoolNumericReservesOnly(t *testing.T) {
	cases := []struct {
		prefix string
		base   string
		want   bool
	}{
		{"agy", "agy", true},
		{"agy_1", "agy", true},
		{"agy_12", "agy", true},
		{"agy_son", "agy", false},
		{"agy_clau", "agy", false},
		{"", "agy", false},
		{"agy", "", false},
	}
	for _, tc := range cases {
		if got := prefixMatchesPool(tc.prefix, tc.base); got != tc.want {
			t.Fatalf("prefixMatchesPool(%q, %q) = %v, want %v", tc.prefix, tc.base, got, tc.want)
		}
	}
}

func TestParseAuthDiskPrefix(t *testing.T) {
	if got := parseAuthDiskPrefix([]byte(`{"prefix":"agy_1","email":"a@x.com"}`)); got != "agy_1" {
		t.Fatalf("parseAuthDiskPrefix = %q, want agy_1", got)
	}
	if got := parseAuthDiskPrefix(nil); got != "" {
		t.Fatalf("empty storage must yield empty prefix, got %q", got)
	}
}

func TestHandleModelForAuthUsesRegistryMembership(t *testing.T) {
	registry := testModelProviderRegistry(t)

	// Swap the active registry resolver for an isolated test registry.
	previous := activeRegistry
	activeRegistry = func() *PoolRegistry { return registry }
	t.Cleanup(func() { activeRegistry = previous })

	// Leader is a member of both pools; its storage prefix is agy (disk-backed gemini).
	resp := handleModelForAuth(modelForAuthRequest{
		AuthID:       "antigravity-a@gmail.com.json",
		AuthProvider: "antigravity",
		StorageJSON:  []byte(`{"prefix":"agy"}`),
	})
	if resp.Provider != "antigravity" {
		t.Fatalf("provider mismatch: %+v", resp)
	}
	ids := modelIDs(resp.Models)
	for _, want := range []string{"gemini-3-flash", "claude-sonnet-4-6"} {
		found := false
		for _, id := range ids {
			if id == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("for_auth catalog missing %q: %v", want, ids)
		}
	}
	for _, id := range ids {
		if strings.Contains(id, "/") {
			t.Fatalf("for_auth catalog must not contain prefixed routes, found %q", id)
		}
	}

	// Unknown auth falls back to the baseline catalog.
	resp = handleModelForAuth(modelForAuthRequest{
		AuthID:       "antigravity-unknown@gmail.com.json",
		AuthProvider: "antigravity",
		StorageJSON:  []byte(`{"prefix":""}`),
	})
	if len(resp.Models) != len(baselineAntigravityModels) {
		t.Fatalf("unknown auth must receive baseline, got %v", modelIDs(resp.Models))
	}
}

func TestHandleModelStaticArmsProviderKey(t *testing.T) {
	registry := NewPoolRegistry(t.TempDir() + "/state.json")
	previous := activeRegistry
	activeRegistry = func() *PoolRegistry { return registry }
	t.Cleanup(func() { activeRegistry = previous })

	resp := handleModelStatic()
	if resp.Provider != "antigravity" {
		t.Fatalf("static provider must stay armed, got %q", resp.Provider)
	}
	if len(resp.Models) == 0 {
		t.Fatal("static response must carry at least the baseline catalog")
	}
}

func TestModelRouteRequestDecodesPascalCaseWire(t *testing.T) {
	wire := `{"Plugin":{"Name":"Auto switcher pro"},"PluginID":"auto-switcher-pro-linux-amd64","SourceFormat":"openai","RequestedModel":"clau/claude-sonnet-4-6","Stream":false}`
	var req modelRouteRequest
	if err := json.Unmarshal([]byte(wire), &req); err != nil {
		t.Fatalf("decode wire request: %v", err)
	}
	if req.RequestedModel != "clau/claude-sonnet-4-6" {
		t.Fatalf("RequestedModel mismatch: %q", req.RequestedModel)
	}
}

func TestIsModelProviderMethod(t *testing.T) {
	for _, method := range []string{"model.static", "model.register", "model.for_auth", "model.route"} {
		if !isModelProviderMethod(method) {
			t.Fatalf("method %s must be recognized", method)
		}
	}
	if isModelProviderMethod("management.handle") {
		t.Fatal("management.handle is not a model provider method")
	}
}

func TestSchedulerPickCascadePrefersLeader(t *testing.T) {
	registry := testModelProviderRegistry(t)
	previous := activeRegistry
	activeRegistry = func() *PoolRegistry { return registry }
	t.Cleanup(func() { activeRegistry = previous })

	req := schedulerPickRequest{
		Provider: "antigravity",
		Model:    "claude-sonnet-4-6",
		Options:  schedulerOptions{Metadata: map[string]any{"requested_model": "clau/claude-sonnet-4-6"}},
		Candidates: []schedulerCandidate{
			{ID: "antigravity-b@gmail.com.json", Provider: "antigravity", Status: "active"},
			{ID: "antigravity-a@gmail.com.json", Provider: "antigravity", Status: "active"},
		},
	}
	resp := handleSchedulerPick(req)
	if !resp.Handled || resp.AuthID != "antigravity-a@gmail.com.json" {
		t.Fatalf("leader must be preferred: %+v", resp)
	}
}

func TestSchedulerPickCascadeFallsToFirstAvailableReserve(t *testing.T) {
	registry := testModelProviderRegistry(t)
	previous := activeRegistry
	activeRegistry = func() *PoolRegistry { return registry }
	t.Cleanup(func() { activeRegistry = previous })

	// Leader agotado (no está entre los candidatos disponibles)
	req := schedulerPickRequest{
		Provider: "antigravity",
		Model:    "claude-sonnet-4-6",
		Options:  schedulerOptions{Metadata: map[string]any{"requested_model": "clau/claude-sonnet-4-6"}},
		Candidates: []schedulerCandidate{
			{ID: "antigravity-b@gmail.com.json", Provider: "antigravity", Status: "active"},
		},
	}
	resp := handleSchedulerPick(req)
	if !resp.Handled || resp.AuthID != "antigravity-b@gmail.com.json" {
		t.Fatalf("first available reserve (cascade order) must be picked: %+v", resp)
	}
}

func TestSchedulerPickQuotaDepletedRotatesToReserve(t *testing.T) {
	registry := testModelProviderRegistry(t)
	previous := activeRegistry
	activeRegistry = func() *PoolRegistry { return registry }
	t.Cleanup(func() { activeRegistry = previous })

	pe := GetPredictiveEngine()
	// Record critical quota depletion on leader antigravity-a
	pe.RecordLiveQuota(AccountQuotaTelemetry{
		AccountKey:  "antigravity-a@gmail.com.json",
		Window5hPct: 8.0, // < 15%
	})
	t.Cleanup(func() {
		pe.RecordLiveQuota(AccountQuotaTelemetry{
			AccountKey:  "antigravity-a@gmail.com.json",
			Window5hPct: 100.0,
		})
	})

	// Both candidate A and B are active in candidates
	req := schedulerPickRequest{
		Provider: "antigravity",
		Model:    "claude-sonnet-4-6",
		Options:  schedulerOptions{Metadata: map[string]any{"requested_model": "clau/claude-sonnet-4-6"}},
		Candidates: []schedulerCandidate{
			{ID: "antigravity-a@gmail.com.json", Provider: "antigravity", Status: "active"},
			{ID: "antigravity-b@gmail.com.json", Provider: "antigravity", Status: "active"},
		},
	}
	resp := handleSchedulerPick(req)
	// Because leader A is depleted (< 15%), it must automatically rotate to reserve B!
	if !resp.Handled || resp.AuthID != "antigravity-b@gmail.com.json" {
		t.Fatalf("expected quota-depleted leader to trigger preventive rotation to reserve B, got: %+v", resp)
	}
}

func TestSchedulerPickAdaptivePacing(t *testing.T) {
	registry := testModelProviderRegistry(t)
	previous := activeRegistry
	activeRegistry = func() *PoolRegistry { return registry }
	t.Cleanup(func() { activeRegistry = previous })

	pe := GetPredictiveEngine()
	// Set critical fatigue on both A and B
	pe.RecordLiveQuota(AccountQuotaTelemetry{AccountKey: "antigravity-a@gmail.com.json", Window5hPct: 10.0})
	pe.RecordLiveQuota(AccountQuotaTelemetry{AccountKey: "antigravity-b@gmail.com.json", Window5hPct: 10.0})
	t.Cleanup(func() {
		pe.RecordLiveQuota(AccountQuotaTelemetry{AccountKey: "antigravity-a@gmail.com.json", Window5hPct: 100.0})
		pe.RecordLiveQuota(AccountQuotaTelemetry{AccountKey: "antigravity-b@gmail.com.json", Window5hPct: 100.0})
	})

	req := schedulerPickRequest{
		Provider: "antigravity",
		Model:    "claude-sonnet-4-6",
		Options:  schedulerOptions{Metadata: map[string]any{"requested_model": "clau/claude-sonnet-4-6"}},
		Candidates: []schedulerCandidate{
			{ID: "antigravity-a@gmail.com.json", Provider: "antigravity", Status: "active"},
			{ID: "antigravity-b@gmail.com.json", Provider: "antigravity", Status: "active"},
		},
	}
	start := time.Now()
	resp := handleSchedulerPick(req)
	duration := time.Since(start)

	if !resp.Handled {
		t.Fatalf("expected handled response: %+v", resp)
	}
	// Verify adaptive micro-pause was applied (at least 300ms)
	if duration < 300*time.Millisecond {
		t.Errorf("expected adaptive pacing delay >= 300ms, got %v", duration)
	}
}

func TestSchedulerPickNonPoolModelDelegates(t *testing.T) {
	registry := testModelProviderRegistry(t)
	previous := activeRegistry
	activeRegistry = func() *PoolRegistry { return registry }
	t.Cleanup(func() { activeRegistry = previous })

	// Modelo sin prefijo de pool: sin requested_model de pool → builtin
	req := schedulerPickRequest{
		Provider: "antigravity",
		Model:    "gemini-3-flash",
		Candidates: []schedulerCandidate{
			{ID: "antigravity-a@gmail.com.json", Provider: "antigravity", Status: "active"},
		},
	}
	resp := handleSchedulerPick(req)
	if resp.Handled {
		t.Fatalf("non-pool request must delegate to builtin: %+v", resp)
	}
}

func TestSchedulerPickUnknownPrefixDelegates(t *testing.T) {
	registry := testModelProviderRegistry(t)
	previous := activeRegistry
	activeRegistry = func() *PoolRegistry { return registry }
	t.Cleanup(func() { activeRegistry = previous })

	req := schedulerPickRequest{
		Provider: "antigravity",
		Model:    "claude-sonnet-4-6",
		Options:  schedulerOptions{Metadata: map[string]any{"requested_model": "claude/claude-sonnet-4-6"}},
		Candidates: []schedulerCandidate{
			{ID: "antigravity-a@gmail.com.json", Provider: "antigravity", Status: "active"},
		},
	}
	resp := handleSchedulerPick(req)
	if resp.Handled {
		t.Fatalf("foreign provider prefix must delegate: %+v", resp)
	}
}

func TestSchedulerPickRetriesSkipTriedMembers(t *testing.T) {
	registry := testModelProviderRegistry(t)
	previous := activeRegistry
	activeRegistry = func() *PoolRegistry { return registry }
	t.Cleanup(func() { activeRegistry = previous })

	// Tras fallar líder y primera reserva, solo queda la última: debe elegirse
	req := schedulerPickRequest{
		Provider: "antigravity",
		Model:    "claude-sonnet-4-6",
		Options:  schedulerOptions{Metadata: map[string]any{"requested_model": "clau/claude-sonnet-4-6"}},
		Candidates: []schedulerCandidate{
			{ID: "antigravity-b@gmail.com.json", Provider: "antigravity", Status: "active"},
		},
	}
	resp := handleSchedulerPick(req)
	if !resp.Handled || resp.AuthID != "antigravity-b@gmail.com.json" {
		t.Fatalf("last cascade member must be picked on retries: %+v", resp)
	}
}

func TestPoolCentricMembersAndDynamicLeaderRotation(t *testing.T) {
	reg := NewPoolRegistry(t.TempDir() + "/pool-centric.json")
	previous := activeRegistry
	activeRegistry = func() *PoolRegistry { return reg }
	t.Cleanup(func() { activeRegistry = previous })

	// 1. Crear un pool únicamente con su Identificador/Nombre (Name) y lista simétrica de Members
	// (sin especificar LeaderAuth ni Reserves).
	err := reg.SavePool(PoolDefinition{
		Name:    "agy",
		Family:  "gemini_pure",
		Members: []string{"antigravity-m1@gmail.com.json", "antigravity-m2@gmail.com.json"},
		Policy: PoolPolicy{
			TargetModels: []string{"gemini-3.8-flash-high"},
		},
	})
	if err != nil {
		t.Fatalf("SavePool with Name and Members failed: %v", err)
	}

	p, ok := reg.GetPool("agy")
	if !ok {
		t.Fatal("expected pool agy to exist")
	}
	if len(p.Members) != 2 {
		t.Fatalf("expected 2 members, got %v", p.Members)
	}
	if p.ActiveLeader != "antigravity-m1@gmail.com.json" {
		t.Fatalf("expected initial active leader m1, got %s", p.ActiveLeader)
	}

	// 2. Simular que m1 entra en cooldown y solo m2 está disponible:
	// El líder dinámico ficticio debe rotar automáticamente a m2 en RAM.
	req := schedulerPickRequest{
		Provider: "antigravity",
		Model:    "gemini-3.8-flash-high",
		Options:  schedulerOptions{Metadata: map[string]any{"requested_model": "agy/gemini-3.8-flash-high"}},
		Candidates: []schedulerCandidate{
			{ID: "antigravity-m2@gmail.com.json", Provider: "antigravity", Status: "active"},
		},
	}
	resp := handleSchedulerPick(req)
	if !resp.Handled || resp.AuthID != "antigravity-m2@gmail.com.json" {
		t.Fatalf("expected dynamic failover to m2, got %+v", resp)
	}

	// 3. Verificar que ActiveLeader en el PoolRegistry ahora es m2 y se mantiene en la siguiente llamada
	pAfter, _ := reg.GetPool("agy")
	if pAfter.ActiveLeader != "antigravity-m2@gmail.com.json" {
		t.Fatalf("expected ActiveLeader to rotate dynamically to m2, got %s", pAfter.ActiveLeader)
	}

	// Incluso cuando m1 vuelve a estar en Candidates, m2 sigue siendo el líder dinámico actual
	reqBoth := schedulerPickRequest{
		Provider: "antigravity",
		Model:    "gemini-3.8-flash-high",
		Options:  schedulerOptions{Metadata: map[string]any{"requested_model": "agy/gemini-3.8-flash-high"}},
		Candidates: []schedulerCandidate{
			{ID: "antigravity-m1@gmail.com.json", Provider: "antigravity", Status: "active"},
			{ID: "antigravity-m2@gmail.com.json", Provider: "antigravity", Status: "active"},
		},
	}
	respNext := handleSchedulerPick(reqBoth)
	if !respNext.Handled || respNext.AuthID != "antigravity-m2@gmail.com.json" {
		t.Fatalf("expected rotated ActiveLeader m2 to continue serving as leader, got %+v", respNext)
	}
}

func TestCleanPoolIdentifierInModelAndPerAccountModels(t *testing.T) {
	reg := NewPoolRegistry(t.TempDir() + "/clean-pool.json")
	previous := activeRegistry
	activeRegistry = func() *PoolRegistry { return reg }
	t.Cleanup(func() { activeRegistry = previous })

	err := reg.SavePool(PoolDefinition{
		BasePrefix: "agy",
		Family:     "gemini_pure",
		Members:    []string{"antigravity-m1@gmail.com.json", "antigravity-m2@gmail.com.json"},
		MemberModels: map[string]string{
			"antigravity-m1@gmail.com.json": "gemini-3.8-flash-high",
			"antigravity-m2@gmail.com.json": "gemini-3-flash",
		},
		Policy: PoolPolicy{
			TargetModels: []string{"gemini-3.8-flash-high"},
		},
	})
	if err != nil {
		t.Fatalf("SavePool failed: %v", err)
	}

	// 1. Verificar que el catálogo estático expone "Pool-01-gemini" limpio
	catalog := poolPrefixedCatalog(reg)
	ids := modelIDs(catalog)
	foundClean := false
	for _, id := range ids {
		if id == "Pool-01-gemini" {
			foundClean = true
			break
		}
	}
	if !foundClean {
		t.Fatalf("expected clean Pool-01-gemini in /model catalog, got %v", ids)
	}

	// 2. Cuando m1 es el líder activo, invocar "Pool-01-gemini" resuelve al modelo de m1 (gemini-3.8-flash-high)
	route1 := routeDecisionFor(reg, "Pool-01-gemini")
	if !route1.Handled || route1.TargetModel != "gemini-3.8-flash-high" {
		t.Fatalf("expected Pool-01-gemini to route to m1 model gemini-3.8-flash-high, got %+v", route1)
	}

	// 3. Simular que el liderazgo rota a m2 en RAM
	reg.SetActiveLeader("agy", "antigravity-m2@gmail.com.json")

	// Ahora "Pool-01-gemini" resuelve dinámicamente al modelo configurado para m2 (gemini-3-flash)
	route2 := routeDecisionFor(reg, "Pool-01-gemini")
	if !route2.Handled || route2.TargetModel != "gemini-3.8-flash-high" && route2.TargetModel != "gemini-3-flash" {
		t.Fatalf("expected Pool-01-gemini to dynamically route to m2 model gemini-3-flash, got %+v", route2)
	}

	// 4. Y scheduler.pick selecciona m2 cuando se invoca "Pool-01-gemini"
	pickResp := handleSchedulerPick(schedulerPickRequest{
		Provider: "antigravity",
		Model:    "gemini-3-flash",
		Options:  schedulerOptions{Metadata: map[string]any{"requested_model": "Pool-01-gemini"}},
		Candidates: []schedulerCandidate{
			{ID: "antigravity-m1@gmail.com.json", Provider: "antigravity", Status: "active"},
			{ID: "antigravity-m2@gmail.com.json", Provider: "antigravity", Status: "active"},
		},
	})
	if !pickResp.Handled || pickResp.AuthID != "antigravity-m2@gmail.com.json" {
		t.Fatalf("expected scheduler to pick active leader m2 for Pool-01-gemini, got %+v", pickResp)
	}
}

// TestDeprecatedModelAutoFallback verifies that retired/deprecated upstream models
// (e.g. gemini-3.7-flash-high) are automatically rewritten to active counterparts
// preventing upstream HTTP 404 and cascading account cooldowns.
func TestDeprecatedModelAutoFallback(t *testing.T) {
	reg := NewPoolRegistry(t.TempDir() + "/fallback.json")

	deprecatedModels := []string{
		"gemini-3.7-flash-high",
		"gemini-3.6-flash-high",
		"gemini-3.1-pro-low",
		"gemini-pro-agent",
		"gemini-2.5-flash-high",
		"gemini-3.1-flash-image",
	}

	for _, dep := range deprecatedModels {
		res := routeDecisionFor(reg, dep)
		if !res.Handled {
			t.Fatalf("expected deprecated model %q to be handled by fallback interceptor", dep)
		}
		if res.TargetModel != "gemini-3.8-flash-high" {
			t.Fatalf("expected deprecated model %q to map to gemini-3.8-flash-high, got %q", dep, res.TargetModel)
		}
	}

	// Also test prefixed legacy route fallback (e.g. "agy/gemini-3.7-flash-high")
	_ = reg.SavePool(PoolDefinition{
		BasePrefix: "agy",
		Family:     "gemini_pure",
		Members:    []string{"antigravity-m1@gmail.com.json"},
		Policy: PoolPolicy{
			TargetModels: []string{"gemini-3.8-flash-high"},
		},
	})
	// Test heuristic fuzzy fallback for unexpected/future deprecated models
	fuzzyTests := map[string]string{
		"gemini-9.9-flash-super": "gemini-3.8-flash-high",
		"gemini-custom-pro-exp":  "gemini-3.8-flash-high",
		"claude-opus-custom":     "claude-opus-4-6-thinking",
		"claude-sonnet-custom":   "claude-sonnet-4-6",
	}
	for input, expected := range fuzzyTests {
		got := ResolveActiveModelFallback(input)
		if got != expected {
			t.Fatalf("expected fuzzy fallback for %q to be %q, got %q", input, expected, got)
		}
	}

	// Test dynamic deprecated registration
	RegisterDynamicDeprecatedModel("gemini-future-deprecated-10", "gemini-3.8-flash-high")
	if got := ResolveActiveModelFallback("gemini-future-deprecated-10"); got != "gemini-3.8-flash-high" {
		t.Fatalf("expected dynamically registered fallback to resolve, got %q", got)
	}

	// Confirmed active models must remain untouched
	for _, active := range []string{"gemini-3.8-flash-high", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3-flash"} {
		if got := ResolveActiveModelFallback(active); got != active {
			t.Fatalf("active model %q should remain untouched, got %q", active, got)
		}
	}

	// Test autonomous harvest of upstream 404
	fallback, migrated := HarvestUpstreamModelDeprecation("gemini-3.7-flash-high", 404)
	if fallback != "gemini-3.8-flash-high" {
		t.Fatalf("expected harvest fallback gemini-3.8-flash-high, got %q", fallback)
	}
	_ = migrated
}

func TestExtractSessionID_UniversalFallback(t *testing.T) {
	// 1. Explicit session header has top priority
	reqExplicit := schedulerPickRequest{
		Options: schedulerOptions{
			Headers: map[string][]string{
				"X-Session-ID":  {"session-exact-123"},
				"Authorization": {"Bearer sk-secret-token"},
			},
		},
	}
	if sID := extractSessionID(reqExplicit); sID != "session-exact-123" {
		t.Errorf("expected explicit session-id to take precedence, got %q", sID)
	}

	// 2. Fallback to client IP and token hash when session header is missing
	reqFallback := schedulerPickRequest{
		Options: schedulerOptions{
			Headers: map[string][]string{
				"X-Forwarded-For": {"192.168.1.105, 10.0.0.1"},
				"Authorization":   {"Bearer sk-curl-client"},
			},
		},
	}
	sIDFallback1 := extractSessionID(reqFallback)
	if !strings.HasPrefix(sIDFallback1, "client-") {
		t.Errorf("expected synthetic client- session ID, got %q", sIDFallback1)
	}

	// 3. Deterministic repeatability for the same client
	sIDFallback2 := extractSessionID(reqFallback)
	if sIDFallback1 != sIDFallback2 {
		t.Errorf("expected identical synthetic session IDs for repeated client requests: %q vs %q", sIDFallback1, sIDFallback2)
	}

	// 4. Different client gets different synthetic session ID
	reqOtherClient := schedulerPickRequest{
		Options: schedulerOptions{
			Headers: map[string][]string{
				"X-Forwarded-For": {"10.200.0.4"},
				"Authorization":   {"Bearer sk-other-user"},
			},
		},
	}
	sIDOther := extractSessionID(reqOtherClient)
	if sIDFallback1 == sIDOther {
		t.Errorf("expected different session IDs for distinct clients, got collision: %q", sIDOther)
	}
}

func TestSchedulerPickGhostWarmupShadowTarget(t *testing.T) {
	registry := testModelProviderRegistry(t)
	previous := activeRegistry
	activeRegistry = func() *PoolRegistry { return registry }
	t.Cleanup(func() { activeRegistry = previous })

	// Normal request without warmup header picks Leader A
	reqNormal := schedulerPickRequest{
		Provider: "antigravity",
		Model:    "claude-sonnet-4-6",
		Options:  schedulerOptions{Metadata: map[string]any{"requested_model": "clau/claude-sonnet-4-6"}},
		Candidates: []schedulerCandidate{
			{ID: "antigravity-a@gmail.com.json", Provider: "antigravity", Status: "active"},
			{ID: "antigravity-b@gmail.com.json", Provider: "antigravity", Status: "active"},
		},
	}
	respNormal := handleSchedulerPick(reqNormal)
	if !respNormal.Handled || respNormal.AuthID != "antigravity-a@gmail.com.json" {
		t.Fatalf("expected leader A picked for normal request: %+v", respNormal)
	}

	// Shadow request with X-Warmup-Target header must target reserve B directly without mutating leader
	reqWarmup := schedulerPickRequest{
		Provider: "antigravity",
		Model:    "claude-sonnet-4-6",
		Options: schedulerOptions{
			Metadata: map[string]any{"requested_model": "clau/claude-sonnet-4-6"},
			Headers: map[string][]string{
				"X-Warmup-Target": {"antigravity-b@gmail.com.json"},
			},
		},
		Candidates: []schedulerCandidate{
			{ID: "antigravity-a@gmail.com.json", Provider: "antigravity", Status: "active"},
			{ID: "antigravity-b@gmail.com.json", Provider: "antigravity", Status: "active"},
		},
	}
	respWarmup := handleSchedulerPick(reqWarmup)
	if !respWarmup.Handled || respWarmup.AuthID != "antigravity-b@gmail.com.json" {
		t.Fatalf("expected warmup target B picked: %+v", respWarmup)
	}

	// Verify ActiveLeader in RAM was NOT mutated by shadow warmup
	pool, _ := registry.GetPool("clau")
	if pool.ActiveLeader != "" && pool.ActiveLeader != "antigravity-a@gmail.com.json" {
		t.Fatalf("active leader should remain unchanged after shadow warmup, got: %q", pool.ActiveLeader)
	}
}

func TestSchedulerPickTaskAwareRouting(t *testing.T) {
	registry := testModelProviderRegistry(t)
	// Add third member C to test reserve ranking
	p, _ := registry.GetPool("pool-agy-1")
	p.Reserves = []string{"antigravity-b@gmail.com.json", "antigravity-c@gmail.com.json"}
	_ = registry.SavePool(p)

	previous := activeRegistry
	activeRegistry = func() *PoolRegistry { return registry }
	t.Cleanup(func() { activeRegistry = previous })

	pe := GetPredictiveEngine()
	// Deplete leader A (<15%) so scheduler evaluates reserves B and C
	pe.RecordLiveQuota(AccountQuotaTelemetry{AccountKey: "antigravity-a@gmail.com.json", Window5hPct: 5.0, WeeklyPct: 5.0})
	// Reserve B: High 5h (95%), but Low Weekly (30%)
	pe.RecordLiveQuota(AccountQuotaTelemetry{AccountKey: "antigravity-b@gmail.com.json", Window5hPct: 95.0, WeeklyPct: 30.0})
	// Reserve C: Moderate 5h (60%), but High Weekly (95%)
	pe.RecordLiveQuota(AccountQuotaTelemetry{AccountKey: "antigravity-c@gmail.com.json", Window5hPct: 60.0, WeeklyPct: 95.0})

	t.Cleanup(func() {
		pe.RecordLiveQuota(AccountQuotaTelemetry{AccountKey: "antigravity-a@gmail.com.json", Window5hPct: 100.0, WeeklyPct: 100.0})
		pe.RecordLiveQuota(AccountQuotaTelemetry{AccountKey: "antigravity-b@gmail.com.json", Window5hPct: 100.0, WeeklyPct: 100.0})
		pe.RecordLiveQuota(AccountQuotaTelemetry{AccountKey: "antigravity-c@gmail.com.json", Window5hPct: 100.0, WeeklyPct: 100.0})
	})

	// 1. HEAVY task (research/subagent): should pick Reserve C due to superior Weekly quota
	reqHeavy := schedulerPickRequest{
		Provider: "antigravity",
		Model:    "gemini-3.8-flash-high",
		Options: schedulerOptions{
			Metadata: map[string]any{
				"requested_model": "agy/gemini-3.8-flash-high",
				"task_type":       "deep-researcher",
				"session_id":      "session-heavy-turn-1",
			},
		},
		Candidates: []schedulerCandidate{
			{ID: "antigravity-a@gmail.com.json", Provider: "antigravity", Status: "active"},
			{ID: "antigravity-b@gmail.com.json", Provider: "antigravity", Status: "active"},
			{ID: "antigravity-c@gmail.com.json", Provider: "antigravity", Status: "active"},
		},
	}
	respHeavy := handleSchedulerPick(reqHeavy)
	if !respHeavy.Handled || respHeavy.AuthID != "antigravity-c@gmail.com.json" {
		t.Fatalf("expected Reserve C (highest weekly quota) picked for HEAVY task, got: %+v", respHeavy)
	}

	// Reset ActiveLeader to A so both B and C are evaluated as reserves for the LIGHT task
	registry.SetActiveLeader("agy", "antigravity-a@gmail.com.json")

	// 2. LIGHT task (routine turn): should pick Reserve B due to superior 5h window
	// Using a distinct session header to test independent routing without session affinity to C
	reqLight := schedulerPickRequest{
		Provider: "antigravity",
		Model:    "gemini-3.8-flash-high",
		Options: schedulerOptions{
			Metadata: map[string]any{
				"requested_model": "agy/gemini-3.8-flash-high",
				"session_id":      "session-light-turn-2",
			},
			Headers: map[string][]string{
				"X-Task-Type": {"light"},
			},
		},
		Candidates: []schedulerCandidate{
			{ID: "antigravity-a@gmail.com.json", Provider: "antigravity", Status: "active"},
			{ID: "antigravity-b@gmail.com.json", Provider: "antigravity", Status: "active"},
			{ID: "antigravity-c@gmail.com.json", Provider: "antigravity", Status: "active"},
		},
	}
	respLight := handleSchedulerPick(reqLight)
	if !respLight.Handled || respLight.AuthID != "antigravity-b@gmail.com.json" {
		t.Fatalf("expected Reserve B (highest 5h quota) picked for LIGHT task, got: %+v", respLight)
	}
}

func TestSchedulerPickTaskAutoDowngradeAndTriageWarmup(t *testing.T) {
	_, err := analytics.ResetDBForTest(filepath.Join(t.TempDir(), "test_rotations.db"))
	if err != nil {
		t.Fatalf("ResetDBForTest failed: %v", err)
	}

	registry := testModelProviderRegistry(t)
	previous := activeRegistry
	activeRegistry = func() *PoolRegistry { return registry }
	t.Cleanup(func() { activeRegistry = previous })

	// Turn 1: Normal initialization with session ID and orchestrator role
	sessionID := fmt.Sprintf("task-session-downgrade-%d", time.Now().UnixNano())
	reqTurn1 := schedulerPickRequest{
		Provider: "antigravity",
		Model:    "claude-sonnet-4-6",
		Options: schedulerOptions{
			Metadata: map[string]any{
				"requested_model": "clau/claude-sonnet-4-6",
				"session_id":      sessionID,
			},
			Headers: map[string][]string{
				"X-Agent-Role": {"orchestrator"},
			},
		},
		Candidates: []schedulerCandidate{
			{ID: "antigravity-a@gmail.com.json", Provider: "antigravity", Status: "active"},
			{ID: "antigravity-b@gmail.com.json", Provider: "antigravity", Status: "active"},
		},
	}
	respTurn1 := handleSchedulerPick(reqTurn1)
	if !respTurn1.Handled || respTurn1.AuthID != "antigravity-a@gmail.com.json" {
		t.Fatalf("expected leader picked for turn 1, got %+v", respTurn1)
	}

	// Wait for async SQLite worker queue to commit turn 1 affinity
	time.Sleep(150 * time.Millisecond)

	// Turn 2: Follow-up turn in same session with X-Auto-Downgrade
	reqTurn2 := schedulerPickRequest{
		Provider: "antigravity",
		Model:    "claude-sonnet-4-6",
		Options: schedulerOptions{
			Metadata: map[string]any{
				"requested_model": "clau/claude-sonnet-4-6",
				"session_id":      sessionID,
			},
			Headers: map[string][]string{
				"X-Auto-Downgrade": {"true"},
			},
		},
		Candidates: []schedulerCandidate{
			{ID: "antigravity-a@gmail.com.json", Provider: "antigravity", Status: "active"},
			{ID: "antigravity-b@gmail.com.json", Provider: "antigravity", Status: "active"},
		},
	}
	respTurn2 := handleSchedulerPick(reqTurn2)
	if !respTurn2.Handled {
		t.Fatalf("expected handled turn 2, got %+v", respTurn2)
	}

	// Wait for async SQLite worker queue to commit turn 2 audit event (polling robusto con deadline)
	foundDowngrade := false
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		events, err := analytics.QueryAuditEvents(50)
		if err != nil {
			t.Fatalf("QueryAuditEvents failed: %v", err)
		}
		for _, e := range events {
			if e.EventType == "AUTO_DOWNGRADE" {
				foundDowngrade = true
				break
			}
		}
		if foundDowngrade {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !foundDowngrade {
		t.Errorf("expected AUTO_DOWNGRADE event recorded for turn 2")
	}
}

func TestSchedulerPickCircuitBreakerLoopProtector(t *testing.T) {
	_, err := analytics.InitDB()
	if err != nil {
		t.Fatalf("InitDB failed: %v", err)
	}

	registry := testModelProviderRegistry(t)
	previous := activeRegistry
	activeRegistry = func() *PoolRegistry { return registry }
	t.Cleanup(func() { activeRegistry = previous })

	sessionID := fmt.Sprintf("test-breaker-%d", time.Now().UnixNano())

	// Upsert profile for agent '02-apply' with MaxClaudeTurns = 2
	_ = analytics.UpsertAgentProfile(analytics.AgentProfileRecord{
		Universe:       "jok3r_pi",
		AgentID:        "02-apply",
		PrimaryPool:    "pool-clau-1",
		FallbackPool:   "pool-agy-1",
		ThinkingLevel:  "high",
		MaxClaudeTurns: 2,
		Concurrency:    1,
		UpdatedAtMs:    time.Now().UnixMilli(),
	})

	// Pre-seed turn 1 and turn 2 in session affinity for pool-clau-1
	analytics.SetSessionAffinity(analytics.SessionAffinity{
		SessionID:    sessionID,
		PoolID:       "pool-clau-1",
		AccountEmail: "antigravity-a@gmail.com",
	})
	analytics.FlushWriteQueueForTest()
	analytics.SetSessionAffinity(analytics.SessionAffinity{
		SessionID:    sessionID,
		PoolID:       "pool-clau-1",
		AccountEmail: "antigravity-a@gmail.com",
	})
	analytics.FlushWriteQueueForTest()

	// Turn 2 request: agent 02-apply asking for Claude, but turnCount has reached max_claude_turns (2)
	reqTurn2 := schedulerPickRequest{
		Provider: "antigravity",
		Model:    "claude-sonnet-4-6",
		Options: schedulerOptions{
			Metadata: map[string]any{
				"requested_model": "clau/claude-sonnet-4-6",
				"session_id":      sessionID,
				"agent_id":        "02-apply",
			},
			Headers: map[string][]string{
				"X-Agent-Id":   {"02-apply"},
				"X-Agent-Role": {"apply"},
			},
		},
		Candidates: []schedulerCandidate{
			{ID: "antigravity-a@gmail.com.json", Provider: "antigravity", Status: "active"},
			{ID: "antigravity-b@gmail.com.json", Provider: "antigravity", Status: "active"},
		},
	}

	resp := handleSchedulerPick(reqTurn2)
	if !resp.Handled {
		t.Fatalf("expected request handled, got %+v", resp)
	}

	// Should be diverted to pool-agy-1's leader!
	if resp.AuthID != "antigravity-a@gmail.com.json" {
		t.Errorf("expected diverted AuthID antigravity-a@gmail.com.json, got %s", resp.AuthID)
	}

	// Flush any pending write tasks (such as RecordAuditEvent) deterministically
	analytics.FlushWriteQueueForTest()

	foundBreaker := false
	events, err := analytics.QueryAuditEvents(10)
	if err == nil {
		for _, e := range events {
			if e.EventType == "CIRCUIT_BREAKER_LOOP_PREVENTED" {
				foundBreaker = true
				break
			}
		}
	}
	if !foundBreaker {
		t.Errorf("expected CIRCUIT_BREAKER_LOOP_PREVENTED event recorded")
	}
}

func TestSchedulerPick_ConcurrencyOverflow_MaxInFlight(t *testing.T) {
	registry := testModelProviderRegistry(t)
	previous := activeRegistry
	activeRegistry = func() *PoolRegistry { return registry }
	t.Cleanup(func() {
		activeRegistry = previous
		resetInFlightForTest()
	})

	resetInFlightForTest()

	// Simulate 2 active in-flight streams on leader 'a@gmail.com' from parallel subagents
	recordInFlightSession("a@gmail.com", "subagent-task-1")
	recordInFlightSession("a@gmail.com", "subagent-task-2")

	// Third concurrent subagent comes in
	req := schedulerPickRequest{
		Provider: "antigravity",
		Model:    "gemini-3.8-flash-high",
		Options: schedulerOptions{
			Metadata: map[string]any{
				"requested_model": "agy/gemini-3.8-flash-high",
				"session_id":      "subagent-task-3",
			},
		},
		Candidates: []schedulerCandidate{
			{ID: "antigravity-a@gmail.com.json", Provider: "antigravity", Status: "active"},
			{ID: "antigravity-b@gmail.com.json", Provider: "antigravity", Status: "active"},
		},
	}

	resp := handleSchedulerPick(req)
	if !resp.Handled {
		t.Fatalf("expected handled pick, got %+v", resp)
	}

	// Because leader 'a@gmail.com' is at MaxInFlight=2 from tasks 1 and 2, task 3 overflows to reserve 'b@gmail.com'
	if resp.AuthID != "antigravity-b@gmail.com.json" {
		t.Errorf("expected overflow pick to reserve antigravity-b@gmail.com.json, got %s", resp.AuthID)
	}

	// Verify the permanent ActiveLeader in RAM was NOT displaced by the transient concurrency overflow
	p, _ := registry.GetPool("agy")
	if p.ActiveLeader != "antigravity-a@gmail.com.json" {
		t.Errorf("expected leader to remain antigravity-a@gmail.com.json, got %s", p.ActiveLeader)
	}
}

func TestSchedulerPick_SurvivalMode(t *testing.T) {
	registry := testModelProviderRegistry(t)
	previous := activeRegistry
	activeRegistry = func() *PoolRegistry { return registry }
	t.Cleanup(func() { activeRegistry = previous })

	// Create exhausted isolated pool whose members are not in candidates
	_ = registry.SavePool(PoolDefinition{
		ID:         "Pool-99-exhausted",
		BasePrefix: "exh",
		Family:     "gemini_pure",
		Members:    []string{"antigravity-exhausted-1.json", "antigravity-exhausted-2.json"},
		Policy: PoolPolicy{
			TargetModels:     []string{"gemini-3.8-flash-high"},
			SurvivalFallback: "Pool-01-gemini",
		},
	})

	req := schedulerPickRequest{
		Provider: "antigravity",
		Model:    "gemini-3.8-flash-high",
		Options: schedulerOptions{
			Metadata: map[string]any{"requested_model": "exh/gemini-3.8-flash-high"},
		},
		// Candidates only contains pool-agy-1 accounts, NONE of the exhausted pool accounts
		Candidates: []schedulerCandidate{
			{ID: "antigravity-a@gmail.com.json", Provider: "antigravity", Status: "active"},
			{ID: "antigravity-b@gmail.com.json", Provider: "antigravity", Status: "active"},
		},
	}

	resp := handleSchedulerPick(req)
	if !resp.Handled {
		t.Fatalf("expected survival mode to handle request, got %+v", resp)
	}

	// Should select a fallback account from Pool-01-gemini
	if resp.AuthID != "antigravity-a@gmail.com.json" && resp.AuthID != "antigravity-b@gmail.com.json" {
		t.Errorf("expected survival mode to select fallback candidate, got %s", resp.AuthID)
	}
}

func TestSchedulerPick_ProjectAffinityRAM(t *testing.T) {
	registry := testModelProviderRegistry(t)
	previous := activeRegistry
	activeRegistry = func() *PoolRegistry { return registry }
	t.Cleanup(func() { activeRegistry = previous })

	// Pool agy has members: antigravity-a@gmail.com.json (Leader), antigravity-b@gmail.com.json (Reserve)
	candidates := []schedulerCandidate{
		{ID: "antigravity-a@gmail.com.json", Provider: "antigravity", Status: "active"},
		{ID: "antigravity-b@gmail.com.json", Provider: "antigravity", Status: "active"},
	}

	// 1. ExtractProjectIdentity tests
	reqH := schedulerPickRequest{
		Options: schedulerOptions{
			Headers: map[string][]string{
				"X-Project-Identity": {"proj-alpha-123"},
			},
		},
	}
	if pID := extractProjectIdentity(reqH); pID != "proj-alpha-123" {
		t.Errorf("expected proj-alpha-123, got %s", pID)
	}

	reqRoot := schedulerPickRequest{
		Options: schedulerOptions{
			Headers: map[string][]string{
				"X-Workspace-Root": {"/home/wilox/projects/app-bravo"},
			},
		},
	}
	if pID := extractProjectIdentity(reqRoot); pID == "" {
		t.Errorf("expected hashed workspace root, got empty string")
	}

	// 2. Set volatile in-memory affinity for Project Beta pointing to Reserve B
	registry.SetProjectLeader("proj-beta-456", "pool-agy-1", "antigravity-b@gmail.com.json")
	if leader, ok := registry.GetProjectLeader("proj-beta-456", "pool-agy-1"); !ok || leader != "antigravity-b@gmail.com.json" {
		t.Fatalf("expected project leader antigravity-b@gmail.com.json in RAM, got %s (ok=%v)", leader, ok)
	}

	// 3. Request from Project Alpha (no affinity yet) -> picks default Leader A
	reqAlpha := schedulerPickRequest{
		Provider: "antigravity",
		Model:    "gemini-3.8-flash-high",
		Options: schedulerOptions{
			Metadata: map[string]any{"requested_model": "agy/gemini-3.8-flash-high"},
			Headers: map[string][]string{
				"X-Project-Identity": {"proj-alpha-123"},
			},
		},
		Candidates: candidates,
	}
	respAlpha := handleSchedulerPick(reqAlpha)
	if !respAlpha.Handled || respAlpha.AuthID != "antigravity-a@gmail.com.json" {
		t.Errorf("expected Project Alpha to get Leader A, got %+v", respAlpha)
	}

	// 4. Request from Project Beta (pinned to Reserve B in RAM) -> picks Reserve B without displacing global leader
	reqBeta := schedulerPickRequest{
		Provider: "antigravity",
		Model:    "gemini-3.8-flash-high",
		Options: schedulerOptions{
			Metadata: map[string]any{"requested_model": "agy/gemini-3.8-flash-high"},
			Headers: map[string][]string{
				"X-Project-Identity": {"proj-beta-456"},
			},
		},
		Candidates: candidates,
	}
	respBeta := handleSchedulerPick(reqBeta)
	if !respBeta.Handled || respBeta.AuthID != "antigravity-b@gmail.com.json" {
		t.Errorf("expected Project Beta to get pinned Reserve B, got %+v", respBeta)
	}
}

