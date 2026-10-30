package plugin

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"auto-switcher-pro/internal/analytics"
)

// PredictiveConfig define la configuración del motor predictivo
type PredictiveConfig struct {
	Enabled        bool    `json:"enabled"`
	MaxReqsPerHour int     `json:"max_reqs_per_hour"` // Default: 80
	ThresholdPct   float64 `json:"threshold_pct"`     // Default: 80.0 (%)
	CoolingMinutes int     `json:"cooling_minutes"`   // Default: 15
}

// DefaultPredictiveConfig devuelve los valores seguros por defecto
func DefaultPredictiveConfig() PredictiveConfig {
	return PredictiveConfig{
		Enabled:        true,
		MaxReqsPerHour: 80,
		ThresholdPct:   80.0,
		CoolingMinutes: 15,
	}
}

// RequestRecord almacena una llamada en la ventana móvil
type RequestRecord struct {
	Timestamp time.Time
}

// AccountQuotaTelemetry almacena la telemetría viva de cuotas de una cuenta
type AccountQuotaTelemetry struct {
	AccountKey      string    `json:"account_key"`        // filename o email
	Family          string    `json:"family,omitempty"`  // e.g. "gemini", "claude", "codex" (para evitar colisiones entre familias de la misma cuenta)
	Window5hPct     float64   `json:"window_5h_pct"`      // 0.0 - 100.0 (% cuota restante 5h)
	WeeklyPct       float64   `json:"weekly_pct"`         // 0.0 - 100.0 (% cuota restante semanal)
	Window5hResetIn int64     `json:"window_5h_reset_in"` // segundos restantes para refresco 5h
	WeeklyResetIn   int64     `json:"weekly_reset_in"`    // segundos restantes para refresco semanal
	Plan            string    `json:"plan,omitempty"`     // e.g. "Pro", "Free"
	UpdatedAt       time.Time `json:"updated_at"`
}

// normalizeFamily normaliza la familia de cuota a "gemini", "claude", "codex", etc.
func normalizeFamily(fam string) string {
	f := strings.ToLower(strings.TrimSpace(fam))
	switch {
	case strings.Contains(f, "claude") || strings.Contains(f, "sonnet") || strings.Contains(f, "opus"):
		return "claude"
	case strings.Contains(f, "codex"):
		return "codex"
	default:
		if f == "" {
			return "gemini"
		}
		return f
	}
}

// normalizeAccountKey normaliza un identificador de cuenta para búsqueda insensible a formato
func normalizeAccountKey(k string) string {
	lower := strings.ToLower(strings.TrimSpace(k))
	lower = strings.TrimPrefix(lower, "antigravity-")
	lower = strings.TrimSuffix(lower, ".json")
	return lower
}

// compositeQuotaKey genera una clave compuesta (accountKey:family) para aislar cuotas de distintos modelos en la misma cuenta
func compositeQuotaKey(accountKey, family string) string {
	acc := normalizeAccountKey(accountKey)
	fam := normalizeFamily(family)
	return acc + ":" + fam
}

// PredictiveEngine gestiona la fatiga y enfriamiento preventivo de cuentas
type PredictiveEngine struct {
	mu           sync.RWMutex
	config       PredictiveConfig
	activity     map[string][]RequestRecord       // accountKey -> lista de timestamps
	cooling      map[string]time.Time             // accountKey -> hasta cuándo descansa
	quotas       map[string]AccountQuotaTelemetry // accountKey -> telemetría de cuota viva
	lastActivity map[string]time.Time             // accountKey -> última interacción para seguimiento de Cache TTL
}

var globalPredictiveEngine *PredictiveEngine
var predictiveOnce sync.Once

// GetPredictiveEngine obtiene la instancia única del motor predictivo
func GetPredictiveEngine() *PredictiveEngine {
	predictiveOnce.Do(func() {
		globalPredictiveEngine = &PredictiveEngine{
			config:       DefaultPredictiveConfig(),
			activity:     make(map[string][]RequestRecord),
			cooling:      make(map[string]time.Time),
			quotas:       make(map[string]AccountQuotaTelemetry),
			lastActivity: make(map[string]time.Time),
		}
		globalPredictiveEngine.hydrateFromSQLite()
	})
	return globalPredictiveEngine
}

// hydrateFromSQLite restores cooling, activity timestamps, and quotas from persistent SQLite storage.
func (pe *PredictiveEngine) hydrateFromSQLite() {
	healthMap, err := analytics.GetAllAccountHealth()
	if err != nil || len(healthMap) == 0 {
		return
	}
	pe.mu.Lock()
	defer pe.mu.Unlock()

	now := time.Now()
	for key, h := range healthMap {
		if h.CoolUntilMs > 0 {
			coolUntil := time.UnixMilli(h.CoolUntilMs)
			if coolUntil.After(now) {
				pe.cooling[key] = coolUntil
			}
		}
		if h.Window5hPct > 0 && h.WeeklyPct > 0 {
			pe.quotas[key] = AccountQuotaTelemetry{
				AccountKey:  key,
				Window5hPct: h.Window5hPct,
				WeeklyPct:   h.WeeklyPct,
				UpdatedAt:   time.UnixMilli(h.UpdatedAtMs),
			}
		}
		if h.LastUsedMs > 0 {
			pe.lastActivity[key] = time.UnixMilli(h.LastUsedMs)
		}
	}
}

// AccountRecoveryETA represents computed recovery time estimates for an account.
type AccountRecoveryETA struct {
	AccountKey      string  `json:"account_key"`
	IsCooling       bool    `json:"is_cooling"`
	CoolingSeconds  int64   `json:"cooling_seconds"`
	Window5hPct     float64 `json:"window_5h_pct"`
	Window5hResetIn int64   `json:"window_5h_reset_in"`
	FatiguePct      float64 `json:"fatigue_pct"`
	EstimatedETAStr string  `json:"estimated_eta_str"`
}

// GetAccountRecoveryETA returns precise remaining seconds and a human-readable recovery estimate.
func (pe *PredictiveEngine) GetAccountRecoveryETA(accountEmail string) AccountRecoveryETA {
	pe.mu.RLock()
	defer pe.mu.RUnlock()

	key := normalizeAccountKey(accountEmail)
	now := time.Now()

	eta := AccountRecoveryETA{
		AccountKey: key,
	}

	// 1. Cooling check
	if coolUntil, ok := pe.cooling[key]; ok && now.Before(coolUntil) {
		eta.IsCooling = true
		eta.CoolingSeconds = int64(time.Until(coolUntil).Seconds())
	}

	// 2. Quota telemetry check
	if q, ok := pe.quotas[key]; ok {
		eta.Window5hPct = q.Window5hPct
		eta.Window5hResetIn = q.Window5hResetIn
	}

	// 3. Hourly fatigue
	cutoff := now.Add(-1 * time.Hour)
	count := 0
	for _, r := range pe.activity[key] {
		if r.Timestamp.After(cutoff) {
			count++
		}
	}
	maxReqs := pe.config.MaxReqsPerHour
	if maxReqs <= 0 {
		maxReqs = 80
	}
	eta.FatiguePct = (float64(count) / float64(maxReqs)) * 100.0

	// 4. Compute human-readable recovery label
	switch {
	case eta.IsCooling && eta.CoolingSeconds > 0:
		mins := (eta.CoolingSeconds + 59) / 60
		eta.EstimatedETAStr = fmt.Sprintf("Enfriando: recupera en ~%d min", mins)
	case eta.Window5hResetIn > 0 && eta.Window5hPct < 20.0:
		mins := (eta.Window5hResetIn + 59) / 60
		eta.EstimatedETAStr = fmt.Sprintf("Cuota 5h baja: refresca en ~%d min", mins)
	case eta.FatiguePct >= 80.0:
		eta.EstimatedETAStr = "Fatiga RPM alta: micro-pacing activo"
	default:
		eta.EstimatedETAStr = "Óptima (Zona Verde)"
	}

	return eta
}

// GetAllRecoveryETAs computes recovery estimates for all tracked accounts.
func (pe *PredictiveEngine) GetAllRecoveryETAs() []AccountRecoveryETA {
	pe.mu.RLock()
	allKeys := make(map[string]struct{})
	for k := range pe.activity {
		allKeys[k] = struct{}{}
	}
	for k := range pe.cooling {
		allKeys[k] = struct{}{}
	}
	for k := range pe.quotas {
		allKeys[k] = struct{}{}
	}
	pe.mu.RUnlock()

	var result []AccountRecoveryETA
	for k := range allKeys {
		result = append(result, pe.GetAccountRecoveryETA(k))
	}
	return result
}
func (pe *PredictiveEngine) GetConfig() PredictiveConfig {
	pe.mu.RLock()
	defer pe.mu.RUnlock()
	return pe.config
}

// SetConfig actualiza la configuración
func (pe *PredictiveEngine) SetConfig(cfg PredictiveConfig) {
	pe.mu.Lock()
	defer pe.mu.Unlock()
	if cfg.MaxReqsPerHour <= 0 {
		cfg.MaxReqsPerHour = 80
	}
	if cfg.ThresholdPct <= 0 || cfg.ThresholdPct > 100 {
		cfg.ThresholdPct = 80.0
	}
	if cfg.CoolingMinutes <= 0 {
		cfg.CoolingMinutes = 15
	}
	pe.config = cfg
}

// RecordActivity registra una llamada procesada por una cuenta
func (pe *PredictiveEngine) RecordActivity(accountEmail string) {
	if accountEmail == "" {
		return
	}
	key := normalizeAccountKey(accountEmail)
	pe.mu.Lock()
	defer pe.mu.Unlock()

	now := time.Now()
	pe.activity[key] = append(pe.activity[key], RequestRecord{Timestamp: now})
	if pe.lastActivity == nil {
		pe.lastActivity = make(map[string]time.Time)
	}
	pe.lastActivity[key] = now

	// Limpiar registros mayores a 1 hora
	cutoff := now.Add(-1 * time.Hour)
	valid := make([]RequestRecord, 0, len(pe.activity[key]))
	for _, r := range pe.activity[key] {
		if r.Timestamp.After(cutoff) {
			valid = append(valid, r)
		}
	}
	pe.activity[key] = valid

	// Registrar actividad para métricas de fatiga en la última hora.
	// NOTA (Prompt Caching & Anti-Flapping): La acumulación de requests por hora
	// registra volumen y fatiga únicamente. NO se asigna cooldown automático por conteo
	// para no destruir el Prompt Cache de Google cuando la cuota viva sigue alta.
	// Los enfriamientos (cooldowns) quedan restringidos a eventos reactivos explícitos
	// (HTTP 429, caídas de socket) mediante SetCooldown o agotamiento de cuota viva (<20% / <15%).

	// Persistir salud y actividad en SQLite
	var coolUntilMs int64
	if c, ok := pe.cooling[key]; ok && c.After(now) {
		coolUntilMs = c.UnixMilli()
	}
	w5h, weekly := 100.0, 100.0
	if q, ok := pe.quotas[key]; ok {
		w5h = q.Window5hPct
		weekly = q.WeeklyPct
	}
	analytics.SaveAccountHealth(analytics.AccountHealth{
		AccountKey:     key,
		Email:          accountEmail,
		CoolUntilMs:    coolUntilMs,
		HourlyReqCount: len(valid),
		HealthScore:    100.0,
		Window5hPct:    w5h,
		WeeklyPct:      weekly,
		LastUsedMs:     now.UnixMilli(),
		UpdatedAtMs:    now.UnixMilli(),
	})
}

// RecordLiveQuota actualiza la telemetría viva de cuotas obtenida de Antigravity
func (pe *PredictiveEngine) RecordLiveQuota(telemetry AccountQuotaTelemetry) {
	if telemetry.AccountKey == "" {
		return
	}
	key := normalizeAccountKey(telemetry.AccountKey)
	fam := normalizeFamily(telemetry.Family)
	telemetry.Family = fam
	compKey := compositeQuotaKey(key, fam)

	pe.mu.Lock()
	defer pe.mu.Unlock()

	if pe.quotas == nil {
		pe.quotas = make(map[string]AccountQuotaTelemetry)
	}
	if telemetry.UpdatedAt.IsZero() {
		telemetry.UpdatedAt = time.Now()
	}
	telemetry.AccountKey = key

	// 1. Guardar con clave compuesta aislada por familia
	pe.quotas[compKey] = telemetry

	// 2. Mantener clave base retrocompatible si no existe o si es la familia por defecto (gemini)
	if _, exists := pe.quotas[key]; !exists || fam == "gemini" {
		pe.quotas[key] = telemetry
	}

	var coolUntilMs int64
	if c, ok := pe.cooling[key]; ok && c.After(time.Now()) {
		coolUntilMs = c.UnixMilli()
	}
	analytics.SaveAccountHealth(analytics.AccountHealth{
		AccountKey:  key,
		Email:       telemetry.AccountKey,
		CoolUntilMs: coolUntilMs,
		Window5hPct: telemetry.Window5hPct,
		WeeklyPct:   telemetry.WeeklyPct,
		UpdatedAtMs: telemetry.UpdatedAt.UnixMilli(),
	})
}

// GetLiveQuota obtiene la telemetría viva de cuotas para una cuenta y familia opcional.
// Si se especifica familia ("gemini", "claude", etc.), busca primero la cuota exacta de esa familia.
func (pe *PredictiveEngine) GetLiveQuota(accountKey string, family ...string) (AccountQuotaTelemetry, bool) {
	pe.mu.RLock()
	defer pe.mu.RUnlock()

	if pe.quotas == nil {
		return AccountQuotaTelemetry{}, false
	}
	key := normalizeAccountKey(accountKey)

	// Si se solicita una familia específica, buscar la clave compuesta
	if len(family) > 0 && strings.TrimSpace(family[0]) != "" {
		fam := normalizeFamily(family[0])
		compKey := compositeQuotaKey(key, fam)
		if q, ok := pe.quotas[compKey]; ok {
			return q, true
		}
	}

	// Fallback a clave base o búsqueda por defecto
	q, ok := pe.quotas[key]
	return q, ok
}

// GetAllLiveQuotas devuelve la lista completa de cuotas registradas
func (pe *PredictiveEngine) GetAllLiveQuotas() []AccountQuotaTelemetry {
	pe.mu.RLock()
	defer pe.mu.RUnlock()

	list := make([]AccountQuotaTelemetry, 0, len(pe.quotas))
	for _, q := range pe.quotas {
		list = append(list, q)
	}
	return list
}

// SetCooldown establece explícitamente un periodo de enfriamiento para una cuenta
// a causa de un evento reactivo (HTTP 429, error de cuota o desconexión abrupta).
func (pe *PredictiveEngine) SetCooldown(accountEmail string, duration time.Duration) {
	if accountEmail == "" {
		return
	}
	key := normalizeAccountKey(accountEmail)
	pe.mu.Lock()
	defer pe.mu.Unlock()

	now := time.Now()
	coolUntil := now.Add(duration)
	pe.cooling[key] = coolUntil

	w5h, weekly := 100.0, 100.0
	if q, ok := pe.quotas[key]; ok {
		w5h = q.Window5hPct
		weekly = q.WeeklyPct
	}
	analytics.SaveAccountHealth(analytics.AccountHealth{
		AccountKey:  key,
		Email:       accountEmail,
		CoolUntilMs: coolUntil.UnixMilli(),
		HealthScore: 0.0,
		Window5hPct: w5h,
		WeeklyPct:   weekly,
		LastUsedMs:  now.UnixMilli(),
		UpdatedAtMs: now.UnixMilli(),
	})
}

// ShouldPreventiveCool indica si la cuenta debe descansar preventivamente para evitar un 429.
// Mantiene al líder sticky mientras su cuota viva sea segura (>= 20% en 5h y >= 15% semanal).
func (pe *PredictiveEngine) ShouldPreventiveCool(accountEmail string, family ...string) bool {
	return pe.ShouldPreventiveCoolSticky(accountEmail, false, family...)
}

// ShouldPreventiveCoolSticky evalúa si la cuenta debe descansar preventivamente, aplicando
// histéresis dinámica basada en el estado de afinidad de sesión (CacheSticky).
// Si isCacheSticky es true (sesión activa multiturno con historial en los últimos 5 minutos):
// - El piso de cuota en 5h se relaja del 20.0% al 10.0% (y semanal del 15.0% al 8.0%).
// - El umbral de fatiga por requests se estira al 95% (en vez del 80%).
// Esto evita la destrucción del Prompt Cache caliente (evitando recargo de 12.5x en tokens y saltos de TTFT).
// Si la cuenta tiene un cooldown activo (por 429 previo) o cae por debajo del 10%, el enfriamiento es obligatorio.
func (pe *PredictiveEngine) ShouldPreventiveCoolSticky(accountEmail string, isCacheSticky bool, family ...string) bool {
	pe.mu.RLock()
	defer pe.mu.RUnlock()

	if !pe.config.Enabled || accountEmail == "" {
		return false
	}

	key := normalizeAccountKey(accountEmail)

	// 1. ¿Está en período de enfriamiento activo (por 429 o caída previa)?
	if coolUntil, ok := pe.cooling[key]; ok {
		if time.Now().Before(coolUntil) {
			return true
		}
	}

	// Dynamic Hysteresis Floors:
	floor5h := 20.0
	floorWeekly := 15.0
	thresholdMultiplier := 1.0
	if isCacheSticky {
		floor5h = 10.0
		floorWeekly = 8.0
		thresholdMultiplier = 1.1875 // 80% * 1.1875 = 95% de fatiga permitida

		// Velocity-Aware Protection against Leader Starvation (Cliff Exhaustion):
		// Si la cuenta experimenta una ráfaga masiva de actividad (>=85% de su cuota horaria)
		// y su cuota ya está en zona de advertencia (<15%), elevar el piso a 15% para
		// provocar un traspaso suave a la reserva antes de que caiga bruscamente al 0%.
		if pe.config.MaxReqsPerHour > 0 {
			now := time.Now()
			cutoff := now.Add(-1 * time.Hour)
			recentReqs := 0
			for _, r := range pe.activity[key] {
				if r.Timestamp.After(cutoff) {
					recentReqs++
				}
			}
			velocityPct := (float64(recentReqs) / float64(pe.config.MaxReqsPerHour)) * 100.0
			if velocityPct >= 85.0 {
				floor5h = 15.0
				floorWeekly = 12.0
			}
		}
	}

	// 2. ¿Tiene agotamiento crítico de cuota viva?
	if pe.quotas != nil {
		var q AccountQuotaTelemetry
		var hasQ bool
		if len(family) > 0 && strings.TrimSpace(family[0]) != "" {
			fam := normalizeFamily(family[0])
			compKey := compositeQuotaKey(key, fam)
			q, hasQ = pe.quotas[compKey]
		}
		if !hasQ {
			q, hasQ = pe.quotas[key]
		}
		if hasQ {
			if !q.UpdatedAt.IsZero() {
				// Dynamic Sticky Hysteresis: evaluar contra el piso dinámico
				if q.Window5hPct < floor5h || (q.WeeklyPct > 0 && q.WeeklyPct < floorWeekly) {
					return true
				}
				// Si tiene telemetría y está sana, no enfriar por fatiga de requests
				return false
			}
		}
	}

	// 3. Fallback: Si no hay telemetría de cuotas en RAM, evaluar fatiga por volumen de requests
	now := time.Now()
	cutoff := now.Add(-1 * time.Hour)
	count := 0
	for _, r := range pe.activity[key] {
		if r.Timestamp.After(cutoff) {
			count++
		}
	}

	effectiveThreshold := pe.config.ThresholdPct * thresholdMultiplier
	if effectiveThreshold > 98.0 {
		effectiveThreshold = 98.0
	}
	limit := float64(pe.config.MaxReqsPerHour) * (effectiveThreshold / 100.0)
	return float64(count) >= limit
}

// IsCriticalQuotaOrCooldown evalúa si la cuenta tiene cuota críticamente agotada (<15%) o cooldown activo,
// lo cual justifica una rotación inmediata sin exigir margen de histeresis para evitar un 429 fatal.
func (pe *PredictiveEngine) IsCriticalQuotaOrCooldown(accountEmail string, family ...string) bool {
	pe.mu.RLock()
	defer pe.mu.RUnlock()

	if accountEmail == "" {
		return false
	}
	key := normalizeAccountKey(accountEmail)

	// 1. ¿Está en período de enfriamiento activo?
	if coolUntil, ok := pe.cooling[key]; ok {
		if time.Now().Before(coolUntil) {
			return true
		}
	}

	// 2. ¿Tiene agotamiento crítico de cuota viva (< 15% restante en ventana de 5h o semanal)?
	if pe.quotas != nil {
		var q AccountQuotaTelemetry
		var hasQ bool
		if len(family) > 0 && strings.TrimSpace(family[0]) != "" {
			fam := normalizeFamily(family[0])
			compKey := compositeQuotaKey(key, fam)
			q, hasQ = pe.quotas[compKey]
		}
		if !hasQ {
			q, hasQ = pe.quotas[key]
		}
		if hasQ {
			if !q.UpdatedAt.IsZero() {
				if q.Window5hPct < 15.0 || (q.WeeklyPct > 0 && q.WeeklyPct < 15.0) {
					return true
				}
			}
		}
	}

	return false
}

// GetAccountStatus devuelve el porcentaje de fatiga y minutos restantes de descanso
func (pe *PredictiveEngine) GetAccountStatus(accountEmail string, family ...string) (fatiguePct float64, isCooling bool, minutesLeft int) {
	pe.mu.RLock()
	defer pe.mu.RUnlock()

	key := normalizeAccountKey(accountEmail)
	now := time.Now()
	cutoff := now.Add(-1 * time.Hour)
	count := 0
	for _, r := range pe.activity[key] {
		if r.Timestamp.After(cutoff) {
			count++
		}
	}

	maxReqs := pe.config.MaxReqsPerHour
	if maxReqs <= 0 {
		maxReqs = 80
	}
	fatiguePct = (float64(count) / float64(maxReqs)) * 100.0
	if fatiguePct > 100.0 {
		fatiguePct = 100.0
	}

	if coolUntil, ok := pe.cooling[key]; ok {
		if now.Before(coolUntil) {
			isCooling = true
			minutesLeft = int(coolUntil.Sub(now).Minutes()) + 1
		}
	}

	// Si la cuota viva está agotada (<15%), reportar como cooling preventivo si no lo estaba
	if !isCooling && pe.quotas != nil {
		var q AccountQuotaTelemetry
		var hasQ bool
		if len(family) > 0 && strings.TrimSpace(family[0]) != "" {
			fam := normalizeFamily(family[0])
			compKey := compositeQuotaKey(key, fam)
			q, hasQ = pe.quotas[compKey]
		}
		if !hasQ {
			q, hasQ = pe.quotas[key]
		}
		if hasQ {
			if (q.Window5hPct > 0 && q.Window5hPct < 15.0) || (q.WeeklyPct > 0 && q.WeeklyPct < 15.0) {
				isCooling = true
				if q.Window5hResetIn > 0 {
					minutesLeft = int(q.Window5hResetIn / 60)
				} else {
					minutesLeft = 15
				}
			}
		}
	}

	return fatiguePct, isCooling, minutesLeft
}

// GetCacheTTLSeconds calcula los segundos restantes de vida útil del Prompt Caching
// en Google Antigravity (TTL estándar de 5 minutos = 300 segundos desde la última interacción).
// Devuelve segundos restantes (0 si expiró) y si la cuenta está actualmente "caliente".
func (pe *PredictiveEngine) GetCacheTTLSeconds(accountEmail string) (remainingSeconds int, isHot bool) {
	pe.mu.RLock()
	defer pe.mu.RUnlock()

	key := normalizeAccountKey(accountEmail)
	if pe.lastActivity == nil {
		return 0, false
	}
	last, ok := pe.lastActivity[key]
	if !ok || last.IsZero() {
		return 0, false
	}

	const cacheTTL = 300 * time.Second
	elapsed := time.Since(last)
	if elapsed >= cacheTTL {
		return 0, false
	}

	rem := int((cacheTTL - elapsed).Seconds())
	return rem, rem > 0
}

// ResetForTest clears in-memory state for clean unit test isolation.
func (pe *PredictiveEngine) ResetForTest() {
	pe.mu.Lock()
	defer pe.mu.Unlock()
	pe.activity = make(map[string][]RequestRecord)
	pe.cooling = make(map[string]time.Time)
	pe.quotas = make(map[string]AccountQuotaTelemetry)
	pe.lastActivity = make(map[string]time.Time)
}
