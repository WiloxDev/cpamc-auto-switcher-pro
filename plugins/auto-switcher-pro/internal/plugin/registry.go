package plugin

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"auto-switcher-pro/internal/analytics"
)

const (
	poolsRoutePath = "/auto-switcher-pro/pools"

	defaultStatePath = "/CLIProxyAPI/plugins/auto-switcher-pro-state.json"
	fallbackStateDir = "./"

	defaultAuthDir = "/root/.cli-proxy-api"
)

// readConfigAuthDir inspects config.yaml to discover custom auth-dir settings (e.g. configured via EasyCLIProxyAPI).
func readConfigAuthDir(configPath string) string {
	if configPath == "" {
		configPath = resolveConfigPath()
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		return ""
	}
	lines := strings.Split(string(data), "\n")
	re := regexp.MustCompile(`^\s*(?:-\s*)?auth-dir\s*:\s*["']?([^"'\r\n#]+)["']?`)
	for _, line := range lines {
		m := re.FindStringSubmatch(line)
		if len(m) > 1 {
			val := strings.TrimSpace(m[1])
			if val == "" {
				continue
			}
			// Expand home prefix "~" or "~/"
			if strings.HasPrefix(val, "~") {
				if uHome, err := os.UserHomeDir(); err == nil && uHome != "" {
					if val == "~" {
						val = uHome
					} else if strings.HasPrefix(val, "~/") || strings.HasPrefix(val, "~\\") {
						val = filepath.Join(uHome, val[2:])
					}
				}
			}
			// If relative path, resolve relative to config directory
			if !filepath.IsAbs(val) {
				configDir := filepath.Dir(configPath)
				candidate := filepath.Join(configDir, val)
				if fi, err := os.Stat(candidate); err == nil && fi.IsDir() {
					return candidate
				}
			}
			if fi, err := os.Stat(val); err == nil && fi.IsDir() {
				return val
			}
		}
	}
	return ""
}

// resolveAuthDir locates the native CPAMC credentials directory agnostically across platforms (Docker, Linux, Windows, macOS).
func resolveAuthDir() string {
	if env := os.Getenv("AUTO_SWITCHER_AUTH_DIR"); env != "" {
		return env
	}
	if env := os.Getenv("CLI_PROXY_AUTH_DIR"); env != "" {
		return env
	}

	// 1. Check if config.yaml specifies a custom auth-dir (e.g. customized via EasyCLIProxyAPI GUI)
	if cfgAuth := readConfigAuthDir(""); cfgAuth != "" {
		return cfgAuth
	}

	// 2. Check container directory if running inside official Linux Docker
	if fi, err := os.Stat(defaultAuthDir); err == nil && fi.IsDir() {
		return defaultAuthDir
	}

	// 3. Multiplatform host fallback: inspect user home ~/.cli-proxy-api (Windows, Linux, macOS)
	if uHome, err := os.UserHomeDir(); err == nil && uHome != "" {
		hostCandidate := filepath.Join(uHome, ".cli-proxy-api")
		if fi, err := os.Stat(hostCandidate); err == nil && fi.IsDir() {
			return hostCandidate
		}
	}

	// 4. Check relative to working directory
	if fi, err := os.Stat(".cli-proxy-api"); err == nil && fi.IsDir() {
		return ".cli-proxy-api"
	}

	if uHome, err := os.UserHomeDir(); err == nil && uHome != "" {
		return filepath.Join(uHome, ".cli-proxy-api")
	}
	return defaultAuthDir
}

// PoolPolicy defines model filtering and isolation policies for a pool.
type PoolPolicy struct {
	DisableIsolation bool     `json:"disable_isolation"`
	Exclude55        bool     `json:"exclude_55"`
	TargetModels     []string `json:"target_models,omitempty"`
	ExcludedModels   []string `json:"excluded_models,omitempty"`
	SurvivalFallback string   `json:"survival_fallback,omitempty"` // Optional emergency fallback pool (e.g. "Pool-01-gemini")
}

// PoolDefinition represents a logical load-balancing pool managed within Auto Switcher Pro.
// A pool has a sovereign identity defined by its immutable ID, human-readable Name/DisplayName,
// RouteSlug/BasePrefix for /model routing, Enabled toggle (active/paused), and a symmetrical list
// of member accounts (Members). The "Leader" is a dynamic, volatile role in RAM managed by
// Auto Switcher Pro's scheduler. Legacy LeaderAuth/Reserves fields remain populated for
// backward compatibility.
type PoolDefinition struct {
	ID           string            `json:"id"`                      // Sovereign immutable Unique Identifier (e.g. "Pool-01-gemini")
	Name         string            `json:"name,omitempty"`          // Human-readable Label / Group Name (e.g. "Pool-01-gemini")
	DisplayName  string            `json:"display_name,omitempty"`  // Optional extended label (e.g. "Pool-01-gemini")
	RouteSlug    string            `json:"route_slug,omitempty"`    // Virtual routing slug for /model (e.g. "Pool-01-gemini")
	Enabled      *bool             `json:"enabled,omitempty"`       // Operative status: nil/true = active in /model, false = paused
	Family       string            `json:"family"`                  // e.g. "gemini_pure", "gemini_sonnet", "gemini_opus", "gemini_claude", "codex"
	BasePrefix   string            `json:"base_prefix"`             // e.g. "agy", "agy_son", "agy_opus"
	Members      []string          `json:"members,omitempty"`       // Symmetrical list of all member auth files in the pool
	MemberModels map[string]string `json:"member_models,omitempty"` // Optional per-account configured model (e.g. {"antigravity-a.json": "gemini-3.8-flash-high"})
	ActiveLeader string            `json:"active_leader,omitempty"` // Dynamic active leader currently serving in RAM
	LeaderAuth   string            `json:"leader_auth"`             // Legacy compatibility (first/current active member)
	LeaderEmail  string            `json:"leader_email,omitempty"`
	Reserves     []string          `json:"reserves"` // Legacy compatibility (remaining members)
	Policy       PoolPolicy        `json:"policy"`
	CreatedAt    string            `json:"created_at,omitempty"`
	UpdatedAt    string            `json:"updated_at,omitempty"`
}

// familyCanonicalShortName returns the clean family suffix
// ("gemini", "claude", "codex", "nan", "nvidia", "deepseek", etc.)
// used in Pool-XX-<family> identifiers.
func familyCanonicalShortName(family, basePrefix string) string {
	f := strings.ToLower(strings.TrimSpace(family))
	b := strings.ToLower(strings.TrimSpace(basePrefix))
	switch {
	case strings.Contains(f, "codex") || strings.HasPrefix(b, "codex"):
		return "codex"
	case strings.Contains(f, "claude") || strings.Contains(f, "sonnet") || strings.Contains(f, "opus") ||
		strings.HasPrefix(b, "clau") || strings.HasPrefix(b, "agy_clau") || strings.HasPrefix(b, "agy_son") || strings.HasPrefix(b, "agy_opus"):
		return "claude"
	case strings.Contains(f, "nan") || strings.HasPrefix(b, "nan"):
		return "nan"
	case strings.Contains(f, "nvidia") || strings.HasPrefix(b, "nvidia"):
		return "nvidia"
	case strings.Contains(f, "deepseek") || strings.HasPrefix(b, "deepseek"):
		return "deepseek"
	case strings.Contains(f, "groq") || strings.HasPrefix(b, "groq"):
		return "groq"
	case strings.Contains(f, "cerebras") || strings.HasPrefix(b, "cerebras"):
		return "cerebras"
	case strings.Contains(f, "mistral") || strings.HasPrefix(b, "mistral"):
		return "mistral"
	case strings.Contains(f, "typesafe") || strings.HasPrefix(b, "typesafe"):
		return "typesafe"
	case strings.Contains(f, "vercel") || strings.HasPrefix(b, "vercel"):
		return "vercel"
	case strings.Contains(f, "opencode") || strings.HasPrefix(b, "ocgo") || strings.HasPrefix(b, "opencode"):
		return "opencode"
	default:
		return "gemini"
	}
}

// ActiveModelForAccount resolves the configured model for a specific member account
// (falling back to the pool's first target_model or family default).
func (p PoolDefinition) ActiveModelForAccount(authFile string) string {
	trimmed := strings.TrimSpace(authFile)
	if trimmed != "" && len(p.MemberModels) > 0 {
		if m, ok := p.MemberModels[trimmed]; ok && strings.TrimSpace(m) != "" {
			return strings.TrimSpace(m)
		}
		for k, v := range p.MemberModels {
			if strings.EqualFold(strings.TrimSpace(k), trimmed) && strings.TrimSpace(v) != "" {
				return strings.TrimSpace(v)
			}
		}
	}
	if len(p.Policy.TargetModels) > 0 && strings.TrimSpace(p.Policy.TargetModels[0]) != "" {
		return strings.TrimSpace(p.Policy.TargetModels[0])
	}
	fam := familyCanonicalShortName(p.Family, p.BasePrefix)
	switch fam {
	case "codex":
		return "gpt-4o"
	case "claude":
		return "claude-sonnet-4-6"
	default:
		return "gemini-3.8-flash-high"
	}
}

// IsEnabled returns true unless the pool was explicitly paused (Enabled == false).
func (p PoolDefinition) IsEnabled() bool {
	if p.Enabled == nil {
		return true
	}
	return *p.Enabled
}

// AllMembers returns the ordered, deduplicated list of all physical auth files
// belonging to this pool. When LeaderAuth or Reserves are explicitly provided,
// they take precedence as authoritative over stale entries in Members.
func (p PoolDefinition) AllMembers() []string {
	seen := make(map[string]struct{})
	out := make([]string, 0, len(p.Members)+1+len(p.Reserves))
	add := func(raw string) {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			return
		}
		key := strings.ToLower(trimmed)
		if _, exists := seen[key]; !exists {
			seen[key] = struct{}{}
			out = append(out, trimmed)
		}
	}

	trimmedLeader := strings.TrimSpace(p.LeaderAuth)
	// If LeaderAuth or Reserves are specified, treat them as authoritative.
	if trimmedLeader != "" || len(p.Reserves) > 0 {
		if trimmedLeader != "" {
			add(trimmedLeader)
		}
		for _, r := range p.Reserves {
			add(r)
		}
		// If Members was populated, only keep items that match leader or reserves
		// (avoiding resuscitation of released members).
		return out
	}

	for _, m := range p.Members {
		add(m)
	}
	return out
}

// normalizePoolDefinition synchronizes ID, Name, RouteSlug, BasePrefix and Members/LeaderAuth/Reserves
// so both pool-centric callers (ID/Members) and legacy callers (BasePrefix/LeaderAuth/Reserves)
// work seamlessly.
func normalizePoolDefinition(pool *PoolDefinition) {
	if pool == nil {
		return
	}
	if strings.TrimSpace(pool.BasePrefix) == "" && strings.TrimSpace(pool.RouteSlug) != "" {
		pool.BasePrefix = strings.TrimSpace(pool.RouteSlug)
	}
	if strings.TrimSpace(pool.BasePrefix) == "" && strings.TrimSpace(pool.Name) != "" {
		pool.BasePrefix = strings.TrimSpace(pool.Name)
	}
	if strings.TrimSpace(pool.RouteSlug) == "" {
		pool.RouteSlug = strings.TrimSpace(pool.BasePrefix)
	}
	if strings.TrimSpace(pool.Name) == "" {
		pool.Name = strings.TrimSpace(pool.BasePrefix)
	}
	if strings.TrimSpace(pool.DisplayName) == "" {
		pool.DisplayName = pool.Name
	}
	if pool.Enabled == nil {
		tr := true
		pool.Enabled = &tr
	}

	// Contingencia Antigravedad & Gobernanza Sagrada:
	// Purgar de raíz cualquier identificador de pool virtual ('pool-...') de target_models y excluded_models
	// para blindar el estado de persistencia contra cualquier contaminación cruzada accidental.
	if len(pool.Policy.TargetModels) > 0 {
		cleanedTargets := make([]string, 0, len(pool.Policy.TargetModels))
		for _, t := range pool.Policy.TargetModels {
			tr := strings.TrimSpace(t)
			if tr != "" && !strings.HasPrefix(strings.ToLower(tr), "pool-") {
				cleanedTargets = append(cleanedTargets, tr)
			}
		}
		pool.Policy.TargetModels = cleanedTargets
	}
	if len(pool.Policy.ExcludedModels) > 0 {
		cleanedExclusions := make([]string, 0, len(pool.Policy.ExcludedModels))
		for _, e := range pool.Policy.ExcludedModels {
			er := strings.TrimSpace(e)
			if er != "" && !strings.HasPrefix(strings.ToLower(er), "pool-") {
				cleanedExclusions = append(cleanedExclusions, er)
			}
		}
		pool.Policy.ExcludedModels = cleanedExclusions
	}

	all := pool.AllMembers()
	pool.Members = all
	if len(all) > 0 {
		pool.LeaderAuth = all[0]
		if len(all) > 1 {
			pool.Reserves = all[1:]
		} else {
			pool.Reserves = []string{}
		}
		// If ActiveLeader is empty or points to an account no longer in the pool,
		// resync ActiveLeader to the authoritative LeaderAuth.
		activeLeaderFound := false
		if strings.TrimSpace(pool.ActiveLeader) != "" {
			for _, m := range all {
				if strings.EqualFold(m, strings.TrimSpace(pool.ActiveLeader)) {
					activeLeaderFound = true
					break
				}
			}
		}
		if !activeLeaderFound {
			pool.ActiveLeader = pool.LeaderAuth
		}
	}
}

// RegistryState is the serializable structure stored on disk.
type RegistryState struct {
	Version           int               `json:"version"`
	UpdatedAt         string            `json:"updated_at"`
	Pools             []PoolDefinition  `json:"pools"`
	StandaloneAliases map[string]string `json:"standalone_aliases,omitempty"`
}

// PoolRegistry provides thread-safe in-memory caching and atomic file persistence
// for pools created via GroupManager.
type PoolRegistry struct {
	mu                sync.RWMutex
	filePath          string
	pools             map[string]PoolDefinition // keyed by base_prefix (case-insensitive)
	standaloneAliases map[string]string         // accountKey/fileName -> alias (e.g. "CX1", "AG1")
	activeLeaders     map[string]string         // volatile in-memory active leader per pool key
	projectLeaders    map[string]string         // volatile in-memory project affinity leader (poolKey::projectID -> activeAuth)
	loaded            bool
}

var (
	defaultRegistryInstance *PoolRegistry
	defaultRegistryOnce     sync.Once
)

// resolveStateFilePath determines the optimal persistent location for the state file agnostically.
func resolveStateFilePath(customPath string) string {
	if customPath != "" {
		return customPath
	}
	if envPath := os.Getenv("AUTO_SWITCHER_STATE_FILE"); envPath != "" {
		return envPath
	}

	// 1. Prefer container plugins bind-mount if running in official Docker container
	pluginsDir := "/CLIProxyAPI/plugins"
	if fi, err := os.Stat(pluginsDir); err == nil && fi.IsDir() {
		return defaultStatePath
	}

	// 2. Check local plugins/ directory (Windows native, local host installations)
	for _, candidate := range []string{
		filepath.Join("plugins", "auto-switcher-pro-state.json"),
		filepath.Join("..", "plugins", "auto-switcher-pro-state.json"),
		"auto-switcher-pro-state.json",
	} {
		if fi, err := os.Stat(candidate); err == nil && !fi.IsDir() {
			return candidate
		}
	}

	// 3. If plugins directory exists in current working directory, store state there
	if fi, err := os.Stat("plugins"); err == nil && fi.IsDir() {
		return filepath.Join("plugins", "auto-switcher-pro-state.json")
	}

	// 4. Local host fallback
	return filepath.Join(fallbackStateDir, "auto-switcher-pro-state.json")
}

// NewPoolRegistry creates a new PoolRegistry pointing to a given or resolved state file.
func NewPoolRegistry(filePath string) *PoolRegistry {
	resolved := resolveStateFilePath(filePath)
	return &PoolRegistry{
		filePath:          resolved,
		pools:             make(map[string]PoolDefinition),
		standaloneAliases: make(map[string]string),
		activeLeaders:     make(map[string]string),
	}
}

// DefaultRegistry returns the process-wide default singleton registry.
func DefaultRegistry() *PoolRegistry {
	defaultRegistryOnce.Do(func() {
		defaultRegistryInstance = NewPoolRegistry("")
		_ = defaultRegistryInstance.Load()
	})
	return defaultRegistryInstance
}

// Load reads and parses the JSON state file from disk into memory.
func (r *PoolRegistry) Load() error {
	r.mu.Lock()
	defer r.mu.Unlock()

	data, err := os.ReadFile(r.filePath)
	if err != nil {
		if os.IsNotExist(err) {
			r.pools = make(map[string]PoolDefinition)
			r.loaded = true
			return nil
		}
		return fmt.Errorf("read state file %s: %w", r.filePath, err)
	}

	var state RegistryState
	if err := json.Unmarshal(data, &state); err != nil {
		return fmt.Errorf("unmarshal state file %s: %w", r.filePath, err)
	}

	r.pools = make(map[string]PoolDefinition)
	r.standaloneAliases = make(map[string]string)
	if r.activeLeaders == nil {
		r.activeLeaders = make(map[string]string)
	}
	if state.StandaloneAliases != nil {
		for k, v := range state.StandaloneAliases {
			r.standaloneAliases[strings.TrimSpace(k)] = strings.ToUpper(strings.TrimSpace(v))
		}
	}
	needsSaveSanitized := false
	for _, p := range state.Pools {
		normalizePoolDefinition(&p)
		// Cirugía 1 / Idea 1 (Startup Self-Healing): Saneamiento automático al arrancar
		if err := validatePoolModelCompatibility(&p); err != nil {
			famShort := familyCanonicalShortName(p.Family, p.BasePrefix)
			defaultModel := "gemini-3.8-flash-high"
			if famShort == "codex" {
				defaultModel = "gpt-5.4"
			} else if famShort == "claude" {
				defaultModel = "claude-sonnet-4-6"
			}
			p.Policy.TargetModels = []string{defaultModel}
			if p.MemberModels == nil {
				p.MemberModels = make(map[string]string)
			}
			for _, m := range p.Members {
				p.MemberModels[m] = defaultModel
			}
			needsSaveSanitized = true
		}

		key := strings.ToLower(strings.TrimSpace(p.BasePrefix))
		if key != "" {
			if live, ok := r.activeLeaders[key]; ok && live != "" {
				p.ActiveLeader = live
			}
			r.pools[key] = p
		}
	}
	r.loaded = true
	if needsSaveSanitized {
		// Dejar backup timestamped antes de auto-sanear
		bakPath := fmt.Sprintf("%s.bak-pre-heal-%s", r.filePath, time.Now().UTC().Format("20060102-150405"))
		_ = os.WriteFile(bakPath, data, 0644)
		_ = r.saveUnlocked()
	}
	return nil
}

// saveUnlocked writes state without acquiring r.mu lock (caller must hold r.mu.Lock)
func (r *PoolRegistry) saveUnlocked() error {
	poolsList := make([]PoolDefinition, 0, len(r.pools))
	for _, p := range r.pools {
		poolsList = append(poolsList, p)
	}
	aliasesCopy := make(map[string]string, len(r.standaloneAliases))
	for k, v := range r.standaloneAliases {
		aliasesCopy[k] = v
	}

	sortPoolDefinitions(poolsList)

	state := RegistryState{
		Version:           1,
		UpdatedAt:         time.Now().UTC().Format(time.RFC3339),
		Pools:             poolsList,
		StandaloneAliases: aliasesCopy,
	}

	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal state: %w", err)
	}

	dir := filepath.Dir(r.filePath)
	if dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return fmt.Errorf("create state dir %s: %w", dir, err)
		}
	}

	tmpFile := fmt.Sprintf("%s.tmp.%d", r.filePath, time.Now().UnixNano())
	if err := os.WriteFile(tmpFile, data, 0644); err != nil {
		return fmt.Errorf("write temp state %s: %w", tmpFile, err)
	}

	if err := os.Rename(tmpFile, r.filePath); err != nil {
		_ = os.Remove(tmpFile)
		return fmt.Errorf("rename temp state to %s: %w", r.filePath, err)
	}
	return nil
}

var (
	poolNumRegex = regexp.MustCompile(`(?i)(?:pool[_-]?|agy|codex|clau|prefix[_-]?)(\d+)`)
	digitRegex   = regexp.MustCompile(`\d+`)
)

// extractPoolNumber extracts the canonical sovereign pool integer for deterministic ordering.
func extractPoolNumber(p PoolDefinition) int {
	candidates := []string{p.ID, p.DisplayName, p.Name, p.BasePrefix, p.RouteSlug}
	for _, c := range candidates {
		if c == "" {
			continue
		}
		if m := poolNumRegex.FindStringSubmatch(c); len(m) > 1 {
			if n, err := strconv.Atoi(m[1]); err == nil {
				return n
			}
		}
	}
	for _, c := range candidates {
		if c == "" {
			continue
		}
		if m := digitRegex.FindString(c); m != "" {
			if n, err := strconv.Atoi(m); err == nil {
				return n
			}
		}
	}
	lowerBase := strings.ToLower(strings.TrimSpace(p.BasePrefix))
	if lowerBase == "agy" || lowerBase == "codex" || lowerBase == "clau" || lowerBase == "agy_clau" || lowerBase == "agy_son" || lowerBase == "agy_opus" {
		return 1
	}
	return 999999
}

// sortPoolDefinitions enforces deterministic numerical ordering by sovereign pool number (ascending),
// tie-broken by ID and then BasePrefix.
func sortPoolDefinitions(pools []PoolDefinition) {
	sort.SliceStable(pools, func(i, j int) bool {
		numI := extractPoolNumber(pools[i])
		numJ := extractPoolNumber(pools[j])
		if numI != numJ {
			return numI < numJ
		}
		idI := strings.ToLower(pools[i].ID)
		idJ := strings.ToLower(pools[j].ID)
		if idI != idJ {
			return idI < idJ
		}
		return strings.ToLower(pools[i].BasePrefix) < strings.ToLower(pools[j].BasePrefix)
	})
}

// Save atomically writes the current state to disk.
func (r *PoolRegistry) Save() error {
	r.mu.RLock()
	poolsList := make([]PoolDefinition, 0, len(r.pools))
	for _, p := range r.pools {
		poolsList = append(poolsList, p)
	}
	aliasesCopy := make(map[string]string, len(r.standaloneAliases))
	for k, v := range r.standaloneAliases {
		aliasesCopy[k] = v
	}
	r.mu.RUnlock()

	sortPoolDefinitions(poolsList)

	state := RegistryState{
		Version:           1,
		UpdatedAt:         time.Now().UTC().Format(time.RFC3339),
		Pools:             poolsList,
		StandaloneAliases: aliasesCopy,
	}

	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal state: %w", err)
	}

	dir := filepath.Dir(r.filePath)
	if dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return fmt.Errorf("create state dir %s: %w", dir, err)
		}
	}

	tmpFile := fmt.Sprintf("%s.tmp.%d", r.filePath, time.Now().UnixNano())
	if err := os.WriteFile(tmpFile, data, 0644); err != nil {
		return fmt.Errorf("write temp state %s: %w", tmpFile, err)
	}

	if err := os.Rename(tmpFile, r.filePath); err != nil {
		_ = os.Remove(tmpFile)
		return fmt.Errorf("rename temp state to %s: %w", r.filePath, err)
	}

	// Emit atomic epoch signal for reactive hot-reload in Pi extensions (cpamc-auto-switcher)
	epochData := []byte(fmt.Sprintf("%d", time.Now().UnixNano()))
	epochFile := filepath.Join(dir, "auto-switcher-pro.epoch")
	tmpEpoch := fmt.Sprintf("%s.tmp.%d", epochFile, time.Now().UnixNano())
	if err := os.WriteFile(tmpEpoch, epochData, 0644); err == nil {
		_ = os.Rename(tmpEpoch, epochFile)
	}

	// Emit to shared memory (/dev/shm) for ultra-low latency (<5ms) inter-process signaling
	if fi, err := os.Stat("/dev/shm"); err == nil && fi.IsDir() {
		shmEpoch := "/dev/shm/auto-switcher-pro.epoch"
		tmpShm := fmt.Sprintf("%s.tmp.%d", shmEpoch, time.Now().UnixNano())
		if err := os.WriteFile(tmpShm, epochData, 0644); err == nil {
			_ = os.Rename(tmpShm, shmEpoch)
		}
	}

	return nil
}

// resolveProviderPrefix maps a provider name/family to a 2-letter uppercase alias prefix.
func resolveProviderPrefix(provider string) string {
	low := strings.ToLower(strings.TrimSpace(provider))
	switch {
	case strings.Contains(low, "codex") || strings.Contains(low, "openai"):
		return "CX"
	case strings.Contains(low, "antigravity") || strings.Contains(low, "google") || strings.Contains(low, "gemini"):
		if strings.Contains(low, "argon") {
			return "AR"
		}
		return "AG"
	case strings.Contains(low, "claude") || strings.Contains(low, "anthropic"):
		return "CL"
	case strings.Contains(low, "argon"):
		return "AR"
	case strings.Contains(low, "opencode") || strings.Contains(low, "nim") || strings.Contains(low, "nan") || strings.Contains(low, "nvidia"):
		return "OC"
	default:
		clean := strings.ToUpper(regexp.MustCompile(`[^a-zA-Z]`).ReplaceAllString(low, ""))
		if len(clean) >= 2 {
			return clean[:2]
		}
		return "ST"
	}
}

// GetOrAssignStandaloneAlias returns a short, deterministic alias (e.g. CX1, CX2, AG1)
// for an unassigned standalone account. If none exists yet, it deterministically assigns
// the lowest available integer for the provider's family prefix.
func (r *PoolRegistry) GetOrAssignStandaloneAlias(accountKey string, provider string) string {
	cleanKey := strings.TrimSpace(accountKey)
	if cleanKey == "" {
		return ""
	}

	r.mu.Lock()
	if r.standaloneAliases == nil {
		r.standaloneAliases = make(map[string]string)
	}

	// 1. Check if already assigned
	if existing, ok := r.standaloneAliases[cleanKey]; ok && existing != "" {
		r.mu.Unlock()
		return existing
	}

	// 2. Determine prefix for provider
	pref := resolveProviderPrefix(provider)

	// 3. Find used numbers for this prefix
	usedNums := make(map[int]bool)
	prefixRegex := regexp.MustCompile(fmt.Sprintf(`^%s(\d+)$`, regexp.QuoteMeta(pref)))
	for _, alias := range r.standaloneAliases {
		if m := prefixRegex.FindStringSubmatch(alias); len(m) > 1 {
			if n, err := strconv.Atoi(m[1]); err == nil {
				usedNums[n] = true
			}
		}
	}

	// 4. Find lowest available positive integer
	nextNum := 1
	for usedNums[nextNum] {
		nextNum++
	}

	assigned := fmt.Sprintf("%s%d", pref, nextNum)
	r.standaloneAliases[cleanKey] = assigned
	r.mu.Unlock()

	_ = r.Save()
	return assigned
}

// GetAccountForAlias returns the account key associated with a standalone alias.
func (r *PoolRegistry) GetAccountForAlias(alias string) (string, bool) {
	cleanAlias := strings.ToUpper(strings.TrimSpace(alias))
	if cleanAlias == "" {
		return "", false
	}

	r.mu.RLock()
	defer r.mu.RUnlock()

	for k, v := range r.standaloneAliases {
		if strings.EqualFold(v, cleanAlias) {
			return k, true
		}
	}
	return "", false
}

// GetAllStandaloneAliases returns a copy of all current standalone alias mappings.
func (r *PoolRegistry) GetAllStandaloneAliases() map[string]string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	out := make(map[string]string, len(r.standaloneAliases))
	for k, v := range r.standaloneAliases {
		out[k] = v
	}
	return out
}

// ListPools returns all stored pools as a slice, automatically reconciling
// with physical credential files on disk if the native auth directory exists.
func (r *PoolRegistry) ListPools() []PoolDefinition {
	_, _ = r.PruneStaleAccounts("")

	r.mu.RLock()
	defer r.mu.RUnlock()

	res := make([]PoolDefinition, 0, len(r.pools))
	for key, p := range r.pools {
		normalizePoolDefinition(&p)
		if live, ok := r.activeLeaders[key]; ok && live != "" {
			p.ActiveLeader = live
		}
		res = append(res, p)
	}
	sortPoolDefinitions(res)
	return res
}

// GetPool returns a pool by ID or base prefix if it exists, reconciling with disk.
func (r *PoolRegistry) GetPool(idOrPrefix string) (PoolDefinition, bool) {
	_, _ = r.PruneStaleAccounts("")

	r.mu.RLock()
	defer r.mu.RUnlock()

	key := strings.ToLower(strings.TrimSpace(idOrPrefix))
	if p, ok := r.pools[key]; ok {
		normalizePoolDefinition(&p)
		if live, hasLive := r.activeLeaders[key]; hasLive && live != "" {
			p.ActiveLeader = live
		}
		return p, true
	}
	// Fallback search by sovereign Pool ID, Name, DisplayName or RouteSlug
	for k, p := range r.pools {
		if strings.EqualFold(p.ID, key) ||
			strings.EqualFold(p.Name, key) ||
			strings.EqualFold(p.DisplayName, key) ||
			strings.EqualFold(p.RouteSlug, key) {
			normalizePoolDefinition(&p)
			if live, hasLive := r.activeLeaders[k]; hasLive && live != "" {
				p.ActiveLeader = live
			}
			return p, true
		}
	}
	return PoolDefinition{}, false
}

// SetActiveLeader dynamically updates the active leader for a pool
// when Auto Switcher Pro rotates leadership among pool members.
// It updates in-memory state and persists atomically to disk, emitting the .epoch signal.
// GetProjectLeader returns the pinned active leader for a given workspace/project in volatile RAM.
func (r *PoolRegistry) GetProjectLeader(poolKey, projectID string) (string, bool) {
	k := strings.ToLower(strings.TrimSpace(poolKey)) + "::" + strings.TrimSpace(projectID)
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.projectLeaders == nil {
		return "", false
	}
	auth, ok := r.projectLeaders[k]
	return auth, ok && auth != ""
}

// SetProjectLeader binds a specific active leader to a project in volatile RAM for cache affinity.
func (r *PoolRegistry) SetProjectLeader(poolKey, projectID, activeAuth string) {
	k := strings.ToLower(strings.TrimSpace(poolKey)) + "::" + strings.TrimSpace(projectID)
	auth := strings.TrimSpace(activeAuth)
	if strings.TrimSpace(poolKey) == "" || strings.TrimSpace(projectID) == "" || auth == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.projectLeaders == nil {
		r.projectLeaders = make(map[string]string)
	}
	r.projectLeaders[k] = auth
}

func (r *PoolRegistry) SetActiveLeader(basePrefix, activeAuth string) {
	key := strings.ToLower(strings.TrimSpace(basePrefix))
	auth := strings.TrimSpace(activeAuth)
	if key == "" || auth == "" {
		return
	}
	r.mu.Lock()
	if r.activeLeaders == nil {
		r.activeLeaders = make(map[string]string)
	}
	r.activeLeaders[key] = auth
	if p, ok := r.pools[key]; ok {
		p.ActiveLeader = auth
		r.pools[key] = p
	}
	r.mu.Unlock()

	_ = r.Save()
}

// RotatePoolLeader advances leadership in the given pool to the next available member.
// It updates memory and persists the state atomically, emitting the .epoch signal.
func (r *PoolRegistry) RotatePoolLeader(idOrPrefix string) (PoolDefinition, string, string, error) {
	pool, ok := r.GetPool(idOrPrefix)
	if !ok {
		return PoolDefinition{}, "", "", fmt.Errorf("pool %q not found", idOrPrefix)
	}

	members := pool.AllMembers()
	if len(members) < 2 {
		return pool, pool.ActiveLeader, pool.ActiveLeader, errors.New("pool has no reserve members to rotate")
	}

	current := pool.ActiveLeader
	if current == "" {
		current = pool.LeaderAuth
	}

	currIdx := -1
	for i, m := range members {
		if strings.EqualFold(m, current) {
			currIdx = i
			break
		}
	}

	nextIdx := (currIdx + 1) % len(members)
	nextLeader := members[nextIdx]

	r.SetActiveLeader(pool.BasePrefix, nextLeader)

	updatedPool, _ := r.GetPool(pool.BasePrefix)
	return updatedPool, current, nextLeader, nil
}

// PruneStaleAccounts checks registered pools against physical credential files in
// authDir. If authDir exists on disk:
//   - Missing reserve files are pruned from pool.Reserves.
//   - If LeaderAuth is missing, the first surviving reserve is promoted to leader.
//   - If all members have been deleted from disk, the pool is dissolved automatically.
//
// Returns true if state changed and was saved atomically.
func (r *PoolRegistry) PruneStaleAccounts(authDir string) (bool, error) {
	if authDir == "" {
		authDir = resolveAuthDir()
	}
	fi, err := os.Stat(authDir)
	if err != nil || !fi.IsDir() {
		return false, nil
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	return r.pruneStaleAccountsLocked(authDir)
}

func (r *PoolRegistry) pruneStaleAccountsLocked(authDir string) (bool, error) {
	changed := false
	toDelete := make([]string, 0)

	for key, pool := range r.pools {
		survivingReserves := make([]string, 0, len(pool.Reserves))
		for _, res := range pool.Reserves {
			trimmed := strings.TrimSpace(res)
			if trimmed == "" {
				continue
			}
			resPath := filepath.Join(authDir, trimmed)
			if _, err := os.Stat(resPath); err == nil {
				survivingReserves = append(survivingReserves, trimmed)
			} else {
				changed = true
			}
		}

		leaderAlive := false
		trimmedLeader := strings.TrimSpace(pool.LeaderAuth)
		if trimmedLeader != "" {
			leaderPath := filepath.Join(authDir, trimmedLeader)
			if _, err := os.Stat(leaderPath); err == nil {
				leaderAlive = true
			}
		}

		if !leaderAlive {
			changed = true
			if len(survivingReserves) > 0 {
				pool.LeaderAuth = survivingReserves[0]
				pool.Reserves = survivingReserves[1:]
				pool.Members = append([]string{pool.LeaderAuth}, pool.Reserves...)
				pool.ActiveLeader = pool.LeaderAuth
				if r.activeLeaders != nil {
					r.activeLeaders[key] = pool.LeaderAuth
				}
				// Saneamiento de MemberModels: limpiar cuentas eliminadas
				if len(pool.MemberModels) > 0 {
					cleanedModels := make(map[string]string)
					aliveMembers := pool.AllMembers()
					for _, am := range aliveMembers {
						if m, ok := pool.MemberModels[am]; ok && strings.TrimSpace(m) != "" {
							cleanedModels[am] = m
						}
					}
					pool.MemberModels = cleanedModels
				}
				pool.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
				r.pools[key] = pool
			} else {
				toDelete = append(toDelete, key)
			}
		} else if len(survivingReserves) != len(pool.Reserves) {
			changed = true
			pool.Reserves = survivingReserves
			pool.Members = append([]string{pool.LeaderAuth}, pool.Reserves...)
			// Saneamiento de MemberModels: limpiar reservas eliminadas
			if len(pool.MemberModels) > 0 {
				cleanedModels := make(map[string]string)
				aliveMembers := pool.AllMembers()
				for _, am := range aliveMembers {
					if m, ok := pool.MemberModels[am]; ok && strings.TrimSpace(m) != "" {
						cleanedModels[am] = m
					}
				}
				pool.MemberModels = cleanedModels
			}
			pool.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
			r.pools[key] = pool
		}
	}

	for _, delKey := range toDelete {
		delete(r.pools, delKey)
	}

	if changed {
		poolsList := make([]PoolDefinition, 0, len(r.pools))
		for _, p := range r.pools {
			poolsList = append(poolsList, p)
		}
		state := RegistryState{
			Version:   1,
			UpdatedAt: time.Now().UTC().Format(time.RFC3339),
			Pools:     poolsList,
		}
		data, err := json.MarshalIndent(state, "", "  ")
		if err != nil {
			return true, fmt.Errorf("marshal state on prune: %w", err)
		}
		dir := filepath.Dir(r.filePath)
		if dir != "" && dir != "." {
			_ = os.MkdirAll(dir, 0755)
		}
		tmpFile := fmt.Sprintf("%s.tmp.%d", r.filePath, time.Now().UnixNano())
		if err := os.WriteFile(tmpFile, data, 0644); err != nil {
			return true, fmt.Errorf("write temp state on prune: %w", err)
		}
		if err := os.Rename(tmpFile, r.filePath); err != nil {
			_ = os.Remove(tmpFile)
			return true, fmt.Errorf("rename temp state on prune: %w", err)
		}
	}

	return changed, nil
}

// validatePoolModelCompatibility guarantees that a pool never stores or executes models
// belonging to a foreign provider family (e.g. Gemini models in a Codex pool, or GPT models in a Gemini pool).
func validatePoolModelCompatibility(pool *PoolDefinition) error {
	if pool == nil {
		return nil
	}
	famShort := familyCanonicalShortName(pool.Family, pool.BasePrefix)

	checkModel := func(model string) error {
		m := strings.ToLower(strings.TrimSpace(model))
		if m == "" {
			return nil
		}
		for {
			idx := strings.Index(m, "/")
			if idx >= 0 && idx < len(m)-1 {
				m = m[idx+1:]
			} else {
				break
			}
		}

		isGemini := strings.Contains(m, "gemini")
		isClaude := strings.Contains(m, "claude") || strings.Contains(m, "sonnet") || strings.Contains(m, "opus") || strings.Contains(m, "haiku")
		isCodex := strings.Contains(m, "codex") || strings.Contains(m, "astra") || strings.Contains(m, "sol") || strings.Contains(m, "terra") || strings.Contains(m, "luna") || strings.Contains(m, "chatgpt") || strings.HasPrefix(m, "gpt-") || strings.HasPrefix(m, "o1") || strings.HasPrefix(m, "o3") || strings.HasPrefix(m, "o4")

		switch famShort {
		case "codex":
			if isGemini {
				return fmt.Errorf("incompatible model %q: cannot use gemini models in a codex pool", model)
			}
			if isClaude {
				return fmt.Errorf("incompatible model %q: cannot use claude models in a codex pool", model)
			}
		case "gemini":
			if isCodex {
				return fmt.Errorf("incompatible model %q: cannot use codex/gpt models in a gemini pool", model)
			}
			if isClaude {
				return fmt.Errorf("incompatible model %q: cannot use claude models in a pure gemini pool", model)
			}
		case "claude":
			if isGemini {
				return fmt.Errorf("incompatible model %q: cannot use gemini models in a claude pool", model)
			}
			if isCodex {
				return fmt.Errorf("incompatible model %q: cannot use codex/gpt models in a claude pool", model)
			}
		}
		return nil
	}

	for _, tm := range pool.Policy.TargetModels {
		if err := checkModel(tm); err != nil {
			return err
		}
	}
	for _, mm := range pool.MemberModels {
		if err := checkModel(mm); err != nil {
			return err
		}
	}
	return nil
}

// SavePool stores or updates a pool definition and commits atomically to disk.
func (r *PoolRegistry) SavePool(pool PoolDefinition) error {
	normalizePoolDefinition(&pool)

	trimmedPrefix := strings.TrimSpace(pool.BasePrefix)
	if trimmedPrefix == "" {
		return errors.New("base_prefix is required")
	}
	if !safePrefixPattern.MatchString(trimmedPrefix) {
		return errors.New("base_prefix contains invalid characters")
	}
	if len(pool.Members) == 0 || strings.TrimSpace(pool.LeaderAuth) == "" {
		return errors.New("at least one member account (members or leader_auth) is required")
	}

	if err := validatePoolModelCompatibility(&pool); err != nil {
		return err
	}

	key := strings.ToLower(trimmedPrefix)
	now := time.Now().UTC().Format(time.RFC3339)

	r.mu.Lock()
	// Check if pool already exists by ID (in case of rename/prefix update) or by key
	var existing PoolDefinition
	foundExisting := false
	oldKeyToRemove := ""
	if strings.TrimSpace(pool.ID) != "" {
		for k, p := range r.pools {
			if strings.EqualFold(p.ID, pool.ID) {
				existing = p
				foundExisting = true
				if k != key {
					oldKeyToRemove = k
				}
				break
			}
		}
	}
	if !foundExisting {
		if ex, ok := r.pools[key]; ok {
			existing = ex
			foundExisting = true
		}
	}

	if foundExisting {
		pool.CreatedAt = existing.CreatedAt
		if pool.ID == "" {
			pool.ID = existing.ID
		}
		if pool.DisplayName == "" {
			pool.DisplayName = existing.DisplayName
		}
		// Saneamiento de MemberModels: purgar cuentas liberadas que ya no pertenecen al pool
		memberSet := make(map[string]struct{}, len(pool.Members))
		for _, m := range pool.Members {
			memberSet[strings.ToLower(strings.TrimSpace(m))] = struct{}{}
		}
		if len(pool.MemberModels) > 0 {
			cleanedModels := make(map[string]string)
			for k, v := range pool.MemberModels {
				if _, exists := memberSet[strings.ToLower(strings.TrimSpace(k))]; exists {
					cleanedModels[k] = v
				}
			}
			pool.MemberModels = cleanedModels
		}
		if oldKeyToRemove != "" {
			delete(r.pools, oldKeyToRemove)
		}
	} else {
		pool.CreatedAt = now
		seq := len(r.pools) + 1
		famShort := familyCanonicalShortName(pool.Family, trimmedPrefix)
		canonicalPoolID := fmt.Sprintf("Pool-%02d-%s", seq, famShort)
		if pool.ID == "" {
			pool.ID = canonicalPoolID
		}
		if pool.DisplayName == "" || pool.DisplayName == trimmedPrefix {
			pool.DisplayName = canonicalPoolID
		}
	}
	pool.UpdatedAt = now
	pool.BasePrefix = trimmedPrefix
	pool.RouteSlug = trimmedPrefix
	if strings.TrimSpace(pool.Name) == "" {
		pool.Name = trimmedPrefix
	}
	if r.activeLeaders == nil {
		r.activeLeaders = make(map[string]string)
	}
	r.activeLeaders[key] = pool.ActiveLeader
	r.pools[key] = pool
	r.mu.Unlock()

	return r.Save()
}

// DeletePool removes a pool by ID or base prefix and commits atomically to disk.
func (r *PoolRegistry) DeletePool(idOrPrefix string) (bool, error) {
	target := strings.ToLower(strings.TrimSpace(idOrPrefix))
	if target == "" {
		return false, errors.New("id or base_prefix is required")
	}

	r.mu.Lock()
	matchedKey := ""
	if _, exists := r.pools[target]; exists {
		matchedKey = target
	} else {
		for k, p := range r.pools {
			if strings.EqualFold(p.ID, target) || strings.EqualFold(p.RouteSlug, target) {
				matchedKey = k
				break
			}
		}
	}
	if matchedKey == "" {
		r.mu.Unlock()
		return false, nil
	}
	delete(r.pools, matchedKey)
	r.mu.Unlock()

	if err := r.Save(); err != nil {
		return false, err
	}
	return true, nil
}

// Clear removes all pools and commits to disk.
func (r *PoolRegistry) Clear() error {
	r.mu.Lock()
	r.pools = make(map[string]PoolDefinition)
	r.mu.Unlock()

	return r.Save()
}

// isPoolsPath checks if an incoming management HTTP path targets the pools API endpoint.
func isPoolsPath(rawPath string) bool {
	normalized := strings.TrimSpace(rawPath)
	if idx := strings.IndexAny(normalized, "?#"); idx != -1 {
		normalized = normalized[:idx]
	}
	normalized = strings.TrimRight(normalized, "/")
	return strings.HasSuffix(normalized, poolsRoutePath) || strings.HasSuffix(normalized, poolsRoutePath+"/rotate")
}

// handlePoolsHTTP dispatches GET, POST, DELETE operations on /v0/management/auto-switcher-pro/pools.
func handlePoolsHTTP(req ManagementRequestPayload) ([]byte, error) {
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	registry := DefaultRegistry()

	switch method {
	case http.MethodGet:
		pools := registry.ListPools()
		return jsonManagementResponse(http.StatusOK, map[string]any{
			"ok":    true,
			"pools": pools,
			"count": len(pools),
		})

	case http.MethodPost:
		// Saneamiento de rotación virtual: POST /auto-switcher-pro/pools/rotate
		if strings.HasSuffix(strings.TrimRight(req.Path, "/"), "/rotate") {
			var rotPayload struct {
				ID         string `json:"id"`
				Prefix     string `json:"prefix"`
				BasePrefix string `json:"base_prefix"`
				PoolID     string `json:"pool_id"`
				Reason     string `json:"reason"`
				Force      *bool  `json:"force"`
			}
			if len(req.Body) > 0 {
				_ = json.Unmarshal(req.Body, &rotPayload)
			}
			target := strings.TrimSpace(rotPayload.ID)
			if target == "" {
				target = strings.TrimSpace(rotPayload.Prefix)
			}
			if target == "" {
				target = strings.TrimSpace(rotPayload.BasePrefix)
			}
			if target == "" {
				target = strings.TrimSpace(rotPayload.PoolID)
			}

			if target == "" {
				pools := registry.ListPools()
				if len(pools) > 0 {
					target = pools[0].BasePrefix
				}
			}

			if target == "" {
				return jsonManagementResponse(http.StatusBadRequest, map[string]string{
					"error":   "no_pools",
					"message": "no active pool found to rotate",
				})
			}

			pool, ok := registry.GetPool(target)
			if !ok {
				return jsonManagementResponse(http.StatusBadRequest, map[string]string{
					"error":   "pool_not_found",
					"message": fmt.Sprintf("pool %q not found", target),
				})
			}

			currentLeader := pool.ActiveLeader
			if currentLeader == "" {
				currentLeader = pool.LeaderAuth
			}

			reason := strings.TrimSpace(rotPayload.Reason)
			if reason == "" {
				reason = "manual_request"
			}

			isForced := rotPayload.Force != nil && *rotPayload.Force
			// Si no es una rotación forzada (por error 429 o red), comprobar si el líder realmente necesita descanso
			if !isForced && (reason == "agent turn" || reason == "preventive" || (rotPayload.Force != nil && !*rotPayload.Force)) {
				predEngine := GetPredictiveEngine()
				poolFam := familyCanonicalShortName(pool.Family, pool.BasePrefix)
				if !predEngine.ShouldPreventiveCool(currentLeader, poolFam) {
					resp := map[string]any{
						"ok":             true,
						"rotated":        false,
						"pool_id":        pool.ID,
						"prefix":         pool.BasePrefix,
						"current_leader": currentLeader,
						"reason":         "leader_healthy",
						"message":        fmt.Sprintf("Pool %s leader %s is healthy; rotation skipped to preserve prompt cache", pool.BasePrefix, currentLeader),
					}

					// Ghost Warmup Recommendation: si el líder está en fatiga >= 75% o enfriamiento,
					// sugerir a la extensión de Pi la mejor reserva para pre-calentar el Prompt Cache con inferencia real
					cEmail := strings.TrimSuffix(strings.TrimPrefix(currentLeader, "antigravity-"), ".json")
					fatiguePct, isCooling, _ := predEngine.GetAccountStatus(cEmail, poolFam)
					if fatiguePct >= 75.0 || isCooling {
						members := pool.AllMembers()
						var bestReserve string
						var bestScore float64 = -1
						for _, m := range members {
							if strings.EqualFold(m, currentLeader) {
								continue
							}
							resEmail := strings.TrimSuffix(strings.TrimPrefix(m, "antigravity-"), ".json")
							if predEngine.ShouldPreventiveCool(resEmail, poolFam) {
								continue
							}
							q, hasQ := predEngine.GetLiveQuota(resEmail, poolFam)
							score := 50.0
							if hasQ {
								score = q.Window5hPct + q.WeeklyPct
							}
							if score > bestScore {
								bestScore = score
								bestReserve = m
							}
						}
						if bestReserve != "" {
							targetModel := "gemini-3.8-flash-high"
							if len(pool.Policy.TargetModels) > 0 {
								targetModel = pool.Policy.TargetModels[0]
							}
							resp["warmup_needed"] = true
							resp["warmup_reserve"] = bestReserve
							resp["target_model"] = targetModel
						}
					}

					return jsonManagementResponse(http.StatusOK, resp)
				}

				// Pilar 2, Sección 6 de AGENTS.md & Histeresis Matemática:
				// Si el líder necesita enfriamiento preventivo:
				// 1) Enforce sticky leader if no leader quota is available in RAM (!hasLeaderQuota).
				// 2) Exigir que el líder esté en zona de peligro (< 20%) y que la mejor reserva
				//    tenga al menos +35% (Δ >= 35%) de ventaja en ventana de 5h antes de rotar.
				leaderEmail := strings.TrimSuffix(strings.TrimPrefix(currentLeader, "antigravity-"), ".json")
				leaderQuota, hasLeaderQuota := predEngine.GetLiveQuota(leaderEmail, poolFam)

				if !hasLeaderQuota {
					resp := map[string]any{
						"ok":             true,
						"rotated":        false,
						"pool_id":        pool.ID,
						"prefix":         pool.BasePrefix,
						"current_leader": currentLeader,
						"reason":         "unknown_leader_quota",
						"message":        fmt.Sprintf("Pool %s leader %s quota is unknown; rotation skipped to enforce sticky leader", pool.BasePrefix, currentLeader),
					}
					return jsonManagementResponse(http.StatusOK, resp)
				}

				members := pool.AllMembers()
				hasHealthyReserveWithAdvantage := false
				for _, m := range members {
					if strings.EqualFold(m, currentLeader) {
						continue
					}
					resEmail := strings.TrimSuffix(strings.TrimPrefix(m, "antigravity-"), ".json")
					if !predEngine.ShouldPreventiveCool(resEmail, poolFam) {
						if q, hasQ := predEngine.GetLiveQuota(resEmail, poolFam); hasQ {
							if leaderQuota.Window5hPct < 20.0 && (q.Window5hPct-leaderQuota.Window5hPct) >= 35.0 {
								hasHealthyReserveWithAdvantage = true
								break
							}
						}
					}
				}

				if !hasHealthyReserveWithAdvantage {
					resp := map[string]any{
						"ok":             true,
						"rotated":        false,
						"pool_id":        pool.ID,
						"prefix":         pool.BasePrefix,
						"current_leader": currentLeader,
						"reason":         "hysteresis_margin_not_met",
						"message":        fmt.Sprintf("Pool %s leader %s maintained; reserve quota advantage (+35%%) or danger threshold (<20%%) not met", pool.BasePrefix, currentLeader),
					}
					return jsonManagementResponse(http.StatusOK, resp)
				}
			}

			p, oldLeader, newLeader, err := registry.RotatePoolLeader(target)
			if err != nil {
				return jsonManagementResponse(http.StatusBadRequest, map[string]string{
					"error":   "rotate_failed",
					"message": err.Error(),
				})
			}

			analytics.RecordAuditEvent(analytics.AuditEvent{
				PoolID:         p.ID,
				EventType:      "MANUAL_OR_HOOK",
				TriggerReason:  reason,
				PreviousLeader: oldLeader,
				NewLeader:      newLeader,
				StatusCode:     200,
			})

			return jsonManagementResponse(http.StatusOK, map[string]any{
				"ok":         true,
				"rotated":    true,
				"pool_id":    p.ID,
				"prefix":     p.BasePrefix,
				"old_leader": oldLeader,
				"new_leader": newLeader,
				"reason":     reason,
				"message":    fmt.Sprintf("Pool %s rotated to %s (reason: %s)", p.BasePrefix, newLeader, reason),
			})
		}

		if len(req.Body) == 0 {
			return jsonManagementResponse(http.StatusBadRequest, map[string]string{
				"error":   "bad_request",
				"message": "request body is required",
			})
		}

		var pool PoolDefinition
		if err := json.Unmarshal(req.Body, &pool); err != nil {
			return jsonManagementResponse(http.StatusBadRequest, map[string]string{
				"error":   "bad_request",
				"message": fmt.Sprintf("malformed JSON payload: %v", err),
			})
		}

		if err := registry.SavePool(pool); err != nil {
			return jsonManagementResponse(http.StatusBadRequest, map[string]string{
				"error":   "invalid_pool",
				"message": err.Error(),
			})
		}

		saved, _ := registry.GetPool(pool.BasePrefix)
		return jsonManagementResponse(http.StatusOK, map[string]any{
			"ok":      true,
			"pool":    saved,
			"message": fmt.Sprintf("Pool %s saved successfully", saved.BasePrefix),
		})

	case http.MethodDelete:
		prefix := ""
		if len(req.Query) > 0 {
			for _, k := range []string{"id", "prefix", "base_prefix"} {
				if vals, ok := req.Query[k]; ok && len(vals) > 0 && vals[0] != "" {
					prefix = vals[0]
					break
				}
			}
		}

		if prefix == "" && strings.Contains(req.Path, "?") {
			if u, err := url.Parse(req.Path); err == nil {
				for _, k := range []string{"id", "prefix", "base_prefix"} {
					if v := u.Query().Get(k); v != "" {
						prefix = v
						break
					}
				}
			}
		}

		// Also check if id or prefix is supplied in the JSON body
		if prefix == "" && len(req.Body) > 0 {
			var bodyData struct {
				ID         string `json:"id"`
				Prefix     string `json:"prefix"`
				BasePrefix string `json:"base_prefix"`
			}
			if err := json.Unmarshal(req.Body, &bodyData); err == nil {
				if bodyData.ID != "" {
					prefix = bodyData.ID
				} else if bodyData.Prefix != "" {
					prefix = bodyData.Prefix
				} else {
					prefix = bodyData.BasePrefix
				}
			}
		}

		if strings.TrimSpace(prefix) == "" {
			return jsonManagementResponse(http.StatusBadRequest, map[string]string{
				"error":   "bad_request",
				"message": "prefix query parameter is required to delete a pool",
			})
		}

		deleted, err := registry.DeletePool(prefix)
		if err != nil {
			return jsonManagementResponse(http.StatusInternalServerError, map[string]string{
				"error":   "delete_error",
				"message": err.Error(),
			})
		}

		return jsonManagementResponse(http.StatusOK, map[string]any{
			"ok":      true,
			"deleted": deleted,
			"prefix":  prefix,
			"message": fmt.Sprintf("Pool %s dissolved successfully", prefix),
		})

	default:
		return jsonManagementResponse(http.StatusMethodNotAllowed, map[string]string{
			"error":   "method_not_allowed",
			"message": fmt.Sprintf("method %s not allowed on pools endpoint", method),
		})
	}
}
