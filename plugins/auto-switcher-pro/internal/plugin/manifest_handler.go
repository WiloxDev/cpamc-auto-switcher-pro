package plugin

import (
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
	OK        bool                     `json:"ok"`
	Timestamp int64                    `json:"timestamp"`
	Epoch     string                   `json:"epoch"`
	Pools     []PoolDefinition         `json:"pools"`
	Telemetry []AccountQuotaTelemetry  `json:"telemetry"`
	Accounts  []ManifestAccountSummary `json:"accounts"`
}

type ManifestAccountSummary struct {
	AccountKey  string  `json:"account_key"`
	Email       string  `json:"email"`
	PoolID      string  `json:"pool_id,omitempty"`
	BasePrefix  string  `json:"base_prefix,omitempty"`
	Role        string  `json:"role"` // "leader", "reserve", "unassigned"
	Window5hPct float64 `json:"window_5h_pct"`
	WeeklyPct   float64 `json:"weekly_pct"`
	IsCooling   bool    `json:"is_cooling"`
	FatiguePct  float64 `json:"fatigue_pct"`
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
			if !q.UpdatedAt.IsZero() {
				w5h = q.Window5hPct
				wWeekly = q.WeeklyPct
			}

			accountSummaries = append(accountSummaries, ManifestAccountSummary{
				AccountKey:  cleanAuth,
				Email:       email,
				PoolID:      p.ID,
				BasePrefix:  p.BasePrefix,
				Role:        role,
				Window5hPct: w5h,
				WeeklyPct:   wWeekly,
				IsCooling:   isCooling,
				FatiguePct:  fatigue,
			})
		}
	}

	resp := ManifestResponse{
		OK:        true,
		Timestamp: time.Now().Unix(),
		Epoch:     epochStr,
		Pools:     pools,
		Telemetry: liveQuotas,
		Accounts:  accountSummaries,
	}

	return jsonManagementResponse(http.StatusOK, resp)
}
