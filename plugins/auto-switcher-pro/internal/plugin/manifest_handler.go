package plugin

import (
	"auto-switcher-pro/internal/analytics"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const manifestRoutePath = "/auto-switcher-pro/manifest"

func isManifestPath(p string) bool {
	norm := strings.TrimSpace(p)
	if idx := strings.IndexAny(norm, "?#"); idx != -1 {
		norm = norm[:idx]
	}
	norm = strings.TrimRight(norm, "/")
	return strings.HasSuffix(norm, manifestRoutePath)
}

// ManifestResponse estructura la agregación O(1) de estado en RAM para clientes
type ManifestResponse struct {
	OK         bool                                  `json:"ok"`
	Timestamp  int64                                 `json:"timestamp"`
	Epoch      string                                `json:"epoch"`
	Pools      []PoolDefinition                      `json:"pools"`
	Telemetry  []AccountQuotaTelemetry               `json:"telemetry"`
	Accounts   []ManifestAccountSummary              `json:"accounts"`
	Lifecycle  *analytics.LifecycleSummary           `json:"lifecycle,omitempty"`
	Lifecycles map[string]*analytics.LifecycleSummary `json:"lifecycles"`
}

type ManifestAccountSummary struct {
	AccountKey      string  `json:"account_key"`
	Email           string  `json:"email"`
	PoolID          string  `json:"pool_id,omitempty"`
	BasePrefix      string  `json:"base_prefix,omitempty"`
	Role            string  `json:"role"` // "leader", "reserve", "unassigned"
	Window5hPct     float64 `json:"window_5h_pct"`
	WeeklyPct       float64 `json:"weekly_pct"`
	Window5hResetIn int64   `json:"window_5h_reset_in"`
	WeeklyResetIn   int64   `json:"weekly_reset_in"`
	IsCooling       bool    `json:"is_cooling"`
	FatiguePct      float64 `json:"fatigue_pct"`
	StabilityScore  float64 `json:"stability_score,omitempty"`
	HealthRating    string  `json:"health_rating,omitempty"`
	RecentErrors    int     `json:"recent_errors,omitempty"`
}

func handleManifestHTTP(req ManagementRequestPayload) ([]byte, error) {
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method != http.MethodGet && method != http.MethodHead {
		return jsonManagementResponse(http.StatusMethodNotAllowed, map[string]string{
			"error":   "method_not_allowed",
			"message": "Only GET and HEAD are allowed on manifest endpoint",
		})
	}

	reg := activeRegistry()
	var pools []PoolDefinition
	if reg != nil {
		pools = reg.ListPools()
	}
	pe := GetPredictiveEngine()
	liveQuotas := pe.GetAllLiveQuotas()

	// Leer epoch actual
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
		epochStr = "1"
	}

	// Mapear cuotas a mapa por accountKey normalizado
	quotaMap := make(map[string]AccountQuotaTelemetry)
	for _, q := range liveQuotas {
		norm := normalizeAccountKey(q.AccountKey)
		quotaMap[norm] = q
	}

	// Construir resumen de cuentas
	accountSummaries := make([]ManifestAccountSummary, 0)
	seenAccounts := make(map[string]bool)

	for _, p := range pools {
		allMembers := append([]string{p.LeaderAuth}, p.Reserves...)
		if len(p.Members) > 0 {
			allMembers = append(allMembers, p.Members...)
		}

		activeLeaderAuth := p.ActiveLeader
		if activeLeaderAuth == "" {
			activeLeaderAuth = p.LeaderAuth
		}

		for _, auth := range allMembers {
			cleanAuth := strings.TrimSpace(auth)
			if cleanAuth == "" || seenAccounts[cleanAuth] {
				continue
			}
			seenAccounts[cleanAuth] = true

			email := strings.TrimSuffix(strings.TrimPrefix(cleanAuth, "antigravity-"), ".json")
			normKey := normalizeAccountKey(email)

			role := "reserve"
			if cleanAuth == activeLeaderAuth {
				role = "leader"
			}

			q := quotaMap[normKey]
			fatigue, isCooling, _ := pe.GetAccountStatus(email)

			w5h := 95.0
			wWeekly := 95.0
			var w5hResetIn int64
			var wWeeklyResetIn int64
			if !q.UpdatedAt.IsZero() {
				w5h = q.Window5hPct
				wWeekly = q.WeeklyPct
				w5hResetIn = q.Window5hResetIn
				wWeeklyResetIn = q.WeeklyResetIn
			}

			stab, _ := analytics.QueryAccountStability(email)

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
				StabilityScore:  stab.StabilityScore,
				HealthRating:    stab.HealthRating,
				RecentErrors:    stab.RecentErrors,
			})
		}
	}

	// Incluir cuentas standalone / unassigned (sin pool) de cualquier proveedor (Google, OpenCode, NVIDIA, etc.)
	authDir := resolveAuthDir()
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

			w5h := 95.0
			wWeekly := 95.0
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
					Prefix   string `json:"prefix"`
					Note     string `json:"note"`
					Label    string `json:"label"`
					Provider string `json:"provider"`
					Type     string `json:"type"`
					Email    string `json:"email"`
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

			stab, _ := analytics.QueryAccountStability(email)

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
				StabilityScore:  stab.StabilityScore,
				HealthRating:    stab.HealthRating,
				RecentErrors:    stab.RecentErrors,
			})
		}
	}

	// Computar LifecycleSummary para cada pool independiente (evitando el cuello de botella global)
	lifecyclesByPool := make(map[string]*analytics.LifecycleSummary)
	targetPoolID := ""
	if len(pools) > 0 {
		targetPoolID = pools[0].ID
	}
	for _, p := range pools {
		lSumm, err := analytics.GetLifecycleSummary(p.ID, "24h")
		if err == nil && lSumm != nil {
			lifecyclesByPool[p.ID] = lSumm
			if p.BasePrefix != "" {
				lifecyclesByPool[p.BasePrefix] = lSumm
			}
		}
	}

	lifecycleSumm := lifecyclesByPool[targetPoolID]
	if lifecycleSumm == nil {
		lifecycleSumm, _ = analytics.GetLifecycleSummary(targetPoolID, "24h")
	}

	resp := ManifestResponse{
		OK:         true,
		Timestamp:  time.Now().Unix(),
		Epoch:      epochStr,
		Pools:      pools,
		Telemetry:  liveQuotas,
		Accounts:   accountSummaries,
		Lifecycle:  lifecycleSumm,
		Lifecycles: lifecyclesByPool,
	}

	return jsonManagementResponse(http.StatusOK, resp)
}
