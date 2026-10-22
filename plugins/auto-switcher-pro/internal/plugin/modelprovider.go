package plugin

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"auto-switcher-pro/internal/analytics"
	"auto-switcher-pro/internal/license"
	"auto-switcher-pro/internal/version"
)

var totalRotations int64
var totalFailovers int64

var (
	inFlightMu       sync.Mutex
	inFlightSessions = make(map[string]map[string]time.Time) // accountKey -> sessionID -> lastSeen
)

// recordInFlightSession records an active request timestamp for a session on an account.
func recordInFlightSession(accountKey, sessionID string) {
	if sessionID == "" {
		sessionID = "anon"
	}
	inFlightMu.Lock()
	defer inFlightMu.Unlock()

	key := strings.ToLower(accountKey)
	if inFlightSessions[key] == nil {
		inFlightSessions[key] = make(map[string]time.Time)
	}
	inFlightSessions[key][sessionID] = time.Now()
}

// getActiveInFlightSessions counts concurrent active sessions on an account within window,
// excluding the caller's session to prevent sequential turns from self-throttling.
func getActiveInFlightSessions(accountKey, excludeSessionID string, window time.Duration) int {
	inFlightMu.Lock()
	defer inFlightMu.Unlock()

	cutoff := time.Now().Add(-window)
	key := strings.ToLower(accountKey)
	sessions := inFlightSessions[key]
	if sessions == nil {
		return 0
	}

	count := 0
	for sessID, t := range sessions {
		if sessID == excludeSessionID && sessID != "anon" {
			continue
		}
		if t.After(cutoff) {
			count++
		}
	}
	return count
}

func resetInFlightForTest() {
	inFlightMu.Lock()
	defer inFlightMu.Unlock()
	inFlightSessions = make(map[string]map[string]time.Time)
}

func init() {
	license.SetTelemetryProvider(func() license.TelemetryInfo {
		var prefixes []string
		if activeRegistry != nil {
			if reg := activeRegistry(); reg != nil {
				pools := reg.ListPools()
				prefixes = make([]string, 0, len(pools))
				for _, p := range pools {
					prefixes = append(prefixes, p.BasePrefix)
				}
			}
		}
		persistedReqs, persistedFailovers := license.GetPersistedUsage()
		curReqs := atomic.LoadInt64(&totalRotations)
		if curReqs < persistedReqs {
			curReqs = persistedReqs
		}
		curFail := atomic.LoadInt64(&totalFailovers)
		if curFail < persistedFailovers {
			curFail = persistedFailovers
		}
		return license.TelemetryInfo{
			Version:        version.Version,
			Rotations:      curReqs,
			TotalFailovers: curFail,
			ActivePools:    prefixes,
		}
	})
	StartGhostWarmupDaemon()
}

// Plugin-side RPC methods exposed by the CLIProxyAPI plugin host for the
// model_provider, model_router and scheduler capabilities (sdk/pluginabi names).
const (
	methodModelStatic   = "model.static"
	methodModelRegister = "model.register"
	methodModelForAuth  = "model.for_auth"
	methodModelRoute    = "model.route"
	methodSchedulerPick = "scheduler.pick"
)

// antigravityProviderKey is the built-in provider key that owns the physical
// Antigravity OAuth credentials. The plugin registers its virtual pool models
// under this provider so the host resolves and schedules them natively.
const antigravityProviderKey = "antigravity"

// poolPrefixTargetPattern matches the reserve numbering convention of a pool
// base prefix (e.g. "clau_1" for base "clau"). Alphabetic suffixes belong to
// sibling pools, never to this one.
var poolReserveNumberPattern = regexp.MustCompile(`_\d+$`)

// Wire payloads. The CLIProxyAPI host marshals SDK request structs without json
// tags (Go field names, PascalCase) and decodes plugin responses into the same
// structs case-insensitively, so responses also use Go field names.

type modelStaticRequest struct {
	Plugin map[string]any `json:"Plugin"`
	Host   map[string]any `json:"Host"`
}

type modelForAuthRequest struct {
	Plugin       map[string]any    `json:"Plugin"`
	AuthID       string            `json:"AuthID"`
	AuthProvider string            `json:"AuthProvider"`
	StorageJSON  []byte            `json:"StorageJSON"`
	Metadata     map[string]any    `json:"Metadata"`
	Attributes   map[string]string `json:"Attributes"`
}

type modelRouteRequest struct {
	Plugin         map[string]any      `json:"Plugin"`
	PluginID       string              `json:"PluginID"`
	SourceFormat   string              `json:"SourceFormat"`
	RequestedModel string              `json:"RequestedModel"`
	Stream         bool                `json:"Stream"`
	Metadata       map[string]any      `json:"Metadata"`
	Headers        map[string][]string `json:"Headers"`
}

// pluginModelInfo mirrors sdk/pluginapi.ModelInfo (untagged fields). Only the
// identity fields the host registry consumes are populated.
type pluginModelInfo struct {
	ID          string `json:"ID"`
	Object      string `json:"Object"`
	Created     int64  `json:"Created"`
	OwnedBy     string `json:"OwnedBy"`
	DisplayName string `json:"DisplayName"`
}

type modelResponse struct {
	Provider string            `json:"Provider"`
	Models   []pluginModelInfo `json:"Models"`
}

type modelRouteResponse struct {
	Handled     bool   `json:"Handled"`
	TargetKind  string `json:"TargetKind"`
	Target      string `json:"Target,omitempty"`
	TargetModel string `json:"TargetModel,omitempty"`
	Reason      string `json:"Reason,omitempty"`
}

// schedulerPickRequest mirrors sdk/pluginapi.SchedulerPickRequest. Candidates
// arrive already filtered by availability (cooldowns excluded) and model support.
type schedulerPickRequest struct {
	Plugin     map[string]any       `json:"Plugin"`
	Provider   string               `json:"Provider"`
	Providers  []string             `json:"Providers"`
	Model      string               `json:"Model"`
	Stream     bool                 `json:"Stream"`
	Options    schedulerOptions     `json:"Options"`
	Candidates []schedulerCandidate `json:"Candidates"`
}

type schedulerOptions struct {
	Headers  map[string][]string `json:"Headers"`
	Metadata map[string]any      `json:"Metadata"`
}

type schedulerCandidate struct {
	ID         string            `json:"ID"`
	Provider   string            `json:"Provider"`
	Priority   int               `json:"Priority"`
	Status     string            `json:"Status"`
	Attributes map[string]string `json:"Attributes"`
}

// schedulerPickResponse mirrors sdk/pluginapi.SchedulerPickResponse (the SDK
// decodes both PascalCase and snake_case field names).
type schedulerPickResponse struct {
	AuthID          string `json:"AuthID,omitempty"`
	DelegateBuiltin string `json:"DelegateBuiltin,omitempty"`
	Handled         bool   `json:"Handled"`
	Reject          bool   `json:"Reject,omitempty"`
	RejectReason    string `json:"RejectReason,omitempty"`
	RejectCode      string `json:"RejectCode,omitempty"`
}

// activeRegistry returns the pool registry used by the model provider handlers.
// Overridable in tests to isolate fixture state from the process singleton.
var activeRegistry = func() *PoolRegistry { return DefaultRegistry() }

// baselineAntigravityModels is the standard Antigravity catalog published
// natively for credentials without pool membership. It keeps free accounts
// serving their native family while the plugin owns the provider catalog.
// Only confirmed active models supported upstream are listed here.
var baselineAntigravityModels = []pluginModelInfo{
	{ID: "gemini-3.8-flash-high", Object: "model", OwnedBy: antigravityProviderKey, DisplayName: "Gemini 3.8 Flash High"},
	{ID: "gemini-3.5-flash-lite", Object: "model", OwnedBy: antigravityProviderKey, DisplayName: "Gemini 3.5 Flash Lite"},
	{ID: "gemini-3.1-flash-lite", Object: "model", OwnedBy: antigravityProviderKey, DisplayName: "Gemini 3.1 Flash Lite"},
	{ID: "gemini-3-flash", Object: "model", OwnedBy: antigravityProviderKey, DisplayName: "Gemini 3 Flash"},
}

// deprecatedModelFallbacks maps retired or discontinued upstream model names
// to their current valid active counterpart in the same family.
// This prevents upstream HTTP 404s and 12-hour cascading cooldowns across all accounts.
var deprecatedModelFallbacks = map[string]string{
	"gemini-3.7-flash-high":  "gemini-3.8-flash-high",
	"gemini-3.6-flash-high":  "gemini-3.8-flash-high",
	"gemini-3.1-pro-low":     "gemini-3.8-flash-high",
	"gemini-pro-agent":       "gemini-3.8-flash-high",
	"gemini-2.5-flash-high":  "gemini-3.8-flash-high",
	"gemini-3.1-flash-image": "gemini-3.8-flash-high",
}

// dynamicDeprecatedCache holds runtime-learned model fallbacks in memory.
var dynamicDeprecatedCache sync.Map

// isConfirmedActiveModel reports whether the given model is in the active baseline.
func isConfirmedActiveModel(id string) bool {
	idLower := strings.ToLower(strings.TrimSpace(id))
	for _, m := range baselineAntigravityModels {
		if strings.EqualFold(m.ID, idLower) {
			return true
		}
	}
	if idLower == "gemini-3.8-flash-n" || idLower == "claude-sonnet-4-6" || idLower == "claude-opus-4-6-thinking" {
		return true
	}
	return false
}

// fuzzyFamilyFallback intelligently maps an unknown or newly retired model name
// to the best active canonical counterpart within the same family and tier.
func fuzzyFamilyFallback(model string) string {
	lower := strings.ToLower(strings.TrimSpace(model))
	if lower == "" {
		return ""
	}

	// 1. Google Gemini family deprecated/retired patterns
	if strings.Contains(lower, "gemini") {
		if strings.Contains(lower, "3.7") ||
			strings.Contains(lower, "3.6") ||
			strings.Contains(lower, "3.1-pro") ||
			strings.Contains(lower, "pro-agent") ||
			strings.Contains(lower, "2.5-flash-high") ||
			strings.Contains(lower, "flash-image") ||
			strings.Contains(lower, "deprecated") ||
			strings.Contains(lower, "flash-super") ||
			strings.Contains(lower, "custom-pro") {
			return "gemini-3.8-flash-high"
		}
	}

	// 2. Claude family (Antigravity package):
	if strings.Contains(lower, "claude") || strings.Contains(lower, "opus") || strings.Contains(lower, "sonnet") {
		if strings.Contains(lower, "opus-custom") {
			return "claude-opus-4-6-thinking"
		}
		if strings.Contains(lower, "sonnet-custom") {
			return "claude-sonnet-4-6"
		}
	}

	return model
}

// RegisterDynamicDeprecatedModel adds a runtime-detected deprecated model mapping.
func RegisterDynamicDeprecatedModel(deprecated string, activeFallback string) {
	d := strings.ToLower(strings.TrimSpace(deprecated))
	f := strings.TrimSpace(activeFallback)
	if d != "" && f != "" {
		dynamicDeprecatedCache.Store(d, f)
	}
}

// ResolveActiveModelFallback rewrites any known or fuzzy-detected retired upstream model names
// to their current valid active counterpart in the same family.
func ResolveActiveModelFallback(model string) string {
	trimmed := strings.TrimSpace(model)
	if trimmed == "" {
		return ""
	}
	lower := strings.ToLower(trimmed)

	// 1. Exact confirmed active match -> return unchanged
	if isConfirmedActiveModel(lower) {
		return trimmed
	}

	// 2. Exact static mapping match
	if fallback, ok := deprecatedModelFallbacks[lower]; ok {
		return fallback
	}

	// 3. Dynamic runtime-learned deprecation cache
	if v, ok := dynamicDeprecatedCache.Load(lower); ok {
		if fallback, ok := v.(string); ok && fallback != "" {
			return fallback
		}
	}

	// 4. Fuzzy family fallback for unknown or future retired models
	fuzzy := fuzzyFamilyFallback(trimmed)
	if fuzzy != trimmed && fuzzy != "" {
		dynamicDeprecatedCache.Store(lower, fuzzy)
		return fuzzy
	}

	return trimmed
}

// HarvestUpstreamModelDeprecation captures an upstream 404/410/model_not_found error
// at runtime, computes the fuzzy canonical replacement, caches it in dynamicDeprecatedCache,
// and auto-migrates registered pool definitions in RAM and persistent state.
func HarvestUpstreamModelDeprecation(rawModel string, statusCode int) (fallback string, autoMigrated bool) {
	trimmed := strings.TrimSpace(rawModel)
	if trimmed == "" {
		return "", false
	}
	// Extract bare model
	bare := cleanBareModelID(trimmed)
	lower := strings.ToLower(bare)

	// If statusCode is 404 or 410, this model is retired upstream
	if statusCode == 404 || statusCode == 410 || strings.Contains(lower, "not_found") {
		fb := fuzzyFamilyFallback(bare)
		if fb != "" && fb != bare {
			dynamicDeprecatedCache.Store(lower, fb)
			dynamicDeprecatedCache.Store(strings.ToLower(trimmed), fb)

			// Auto-sanear pools registrados si hacían referencia a este modelo extinto
			reg := DefaultRegistry()
			migrated := false
			for _, p := range reg.ListPools() {
				poolChanged := false
				for acc, m := range p.MemberModels {
					if strings.EqualFold(m, bare) || strings.EqualFold(m, trimmed) {
						p.MemberModels[acc] = fb
						poolChanged = true
					}
				}
				for i, tm := range p.Policy.TargetModels {
					if strings.EqualFold(tm, bare) || strings.EqualFold(tm, trimmed) {
						p.Policy.TargetModels[i] = fb
						poolChanged = true
					}
				}
				if poolChanged {
					_ = reg.SavePool(p)
					migrated = true
				}
			}
			return fb, migrated
		}
	}
	return ResolveActiveModelFallback(trimmed), false
}

// cloneBaseline returns a copy of the baseline catalog.
func cloneBaseline() []pluginModelInfo {
	out := make([]pluginModelInfo, len(baselineAntigravityModels))
	copy(out, baselineAntigravityModels)
	return out
}

// cleanBareModelID strips any leading provider/pool prefixes (e.g. agy/agy/gemini-3-flash -> gemini-3-flash)
// and normalizes deprecated models to their active fallback.
func cleanBareModelID(id string) string {
	cur := strings.TrimSpace(id)
	for {
		idx := strings.Index(cur, "/")
		if idx >= 0 && idx < len(cur)-1 {
			cur = cur[idx+1:]
		} else {
			break
		}
	}
	return ResolveActiveModelFallback(cur)
}

// poolTargets extracts the pool's target model list (empty when unset or paused).
func poolTargets(pool PoolDefinition) []string {
	if !pool.IsEnabled() {
		return nil
	}
	if pool.Policy.DisableIsolation {
		// Wildcard pools serve every family: no virtual catalog narrowing.
		return nil
	}
	seen := make(map[string]struct{})
	targets := make([]string, 0, len(pool.Policy.TargetModels))
	for _, t := range pool.Policy.TargetModels {
		bare := cleanBareModelID(t)
		if bare != "" {
			if _, dup := seen[bare]; !dup {
				seen[bare] = struct{}{}
				targets = append(targets, bare)
			}
		}
	}
	return targets
}

// prefixMatchesPool reports whether an auth disk prefix belongs to the pool
// base prefix (exact or numeric reserve suffix).
func prefixMatchesPool(prefix, basePrefix string) bool {
	prefix = strings.TrimSpace(prefix)
	base := strings.TrimSpace(basePrefix)
	if prefix == "" || base == "" {
		return false
	}
	if prefix == base {
		return true
	}
	if !strings.HasPrefix(prefix, base+"_") {
		return false
	}
	suffix := strings.TrimPrefix(prefix, base+"_")
	return poolReserveNumberPattern.MatchString("_" + suffix)
}

// poolContainsAuth reports whether the auth file is a member of the pool.
func poolContainsAuth(pool PoolDefinition, authFileName string) bool {
	name := strings.TrimSpace(authFileName)
	if name == "" {
		return false
	}
	for _, member := range pool.AllMembers() {
		if strings.EqualFold(strings.TrimSpace(member), name) {
			return true
		}
	}
	return false
}

// memberPoolsForAuth returns the pools whose membership includes the auth.
func memberPoolsForAuth(registry *PoolRegistry, authFileName string) []PoolDefinition {
	all := registry.ListPools()
	members := make([]PoolDefinition, 0, len(all))
	for _, pool := range all {
		if poolContainsAuth(pool, authFileName) {
			members = append(members, pool)
		}
	}
	return members
}

// sortModelsByID orders models deterministically by ID.
func sortModelsByID(models []pluginModelInfo) {
	sort.Slice(models, func(i, j int) bool { return models[i].ID < models[j].ID })
}

// modelCatalogForAuth computes the complete model catalog the host must
// register for one auth, derived from its pool memberships and baseline models:
//   - Preserves all native baseline models (gemini-3.8-flash-high, gemini-3.7-flash-high, etc.)
//     so the native CPAMC "Auth Files Management" credential modal displays its full native catalog.
//   - Includes bare targets for pools the account serves (e.g. claude-sonnet-4-6).
//   - Strictly excludes virtual pool facades (Pool-01-gemini) and prefixed routes (agy/...)
//     to prevent contamination of the native credential inspection modal.
func modelCatalogForAuth(diskPrefix string, memberPools []PoolDefinition) []pluginModelInfo {
	seen := make(map[string]struct{})
	models := make([]pluginModelInfo, 0, 32)
	add := func(id string) {
		id = strings.TrimSpace(id)
		if id == "" {
			return
		}
		if _, dup := seen[id]; dup {
			return
		}
		seen[id] = struct{}{}
		display := id
		if slash := strings.Index(id, "/"); slash >= 0 && slash < len(id)-1 {
			display = id[slash+1:]
		}
		models = append(models, pluginModelInfo{
			ID:          id,
			Object:      "model",
			OwnedBy:     antigravityProviderKey,
			DisplayName: display,
		})
	}

	// Always seed with the complete native Antigravity baseline catalog
	for _, m := range baselineAntigravityModels {
		add(m.ID)
	}

	// Add any bare pool targets (e.g. claude-sonnet-4-6), never virtual pool facades or prefixed routes
	for _, pool := range memberPools {
		targets := poolTargets(pool)
		for _, target := range targets {
			cleanTarget := cleanBareModelID(target)
			if cleanTarget != "" && !strings.HasPrefix(strings.ToLower(cleanTarget), "pool-") {
				add(cleanTarget)
			}
		}
	}

	sortModelsByID(models)
	return models
}

// poolPrefixedCatalog computes the static catalog of virtual pool routes:
// Exposes the clean sovereign Pool Identifier (e.g. "Pool-01-gemini", "Pool-02-gemini")
// as well as "<base>/<target>" for every pool target, plus the baseline when no pools
// exist (keeps the provider match key armed at host sweep time).
func poolPrefixedCatalog(registry *PoolRegistry) []pluginModelInfo {
	pools := registry.ListPools()
	models := make([]pluginModelInfo, 0, 16)
	seen := make(map[string]struct{})
	addModel := func(id, display string) {
		id = strings.TrimSpace(id)
		if id == "" {
			return
		}
		if _, dup := seen[id]; dup {
			return
		}
		seen[id] = struct{}{}
		models = append(models, pluginModelInfo{
			ID:          id,
			Object:      "model",
			OwnedBy:     antigravityProviderKey,
			DisplayName: display,
		})
	}

	for _, pool := range pools {
		if !pool.IsEnabled() {
			continue
		}
		cleanPoolName := strings.TrimSpace(pool.DisplayName)
		if cleanPoolName == "" {
			cleanPoolName = strings.TrimSpace(pool.ID)
		}
		if cleanPoolName != "" {
			addModel(cleanPoolName, cleanPoolName)
		}
	}

	if len(models) == 0 {
		return cloneBaseline()
	}
	sortModelsByID(models)
	return models
}

// routeDecisionFor resolves a model.route request:
//  1. Clean Pool Identifier ("Pool-01-gemini"): resolves dynamically to the configured
//     model of the current ActiveLeader account in RAM.
//  2. Legacy "<base>/<target>" route: rewrites to the bare target model on the built-in
//     antigravity provider.
func routeDecisionFor(registry *PoolRegistry, requestedModel string) modelRouteResponse {
	trimmed := strings.TrimSpace(requestedModel)
	if trimmed == "" {
		return modelRouteResponse{}
	}

	// Clean any provider namespace prefix (e.g. "cpamc/Pool-01-gemini", "cliproxy/...")
	for _, ns := range []string{"cpamc/", "cliproxy/", "cliproxyapi/"} {
		if strings.HasPrefix(strings.ToLower(trimmed), ns) {
			trimmed = strings.TrimSpace(trimmed[len(ns):])
			break
		}
	}

	// 0. Deprecated model auto-fallback interceptor:
	// If the requested model is a known retired or fuzzy-matched deprecated model (e.g. gemini-3.7-flash-high),
	// route it directly to the active model to prevent upstream 404 and cascading cooldowns.
	resolvedFallback := ResolveActiveModelFallback(trimmed)
	if !strings.EqualFold(resolvedFallback, trimmed) && !strings.Contains(trimmed, "/") {
		return modelRouteResponse{
			Handled:     true,
			TargetKind:  "provider",
			Target:      antigravityProviderKey,
			TargetModel: resolvedFallback,
			Reason:      fmt.Sprintf("auto-switcher-pro deprecated model auto-fallback (%s -> %s)", trimmed, resolvedFallback),
		}
	}

	slash := strings.Index(trimmed, "/")
	if slash <= 0 {
		// Direct Clean Pool Identifier invocation (e.g. "Pool-01-gemini")
		pool, ok := registry.GetPool(trimmed)
		if !ok || !pool.IsEnabled() {
			return modelRouteResponse{}
		}
		// Only treat bare strings without slash as pool routes if they match the Pool ID / DisplayName
		// (avoid intercepting native bare models like "gemini-3-flash").
		if !strings.EqualFold(trimmed, pool.ID) && !strings.EqualFold(trimmed, pool.DisplayName) && !strings.HasPrefix(strings.ToLower(trimmed), "pool-") {
			return modelRouteResponse{}
		}
		activeAuth := strings.TrimSpace(pool.ActiveLeader)
		if activeAuth == "" {
			activeAuth = strings.TrimSpace(pool.LeaderAuth)
		}
		// Armonización estricta: resolver TargetModel contra el objetivo especialista soberano del pool
		// garantizando que cualquier miembro que scheduler.pick elija reciba el mismo modelo válido.
		canonicalTarget := ""
		targets := poolTargets(pool)
		if len(targets) > 0 && strings.TrimSpace(targets[0]) != "" {
			canonicalTarget = targets[0]
		}
		if canonicalTarget == "" {
			canonicalTarget = pool.ActiveModelForAccount(activeAuth)
		}
		resolvedModel := ResolveActiveModelFallback(canonicalTarget)
		return modelRouteResponse{
			Handled:     true,
			TargetKind:  "provider",
			Target:      antigravityProviderKey,
			TargetModel: resolvedModel,
			Reason:      fmt.Sprintf("auto-switcher-pro sovereign pool route (%s -> %s)", trimmed, resolvedModel),
		}
	}

	if slash >= len(trimmed)-1 {
		return modelRouteResponse{}
	}

	base := trimmed[:slash]
	rest := trimmed[slash+1:]
	pool, ok := registry.GetPool(base)
	if !ok || !pool.IsEnabled() {
		return modelRouteResponse{}
	}

	resolvedRest := ResolveActiveModelFallback(rest)
	for _, target := range poolTargets(pool) {
		if strings.EqualFold(target, rest) || strings.EqualFold(target, resolvedRest) {
			return modelRouteResponse{
				Handled:     true,
				TargetKind:  "provider",
				Target:      antigravityProviderKey,
				TargetModel: resolvedRest,
				Reason:      fmt.Sprintf("auto-switcher-pro 2N pool route (%s)", pool.BasePrefix),
			}
		}
	}
	return modelRouteResponse{}
}

// parseAuthDiskPrefix extracts the routing prefix from the auth file JSON
// delivered in the model.for_auth request.
func parseAuthDiskPrefix(storageJSON []byte) string {
	if len(storageJSON) == 0 {
		return ""
	}
	var payload struct {
		Prefix string `json:"prefix"`
	}
	if err := json.Unmarshal(storageJSON, &payload); err != nil {
		return ""
	}
	return strings.TrimSpace(payload.Prefix)
}

// handleModelStatic serves model.static: the static virtual pool route catalog.
func handleModelStatic() modelResponse {
	return modelResponse{
		Provider: antigravityProviderKey,
		Models:   poolPrefixedCatalog(activeRegistry()),
	}
}

// handleModelForAuth serves model.for_auth: the per-auth model catalog.
func handleModelForAuth(req modelForAuthRequest) modelResponse {
	authID := strings.TrimSpace(req.AuthID)
	diskPrefix := parseAuthDiskPrefix(req.StorageJSON)
	memberPools := memberPoolsForAuth(activeRegistry(), authID)
	return modelResponse{
		Provider: antigravityProviderKey,
		Models:   modelCatalogForAuth(diskPrefix, memberPools),
	}
}

// handleModelRoute serves model.route.
func handleModelRoute(req modelRouteRequest) modelRouteResponse {
	return routeDecisionFor(activeRegistry(), req.RequestedModel)
}

// extractSessionID extracts an active session identifier from request headers or metadata.
// When no explicit session headers exist (e.g. external scripts, curl, Aider, Python),
// it generates a deterministic synthetic affinity ID from Client IP and Authorization token
// to preserve Google Prompt Caching for all external clients.
func extractSessionID(req schedulerPickRequest) string {
	if req.Options.Headers != nil {
		for k, vals := range req.Options.Headers {
			if strings.EqualFold(k, "x-session-id") || strings.EqualFold(k, "pi-session-id") || strings.EqualFold(k, "session-id") {
				if len(vals) > 0 && strings.TrimSpace(vals[0]) != "" {
					return strings.TrimSpace(vals[0])
				}
			}
		}
	}
	if req.Options.Metadata != nil {
		if s, ok := req.Options.Metadata["session_id"].(string); ok && strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
	}

	// Universal Fallback: derive synthetic affinity from Client IP and/or Authorization token
	if req.Options.Headers != nil {
		var clientIP, authToken string
		for k, vals := range req.Options.Headers {
			if len(vals) == 0 || strings.TrimSpace(vals[0]) == "" {
				continue
			}
			val := strings.TrimSpace(vals[0])
			if strings.EqualFold(k, "x-forwarded-for") || strings.EqualFold(k, "x-real-ip") || strings.EqualFold(k, "remote-addr") || strings.EqualFold(k, "cf-connecting-ip") {
				if clientIP == "" {
					if comma := strings.Index(val, ","); comma > 0 {
						clientIP = strings.TrimSpace(val[:comma])
					} else {
						clientIP = val
					}
				}
			} else if strings.EqualFold(k, "authorization") {
				authToken = val
			}
		}
		if clientIP != "" || authToken != "" {
			h := sha256.Sum256([]byte(clientIP + "|" + authToken))
			return "client-" + hex.EncodeToString(h[:8])
		}
	}

	return ""
}

// extractProjectIdentity extracts a project identifier from request headers or metadata.
// When headers like x-project-identity or x-workspace-root are passed, it generates a
// consistent project key to isolate Prompt Cache across multi-project environments.
func extractProjectIdentity(req schedulerPickRequest) string {
	if req.Options.Headers != nil {
		for k, vals := range req.Options.Headers {
			if strings.EqualFold(k, "x-project-identity") || strings.EqualFold(k, "pi-project-identity") {
				if len(vals) > 0 && strings.TrimSpace(vals[0]) != "" {
					return strings.TrimSpace(vals[0])
				}
			}
			if strings.EqualFold(k, "x-workspace-root") || strings.EqualFold(k, "pi-workspace-root") {
				if len(vals) > 0 && strings.TrimSpace(vals[0]) != "" {
					root := strings.TrimSpace(vals[0])
					h := sha256.Sum256([]byte(root))
					return hex.EncodeToString(h[:8])
				}
			}
		}
	}
	if req.Options.Metadata != nil {
		if s, ok := req.Options.Metadata["project_identity"].(string); ok && strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
		if s, ok := req.Options.Metadata["workspace_root"].(string); ok && strings.TrimSpace(s) != "" {
			root := strings.TrimSpace(s)
			h := sha256.Sum256([]byte(root))
			return hex.EncodeToString(h[:8])
		}
	}
	return ""
}

// extractTaskType classifies the request into HEAVY (subagents, deep research, heavy audits)
// or LIGHT (routine queries, simple turns) based on headers and metadata.
func extractTaskType(req schedulerPickRequest) string {
	if req.Options.Headers != nil {
		for k, vals := range req.Options.Headers {
			if strings.EqualFold(k, "x-task-type") || strings.EqualFold(k, "x-pi-task") {
				if len(vals) > 0 && strings.TrimSpace(vals[0]) != "" {
					val := strings.ToLower(strings.TrimSpace(vals[0]))
					if strings.Contains(val, "heavy") || strings.Contains(val, "research") || strings.Contains(val, "subagent") {
						return "HEAVY"
					}
					return "LIGHT"
				}
			}
		}
	}
	if req.Options.Metadata != nil {
		for _, key := range []string{"task_type", "task", "agent", "subagent"} {
			if v, ok := req.Options.Metadata[key]; ok {
				if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
					sLower := strings.ToLower(strings.TrimSpace(s))
					if strings.Contains(sLower, "research") || strings.Contains(sLower, "subagent") || strings.Contains(sLower, "heavy") {
						return "HEAVY"
					}
				}
			}
		}
	}
	return "LIGHT"
}

// schedulerPickCascade resolves auth selection for pool requests with the
// Líder -> Cascading Reserves semantics: the leader serves while available and
// reserves take over in cascade order. The host delivers Candidates already
// filtered by availability (cooldowns excluded) and model support, so picking
// the first cascade member present IS quota-aware failover.
func schedulerPickCascade(registry *PoolRegistry, req schedulerPickRequest) schedulerPickResponse {
	// Verificar si la licencia permite rotación o si el periodo de prueba expiró
	licStatus := license.GetLicenseStatus()
	if !licStatus.CanRotate {
		// Licencia expirada: no permitir failover ni cascada a cuentas de reserva
		return schedulerPickResponse{Handled: false}
	}

	// 1) Pool identity from the original client model ("clau/claude-sonnet-4-6")
	// carried by the host in the requested_model metadata key.
	originalModel := ""
	if req.Options.Metadata != nil {
		if v, ok := req.Options.Metadata["requested_model"]; ok {
			if s, ok := v.(string); ok {
				originalModel = strings.TrimSpace(s)
			}
		}
	}
	var pool *PoolDefinition
	if slash := strings.Index(originalModel, "/"); slash > 0 {
		if candidate, ok := registry.GetPool(originalModel[:slash]); ok && candidate.IsEnabled() {
			rest := originalModel[slash+1:]
			for _, target := range poolTargets(candidate) {
				if strings.EqualFold(target, rest) {
					pool = &candidate
					break
				}
			}
		}
	} else if originalModel != "" {
		// Clean Pool Identifier (e.g. "Pool-01-gemini")
		if candidate, ok := registry.GetPool(originalModel); ok && candidate.IsEnabled() {
			if strings.EqualFold(originalModel, candidate.ID) ||
				strings.EqualFold(originalModel, candidate.DisplayName) ||
				strings.HasPrefix(strings.ToLower(originalModel), "pool-") {
				pool = &candidate
			}
		}
	}
	if pool == nil {
		// Not a pool request (native credential or non-pool model): native scheduler.
		return schedulerPickResponse{Handled: false}
	}

	sessionID := extractSessionID(req)
	projectID := extractProjectIdentity(req)
	turnCount := 1
	if sessionID != "" {
		if aff, ok := analytics.GetSessionAffinity(sessionID, pool.ID); ok && aff.TurnCount > 0 {
			turnCount = aff.TurnCount
		}
	}

	// Identify role and agent_id
	isOrchestrator := false
	agentID := ""
	if req.Options.Headers != nil {
		for k, vals := range req.Options.Headers {
			if len(vals) == 0 {
				continue
			}
			val := strings.ToLower(strings.TrimSpace(vals[0]))
			if strings.EqualFold(k, "x-agent-role") || strings.EqualFold(k, "x-client-role") {
				if strings.Contains(val, "orchestrator") || strings.Contains(val, "triage") {
					isOrchestrator = true
				}
			}
			if strings.EqualFold(k, "x-agent-id") {
				agentID = strings.TrimSpace(vals[0])
			}
		}
	}
	if req.Options.Metadata != nil {
		if v, ok := req.Options.Metadata["agent_id"].(string); ok && strings.TrimSpace(v) != "" {
			agentID = strings.TrimSpace(v)
		}
		if v, ok := req.Options.Metadata["role"].(string); ok {
			if strings.Contains(strings.ToLower(v), "orchestrator") {
				isOrchestrator = true
			}
		}
	}
	if strings.Contains(strings.ToLower(agentID), "orchestrator") {
		isOrchestrator = true
	}

	// CIRCUIT BREAKER / LOOP PROTECTOR:
	// If a subagent/worker iterates on expensive Claude models for >= maxClaudeTurns (default 3),
	// automatically divert to Gemini Flash High to protect the team's 5h Claude budget.
	isClaudePool := strings.Contains(strings.ToLower(pool.ID), "claude") ||
		strings.Contains(strings.ToLower(pool.DisplayName), "claude") ||
		strings.Contains(strings.ToLower(pool.Family), "claude")

	maxClaudeTurns := 3
	if agentID != "" {
		if recs, err := analytics.GetAgentProfiles(""); err == nil {
			for _, rec := range recs {
				if rec.AgentID == agentID && rec.MaxClaudeTurns >= 0 {
					maxClaudeTurns = rec.MaxClaudeTurns
					break
				}
			}
		}
	}

	if !isOrchestrator && isClaudePool && maxClaudeTurns > 0 && turnCount >= maxClaudeTurns {
		var divertedPool *PoolDefinition
		if dp, ok := registry.GetPool("Pool-01-gemini"); ok && dp.IsEnabled() {
			divertedPool = &dp
		}
		if divertedPool == nil {
			for _, p := range registry.ListPools() {
				if p.IsEnabled() && (p.Family == "gemini_pure" || strings.Contains(strings.ToLower(p.ID), "gemini") || strings.Contains(strings.ToLower(p.ID), "agy")) {
					divertedPool = &p
					break
				}
			}
		}

		if divertedPool != nil {
			analytics.RecordAuditEvent(analytics.AuditEvent{
				PoolID:         pool.ID,
				EventType:      "CIRCUIT_BREAKER_LOOP_PREVENTED",
				TriggerReason:  fmt.Sprintf("exceeded_max_claude_turns_%d", maxClaudeTurns),
				PreviousLeader: pool.ID,
				NewLeader:      divertedPool.ID,
				LatencyMs:      1,
				StatusCode:     200,
				DetailsJSON:    fmt.Sprintf(`{"turn_count":%d,"agent_id":"%s","diverted_to":"%s","max_claude_turns":%d}`, turnCount, agentID, divertedPool.ID, maxClaudeTurns),
			})
			pool = divertedPool
		}
	}

	// 2) Symmetrical Pool Members with Dynamic Active Leader ordering:
	// Start from the current ActiveLeader in RAM (if set), followed by remaining pool members.
	allMembers := pool.AllMembers()
	cascade := make([]string, 0, len(allMembers))
	currentActive := strings.TrimSpace(pool.ActiveLeader)
	if currentActive != "" {
		for _, m := range allMembers {
			if strings.EqualFold(m, currentActive) {
				cascade = append(cascade, m)
				break
			}
		}
		for _, m := range allMembers {
			if !strings.EqualFold(m, currentActive) {
				cascade = append(cascade, m)
			}
		}
	} else {
		cascade = append(cascade, allMembers...)
	}

	// Ghost Warmup Shadow Targeting: Si la petición viene etiquetada con un objetivo de calentamiento explícito
	// (por ejemplo, desde la extensión con x-warmup-target o x-target-auth),
	// enrutar directamente a esa reserva para calentar el Prompt Cache de Google sin alterar el ActiveLeader en RAM.
	var warmupTarget string
	if req.Options.Headers != nil {
		for k, vals := range req.Options.Headers {
			if (strings.EqualFold(k, "x-warmup-target") || strings.EqualFold(k, "x-target-auth")) && len(vals) > 0 {
				warmupTarget = strings.TrimSpace(vals[0])
				break
			}
		}
	}
	if warmupTarget != "" {
		for _, cand := range req.Candidates {
			candEmail := strings.TrimSuffix(strings.TrimPrefix(cand.ID, "antigravity-"), ".json")
			wEmail := strings.TrimSuffix(strings.TrimPrefix(warmupTarget, "antigravity-"), ".json")
			if strings.EqualFold(cand.ID, warmupTarget) || strings.EqualFold(candEmail, wEmail) {
				if cand.Status == "active" || cand.Status == "" {
					analytics.RecordAuditEvent(analytics.AuditEvent{
						PoolID:         pool.ID,
						EventType:      "GHOST_WARMUP",
						TriggerReason:  "shadow_inference_prompt_cache",
						PreviousLeader: currentActive,
						NewLeader:      cand.ID,
						LatencyMs:      1,
						StatusCode:     200,
						DetailsJSON:    `{"status":"prompt_cache_warmed","mode":"shadow_inference"}`,
					})
					return schedulerPickResponse{
						Handled: true,
						AuthID:  cand.ID,
					}
				}
			}
		}
	}

	// 3) Pick the first cascade member present among the available candidates.
	// REGLA PREDICTIVA (CTO): Si el líder dinámico actual está cerca de su límite seguro (>80%)
	// y hay otros miembros del pool sanos, rotar preventivamente el liderazgo antes del 429.
	available := make(map[string]string, len(req.Candidates))
	for _, candidate := range req.Candidates {
		if strings.TrimSpace(candidate.ID) != "" {
			available[strings.ToLower(candidate.ID)] = candidate.ID
		}
	}

	predEngine := GetPredictiveEngine()

	// Evaluar si el líder dinámico actual requiere descanso preventivo y si existe al menos otro miembro sano
	leaderAuth := ""
	if len(cascade) > 0 {
		leaderAuth = cascade[0]
	}
	leaderEmail := strings.TrimSuffix(strings.TrimPrefix(leaderAuth, "antigravity-"), ".json")

	// Blindaje de Prompt Caching (Histeresis & Sticky Session):
	// Para no destruir los embeddings en caché de Google Antigravity a mitad de una tarea larga:
	// 1) Enforce sticky leader when leader quota is unknown (!hasLeaderQuota). No rotar a ciegas.
	// 2) Exigir histeresis matemática antes de rotar preventivamente:
	//    - La cuota del líder debe estar en zona de peligro (< 20% en ventana de 5h).
	//    - Y la reserva candidata DEBE tener al menos +35% (Δ >= 35%) de ventaja confirmada.
	hasHealthyReserve := false
	reserveWithBetterQuota := false
	leaderQuota, hasLeaderQuota := predEngine.GetLiveQuota(leaderEmail)

	if len(cascade) > 1 {
		for _, resAuth := range cascade[1:] {
			if _, ok := available[strings.ToLower(resAuth)]; ok {
				hasHealthyReserve = true
				if hasLeaderQuota {
					resEmail := strings.TrimSuffix(strings.TrimPrefix(resAuth, "antigravity-"), ".json")
					if resQ, ok := predEngine.GetLiveQuota(resEmail); ok {
						// Histeresis estricta: líder en zona de peligro (< 20%) y reserva con ventaja >= +35%
						if leaderQuota.Window5hPct < 20.0 && (resQ.Window5hPct-leaderQuota.Window5hPct) >= 35.0 {
							reserveWithBetterQuota = true
							break
						}
					}
				}
				// Si no hay telemetría del líder (!hasLeaderQuota), se mantiene sticky (reserveWithBetterQuota = false)
			}
		}
	}

	// Si el líder tiene cooldown activo o cuota crítica (<15%), rotar si hay reserva disponible
	// Para rotación preventiva: solo si líder <20% y la reserva tiene >= +35% de ventaja confirmada
	skipLeaderPredictive := false
	if hasHealthyReserve {
		if predEngine.IsCriticalQuotaOrCooldown(leaderEmail) {
			skipLeaderPredictive = true
		} else if predEngine.ShouldPreventiveCool(leaderEmail) && reserveWithBetterQuota {
			skipLeaderPredictive = true
		}
	}

	taskType := extractTaskType(req)

	// Task-Aware & Predictive Token-Budget Routing:
	// Si se debe recurrir a las reservas (failover o rotación preventiva):
	// - Tareas HEAVY (investigaciones/subagentes): Priorizan la cuota semanal (WeeklyPct)
	//   para proteger las cuentas con cuota semanal limitada de ser estranguladas.
	// - Tareas LIGHT (comandos/preguntas directas): Priorizan la ventana corta de 5h (Window5hPct),
	//   reservando la capacidad semanal de las mejores cuentas para trabajo pesado.
	orderedCascade := make([]string, 0, len(cascade))
	if len(cascade) > 0 {
		orderedCascade = append(orderedCascade, cascade[0]) // Mantener el líder en el índice 0
		if len(cascade) > 1 {
			reserves := append([]string(nil), cascade[1:]...)
			sort.SliceStable(reserves, func(a, b int) bool {
				emailA := strings.TrimSuffix(strings.TrimPrefix(reserves[a], "antigravity-"), ".json")
				emailB := strings.TrimSuffix(strings.TrimPrefix(reserves[b], "antigravity-"), ".json")
				qA, hasA := predEngine.GetLiveQuota(emailA)
				qB, hasB := predEngine.GetLiveQuota(emailB)
				if hasA && hasB {
					if taskType == "HEAVY" {
						// Para tareas pesadas, la cuota semanal manda (70% peso semanal, 30% 5h)
						scoreA := (qA.WeeklyPct * 0.7) + (qA.Window5hPct * 0.3)
						scoreB := (qB.WeeklyPct * 0.7) + (qB.Window5hPct * 0.3)
						return scoreA > scoreB
					}
					// Para tareas ligeras, la cuota de 5h manda (70% peso 5h, 30% semanal)
					scoreA := (qA.Window5hPct * 0.7) + (qA.WeeklyPct * 0.3)
					scoreB := (qB.Window5hPct * 0.7) + (qB.WeeklyPct * 0.3)
					return scoreA > scoreB
				}
				if hasA {
					return true
				}
				return false
			})
			orderedCascade = append(orderedCascade, reserves...)
		}
	} else {
		orderedCascade = cascade
	}

	// Session Affinity Caching: si la sesión tiene una cuenta asignada válida y sana,
	// darle prioridad absoluta al frente de la cascada para no perder la memoria caché (TTL 5 min)
	if sessionID != "" && !skipLeaderPredictive {
		if aff, ok := analytics.GetSessionAffinity(sessionID, pool.ID); ok {
			affEmail := strings.ToLower(aff.AccountEmail)
			for idx, authFile := range orderedCascade {
				mEmail := strings.ToLower(strings.TrimSuffix(strings.TrimPrefix(authFile, "antigravity-"), ".json"))
				if mEmail == affEmail {
					if _, isAvail := available[strings.ToLower(authFile)]; isAvail && !predEngine.ShouldPreventiveCool(mEmail) {
						if idx > 0 {
							matched := orderedCascade[idx]
							orderedCascade = append(orderedCascade[:idx], orderedCascade[idx+1:]...)
							orderedCascade = append([]string{matched}, orderedCascade...)
						}
						break
					}
				}
			}
		}
	} else if projectID != "" && !skipLeaderPredictive && registry != nil {
		// Project Affinity Caching (RFC #9 / PR #13): En entornos multi-proyecto o ejecuciones
		// concurrentes, priorizar al frente la cuenta asignada a este proyecto en RAM (TTL 30m)
		// para evitar el Prompt Cache Thrashing entre proyectos independientes.
		if projAuth, ok := registry.GetProjectLeader(projectID, pool.ID); ok && projAuth != "" {
			projEmail := strings.ToLower(strings.TrimSuffix(strings.TrimPrefix(projAuth, "antigravity-"), ".json"))
			for idx, authFile := range orderedCascade {
				mEmail := strings.ToLower(strings.TrimSuffix(strings.TrimPrefix(authFile, "antigravity-"), ".json"))
				if strings.EqualFold(authFile, projAuth) || mEmail == projEmail {
					if _, isAvail := available[strings.ToLower(authFile)]; isAvail && !predEngine.ShouldPreventiveCool(mEmail) {
						if idx > 0 {
							matched := orderedCascade[idx]
							orderedCascade = append(orderedCascade[:idx], orderedCascade[idx+1:]...)
							orderedCascade = append([]string{matched}, orderedCascade...)
						}
						break
					}
				}
			}
		}
	}

	// Adaptive Pacing: Si el pool completo experimenta fatiga colectiva severa
	// O el líder individual supera el 80% de fatiga RPM pero conserva cuota de 5h:
	// inyectar una micro-pausa adaptativa (250-350ms con jitter) para que el RPM de Google
	// respire sin forzar una rotación innecesaria ni destruir el Prompt Cache.
	if len(cascade) > 0 {
		allFatigued := true
		leaderFatigued := false
		for idx, member := range cascade {
			if _, isAvail := available[strings.ToLower(member)]; isAvail {
				mEmail := strings.TrimSuffix(strings.TrimPrefix(member, "antigravity-"), ".json")
				fatiguePct, isCooling, _ := predEngine.GetAccountStatus(mEmail)
				if idx == 0 && (fatiguePct >= 80.0 || isCooling) {
					leaderFatigued = true
				}
				if fatiguePct < 80.0 && !isCooling && !predEngine.ShouldPreventiveCool(mEmail) {
					allFatigued = false
					if idx > 0 {
						break
					}
				}
			}
		}
		if allFatigued {
			time.Sleep(350 * time.Millisecond)
		} else if leaderFatigued {
			// Micro-pacing suave para salvar el Prompt Cache ante ráfagas cortas
			time.Sleep(250*time.Millisecond + time.Duration(time.Now().UnixNano()%70)*time.Millisecond)
		}
	}

	hasConcurrencyOverflow := false
	for i, authFile := range orderedCascade {
		// Si el motor predictivo decidió enfriar al líder actual y estamos en i == 0, rotar al siguiente miembro
		if i == 0 && skipLeaderPredictive {
			continue
		}

		// Concurrency Guard (MaxInFlight = 2): Si el líder en i == 0 ya tiene >= 2 peticiones concurrentes
		// en vuelo de otras sesiones en paralelo (ventana de 6s) y existen reservas sanas en el pool,
		// delegar temporalmente la petición a la Reserva #1 para evitar caídas de socket
		// (ECONNRESET/UND_ERR_BODY_TERMINATED) sin cambiar el líder oficial en RAM.
		if i == 0 && len(orderedCascade) > 1 && !skipLeaderPredictive {
			mEmail := strings.ToLower(strings.TrimSuffix(strings.TrimPrefix(authFile, "antigravity-"), ".json"))
			if activeStreams := getActiveInFlightSessions(mEmail, sessionID, 6*time.Second); activeStreams >= 2 {
				hasConcurrencyOverflow = true
				continue
			}
		}

		if exactID, ok := available[strings.ToLower(authFile)]; ok {
			isFailover := (i > 0) // Si i > 0 significa que hubo rotación de líder (por 429 o balanceo predictivo)
			if isFailover && registry != nil && !hasConcurrencyOverflow {
				// Actualizar el Líder Dinámico Ficticio en RAM hacia el nuevo miembro activo SOLO si no fue overflow temporal
				registry.SetActiveLeader(pool.BasePrefix, exactID)
			}
			reqs, fail := license.RecordRotation(isFailover)
			atomic.StoreInt64(&totalRotations, reqs)
			atomic.StoreInt64(&totalFailovers, fail)

			// Registrar evento granular en SQLite local (Pulse Tokens)
			email := exactID
			email = strings.TrimPrefix(email, "antigravity-")
			email = strings.TrimSuffix(email, ".json")

			// Registrar sesión activa en vuelo para control de concurrencia
			recordInFlightSession(email, sessionID)

			// Registrar actividad en el motor predictivo para control de fatiga
			predEngine.RecordActivity(email)

			// Preservar afinidad de sesión para no invalidar el caché en turnos subsiguientes
			turnCount := 1
			if sessionID != "" {
				if existingAff, ok := analytics.GetSessionAffinity(sessionID, pool.ID); ok {
					turnCount = existingAff.TurnCount + 1
				}
				analytics.SetSessionAffinity(analytics.SessionAffinity{
					SessionID:    sessionID,
					PoolID:       pool.ID,
					AccountEmail: email,
				})
			}

			// Preservar afinidad de proyecto en RAM volátil (RFC #9 / PR #13, cero I/O a disco)
			if projectID != "" && registry != nil {
				registry.SetProjectLeader(projectID, pool.ID, exactID)
			}

			// Task Auto-Downgrade: if turnCount >= 2 on expensive Claude reasoning pools or requested via header
			autoDowngradeHeader := false
			isOrchestratorTurn := false
			if req.Options.Headers != nil {
				for k, vals := range req.Options.Headers {
					if strings.EqualFold(k, "x-auto-downgrade") && len(vals) > 0 && strings.EqualFold(vals[0], "true") {
						autoDowngradeHeader = true
					}
					if (strings.EqualFold(k, "x-agent-role") || strings.EqualFold(k, "x-client-role")) && len(vals) > 0 {
						if strings.Contains(strings.ToLower(vals[0]), "orchestrator") {
							isOrchestratorTurn = true
						}
					}
				}
			}

			// Opportunistic Orchestrator Triage Warmup trigger
			if isOrchestratorTurn {
				TriggerTriageShadowWarmup(nil)
			}

			if turnCount >= 2 && (autoDowngradeHeader || strings.Contains(strings.ToLower(pool.ID), "claude")) {
				analytics.RecordAuditEvent(analytics.AuditEvent{
					PoolID:         pool.ID,
					EventType:      "AUTO_DOWNGRADE",
					TriggerReason:  fmt.Sprintf("task_turn_%d_optimization", turnCount),
					PreviousLeader: leaderEmail,
					NewLeader:      email,
					LatencyMs:      1,
					StatusCode:     200,
					DetailsJSON:    fmt.Sprintf(`{"turn_count":%d,"action":"mitigate_reasoning_overhead","model":"%s"}`, turnCount, originalModel),
				})
			}

			// Registrar evento de auditoría persistente ante failovers o rotaciones preventivas
			if isFailover {
				eventType := "FAILOVER"
				triggerReason := "reserve_activation"
				if skipLeaderPredictive {
					eventType = "PREVENTIVE"
					triggerReason = "leader_fatigue_or_critical_quota"
				}
				analytics.RecordAuditEvent(analytics.AuditEvent{
					PoolID:         pool.ID,
					EventType:      eventType,
					TriggerReason:  triggerReason,
					PreviousLeader: leaderEmail,
					NewLeader:      email,
					StatusCode:     200,
				})

				// Conexión activa con la Caja Negra Forense (Flight Recorder):
				// Si no fue un enfriamiento preventivo planificado, registrar como incidente/failover
				if !skipLeaderPredictive {
					analytics.RecordFlightEvent(analytics.FlightRecorderEvent{
						AccountEmail:    leaderEmail,
						PoolID:          pool.ID,
						ErrorKind:       "FAILOVER_ACTIVATION",
						StatusCode:      429,
						ErrorMessage:    fmt.Sprintf("Cuenta líder %s degradada o en 429; failover a reserva %s en cascada #%d", leaderEmail, email, i),
						HeadersSnapshot: fmt.Sprintf(`{"previous_leader":"%s","active_reserve":"%s","pool":"%s"}`, leaderEmail, email, pool.ID),
						LatencyMs:       1,
					})
				}
			}

			// Resolver el modelo especialista específico de esta cuenta (member_models o fallback del pool)
			resolvedTargetModel := ResolveActiveModelFallback(pool.ActiveModelForAccount(exactID))
			if strings.TrimSpace(resolvedTargetModel) == "" {
				resolvedTargetModel = ResolveActiveModelFallback(originalModel)
			}

			analytics.RecordEvent(analytics.RotationEvent{
				PoolID:          pool.ID,
				PoolPrefix:      pool.BasePrefix,
				SelectedAccount: exactID,
				AccountEmail:    email,
				IsFailover:      isFailover,
				CascadeIndex:    i,
				TargetModel:     resolvedTargetModel,
				StatusCode:      200,
			})

			return schedulerPickResponse{
				Handled: true,
				AuthID:  exactID,
			}
		}
	}

	// 4) Modo Supervivencia (Graceful Degradation):
	// Si el 100% de los miembros del pool están colapsados o sin disponibilidad en CPAMC,
	// desviar automáticamente hacia el fallback configurado (SurvivalFallback) o al pool
	// base de contingencia (Pool-01-gemini / gemini) para evitar la interrupción de la sesión.
	var survivalPool *PoolDefinition
	if pool != nil && strings.TrimSpace(pool.Policy.SurvivalFallback) != "" && registry != nil {
		if fb, ok := registry.GetPool(pool.Policy.SurvivalFallback); ok && fb.IsEnabled() {
			survivalPool = &fb
		}
	}
	if survivalPool == nil && registry != nil {
		for _, p := range registry.ListPools() {
			if p.IsEnabled() && p.ID != pool.ID && (strings.Contains(strings.ToLower(p.ID), "gemini") || strings.Contains(strings.ToLower(p.Family), "gemini")) {
				survivalPool = &p
				break
			}
		}
	}

	if survivalPool != nil {
		for _, member := range survivalPool.AllMembers() {
			if exactID, ok := available[strings.ToLower(member)]; ok {
				email := strings.TrimSuffix(strings.TrimPrefix(exactID, "antigravity-"), ".json")
				analytics.RecordAuditEvent(analytics.AuditEvent{
					PoolID:         pool.ID,
					EventType:      "SURVIVAL_MODE_ENGAGED",
					TriggerReason:  "all_primary_members_exhausted",
					PreviousLeader: pool.ID,
					NewLeader:      exactID,
					LatencyMs:      1,
					StatusCode:     200,
					DetailsJSON:    fmt.Sprintf(`{"primary_pool":"%s","survival_pool":"%s","selected_auth":"%s"}`, pool.ID, survivalPool.ID, exactID),
				})

				resolvedModel := ResolveActiveModelFallback(survivalPool.ActiveModelForAccount(exactID))
				if strings.TrimSpace(resolvedModel) == "" {
					resolvedModel = ResolveActiveModelFallback(originalModel)
				}

				analytics.RecordEvent(analytics.RotationEvent{
					PoolID:          survivalPool.ID,
					PoolPrefix:      survivalPool.BasePrefix,
					SelectedAccount: exactID,
					AccountEmail:    email,
					IsFailover:      true,
					CascadeIndex:    99,
					TargetModel:     resolvedModel,
					StatusCode:      200,
				})

				return schedulerPickResponse{
					Handled: true,
					AuthID:  exactID,
				}
			}
		}
	}

	// 5) No cascade member available: delegate to the builtin scheduler.
	return schedulerPickResponse{Handled: false}
}

// handleSchedulerPick serves scheduler.pick.
func handleSchedulerPick(req schedulerPickRequest) schedulerPickResponse {
	return schedulerPickCascade(activeRegistry(), req)
}

// isModelProviderMethod reports whether the plugin method belongs to the
// model provider, router or scheduler RPC surface.
func isModelProviderMethod(method string) bool {
	switch method {
	case methodModelStatic, methodModelRegister, methodModelForAuth, methodModelRoute, methodSchedulerPick:
		return true
	}
	return false
}
