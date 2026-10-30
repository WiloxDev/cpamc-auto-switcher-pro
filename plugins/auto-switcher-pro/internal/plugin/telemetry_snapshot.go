package plugin

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	telemetryRoutePath = "/auto-switcher-pro/telemetry"
	telemetryLivePath  = "/auto-switcher-pro/telemetry/live"
)

// TelemetrySnapshot represents a consolidated, ultra-lightweight telemetry snapshot
// intended for fast O(1) reads by external consumers (Sidebar, TUI, CLI, scripts)
// without requiring external quota queries or mutating state.
type TelemetrySnapshot struct {
	OK        bool                   `json:"ok"`
	Timestamp int64                  `json:"timestamp"`
	Epoch     string                 `json:"epoch"`
	Pools     []PoolTelemetrySummary `json:"pools"`
	Accounts  []ManifestAccountSummary `json:"accounts"`
}

// PoolTelemetrySummary provides sovereign pool-centric quota and active leader information.
type PoolTelemetrySummary struct {
	PoolID          string   `json:"pool_id"`
	BasePrefix      string   `json:"base_prefix"`
	Family          string   `json:"family"`
	ActiveLeader    string   `json:"active_leader"`
	LeaderEmail     string   `json:"leader_email"`
	Reserves        []string `json:"reserves"`
	Window5hPct     float64  `json:"window_5h_pct"`
	WeeklyPct       float64  `json:"weekly_pct"`
	Window5hResetIn int64    `json:"window_5h_reset_in"`
	WeeklyResetIn   int64    `json:"weekly_reset_in"`
	IsCooling       bool     `json:"is_cooling"`
	FatiguePct      float64  `json:"fatigue_pct"`
}

var (
	telemetrySnapshotMu sync.RWMutex
	lastSnapshotCache   *TelemetrySnapshot
	lastSnapshotTime    time.Time
)

// isTelemetryLivePath checks if request path matches /auto-switcher-pro/telemetry/live
// or /auto-switcher-pro/telemetry
func isTelemetryLivePath(p string) bool {
	norm := strings.TrimSpace(p)
	if idx := strings.IndexAny(norm, "?#"); idx != -1 {
		norm = norm[:idx]
	}
	norm = strings.TrimRight(norm, "/")
	return strings.HasSuffix(norm, telemetryLivePath) || strings.HasSuffix(norm, telemetryRoutePath)
}

// BuildTelemetrySnapshot generates the consolidated telemetry snapshot in RAM.
func BuildTelemetrySnapshot() TelemetrySnapshot {
	reg := activeRegistry()
	var pools []PoolDefinition
	if reg != nil {
		pools = reg.ListPools()
	}
	pe := GetPredictiveEngine()
	liveQuotas := pe.GetAllLiveQuotas()

	// Read epoch
	epochStr := ""
	epochTargets := []string{
		"/dev/shm/auto-switcher-pro.epoch",
	}
	if reg != nil && reg.filePath != "" {
		epochTargets = append(epochTargets, filepath.Join(filepath.Dir(reg.filePath), "auto-switcher-pro.epoch"))
	}
	for _, ep := range epochTargets {
		if data, err := os.ReadFile(ep); err == nil && len(data) > 0 {
			epochStr = strings.TrimSpace(string(data))
			break
		}
	}
	if epochStr == "" {
		epochStr = fmt.Sprintf("%d", time.Now().UnixNano())
	}

	// Map live quotas by normalized account key
	quotaMap := make(map[string]AccountQuotaTelemetry)
	for _, q := range liveQuotas {
		norm := normalizeAccountKey(q.AccountKey)
		quotaMap[norm] = q
	}

	authDir := resolveAuthDir()
	accountSummaries := make([]ManifestAccountSummary, 0)
	seenAccounts := make(map[string]bool)
	poolSummaries := make([]PoolTelemetrySummary, 0, len(pools))

	for _, p := range pools {
		allMembers := append([]string{p.LeaderAuth}, p.Reserves...)
		if len(p.Members) > 0 {
			allMembers = append(allMembers, p.Members...)
		}

		activeLeaderAuth := p.ActiveLeader
		if activeLeaderAuth == "" {
			activeLeaderAuth = p.LeaderAuth
		}

		poolFam := familyCanonicalShortName(p.Family, p.BasePrefix)
		var leaderEmail string
		var leaderW5h float64 = 100.0
		var leaderWeekly float64 = 100.0
		var leaderW5hReset int64
		var leaderWeeklyReset int64
		var leaderCooling bool
		var leaderFatigue float64

		cleanReserves := make([]string, 0)

		for _, auth := range allMembers {
			cleanAuth := strings.TrimSpace(auth)
			if cleanAuth == "" || seenAccounts[cleanAuth] {
				continue
			}
			seenAccounts[cleanAuth] = true

			email := strings.TrimSuffix(strings.TrimPrefix(cleanAuth, "antigravity-"), ".json")
			normKey := normalizeAccountKey(email)

			// Read credential metadata to extract exact email if available
			accountEmail := email
			if data, err := os.ReadFile(filepath.Join(authDir, cleanAuth)); err == nil {
				var cred struct {
					Email string `json:"email"`
				}
				if json.Unmarshal(data, &cred) == nil && cred.Email != "" {
					accountEmail = cred.Email
				}
			}

			isLeader := (cleanAuth == activeLeaderAuth)
			role := "reserve"
			if isLeader {
				role = "leader"
				leaderEmail = accountEmail
			} else {
				cleanReserves = append(cleanReserves, cleanAuth)
			}

			q, hasQ := pe.GetLiveQuota(accountEmail, poolFam)
			if !hasQ {
				q, hasQ = quotaMap[normKey]
			}
			fatigue, isCooling, _ := pe.GetAccountStatus(accountEmail, poolFam)

			w5h := 100.0
			wWeekly := 100.0
			var w5hResetIn int64
			var wWeeklyResetIn int64
			if hasQ && !q.UpdatedAt.IsZero() {
				w5h = q.Window5hPct
				wWeekly = q.WeeklyPct
				w5hResetIn = q.Window5hResetIn
				wWeeklyResetIn = q.WeeklyResetIn
			}

			if isLeader {
				leaderW5h = w5h
				leaderWeekly = wWeekly
				leaderW5hReset = w5hResetIn
				leaderWeeklyReset = wWeeklyResetIn
				leaderCooling = isCooling
				leaderFatigue = fatigue
			}

			accountSummaries = append(accountSummaries, ManifestAccountSummary{
				AccountKey:      cleanAuth,
				Email:           email,
				PoolID:          p.ID,
				BasePrefix:      p.BasePrefix,
				Role:            role,
				Window5hPct:     w5h,
				WeeklyPct:       wWeekly,
				Window5hResetIn: w5hResetIn,
				WeeklyResetIn:   wWeeklyResetIn,
				IsCooling:       isCooling,
				FatiguePct:      fatigue,
			})
		}

		poolSummaries = append(poolSummaries, PoolTelemetrySummary{
			PoolID:          p.ID,
			BasePrefix:      p.BasePrefix,
			Family:          poolFam,
			ActiveLeader:    activeLeaderAuth,
			LeaderEmail:     leaderEmail,
			Reserves:        cleanReserves,
			Window5hPct:     leaderW5h,
			WeeklyPct:       leaderWeekly,
			Window5hResetIn: leaderW5hReset,
			WeeklyResetIn:   leaderWeeklyReset,
			IsCooling:       leaderCooling,
			FatiguePct:      leaderFatigue,
		})
	}

	// Standalone accounts
	if entries, err := os.ReadDir(authDir); err == nil {
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") || strings.HasPrefix(e.Name(), ".") {
				continue
			}
			cleanAuth := e.Name()
			if seenAccounts[cleanAuth] {
				continue
			}
			seenAccounts[cleanAuth] = true

			email := strings.TrimSuffix(strings.TrimPrefix(cleanAuth, "antigravity-"), ".json")
			normKey := normalizeAccountKey(email)
			q := quotaMap[normKey]
			fatigue, isCooling, _ := pe.GetAccountStatus(email)

			w5h := 100.0
			wWeekly := 100.0
			var w5hResetIn int64
			var wWeeklyResetIn int64
			if !q.UpdatedAt.IsZero() {
				w5h = q.Window5hPct
				wWeekly = q.WeeklyPct
				w5hResetIn = q.Window5hResetIn
				wWeeklyResetIn = q.WeeklyResetIn
			}

			prefix := ""
			accountLabel := email
			if data, err := os.ReadFile(filepath.Join(authDir, cleanAuth)); err == nil {
				var cred struct {
					Prefix string `json:"prefix"`
					Note   string `json:"note"`
					Label  string `json:"label"`
					Email  string `json:"email"`
				}
				if json.Unmarshal(data, &cred) == nil {
					prefix = strings.TrimSpace(cred.Prefix)
					if prefix == "" {
						prefix = strings.TrimSpace(cred.Note)
					}
					if cred.Label != "" {
						accountLabel = cred.Label
					} else if cred.Email != "" {
						accountLabel = cred.Email
					}
				}
			}

			accountSummaries = append(accountSummaries, ManifestAccountSummary{
				AccountKey:      cleanAuth,
				Email:           accountLabel,
				PoolID:          "",
				BasePrefix:      prefix,
				Role:            "unassigned",
				Window5hPct:     w5h,
				WeeklyPct:       wWeekly,
				Window5hResetIn: w5hResetIn,
				WeeklyResetIn:   wWeeklyResetIn,
				IsCooling:       isCooling,
				FatiguePct:      fatigue,
			})
		}
	}

	return TelemetrySnapshot{
		OK:        true,
		Timestamp: time.Now().Unix(),
		Epoch:     epochStr,
		Pools:     poolSummaries,
		Accounts:  accountSummaries,
	}
}

// WriteAtomicTelemetrySnapshot serializes the snapshot to both disk and shared memory (/dev/shm).
func WriteAtomicTelemetrySnapshot() error {
	snapshot := BuildTelemetrySnapshot()

	telemetrySnapshotMu.Lock()
	lastSnapshotCache = &snapshot
	lastSnapshotTime = time.Now()
	telemetrySnapshotMu.Unlock()

	data, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal telemetry snapshot: %w", err)
	}

	// 1. Write to state directory next to auto-switcher-pro-state.json
	reg := activeRegistry()
	var stateDir string
	if reg != nil && reg.filePath != "" {
		stateDir = filepath.Dir(reg.filePath)
	} else {
		stateDir = resolveStateFilePath("")
		stateDir = filepath.Dir(stateDir)
	}

	if stateDir != "" && stateDir != "." {
		_ = os.MkdirAll(stateDir, 0755)
		targetFile := filepath.Join(stateDir, "auto-switcher-pro-telemetry.json")
		tmpFile := fmt.Sprintf("%s.tmp.%d", targetFile, time.Now().UnixNano())
		if err := os.WriteFile(tmpFile, data, 0644); err == nil {
			_ = os.Rename(tmpFile, targetFile)
		}
	}

	// 2. Ultra-low latency memory-mapped /dev/shm for local processes (Linux/Docker)
	if fi, err := os.Stat("/dev/shm"); err == nil && fi.IsDir() {
		shmTarget := "/dev/shm/auto-switcher-pro-telemetry.json"
		tmpShm := fmt.Sprintf("%s.tmp.%d", shmTarget, time.Now().UnixNano())
		if err := os.WriteFile(tmpShm, data, 0644); err == nil {
			_ = os.Rename(tmpShm, shmTarget)
		}
	}

	return nil
}

// handleTelemetryLiveHTTP handles GET/HEAD on /auto-switcher-pro/telemetry/live
func handleTelemetryLiveHTTP(req ManagementRequestPayload) ([]byte, error) {
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method != http.MethodGet && method != http.MethodHead {
		return jsonManagementResponse(http.StatusMethodNotAllowed, map[string]string{
			"error":   "method_not_allowed",
			"message": "Only GET and HEAD are allowed on telemetry snapshot endpoint",
		})
	}

	snapshot := BuildTelemetrySnapshot()
	return jsonManagementResponse(http.StatusOK, snapshot)
}
