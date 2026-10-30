package plugin

import (
	"testing"
	"time"
)

func TestPredictiveEngine(t *testing.T) {
	pe := &PredictiveEngine{
		config: PredictiveConfig{
			Enabled:        true,
			MaxReqsPerHour: 10,
			ThresholdPct:   80.0, // 8 requests activan enfriamiento
			CoolingMinutes: 10,
		},
		activity: make(map[string][]RequestRecord),
		cooling:  make(map[string]time.Time),
	}

	acc := "test-leader@gmail.com"

	// 1. Inicialmente no debe descansar
	if pe.ShouldPreventiveCool(acc) {
		t.Fatalf("expected account not to cool down initially")
	}

	// 2. Simular 7 peticiones (70% < 80%)
	for i := 0; i < 7; i++ {
		pe.RecordActivity(acc)
	}
	if pe.ShouldPreventiveCool(acc) {
		t.Fatalf("expected account not to cool down at 70%%")
	}

	// 3. Simular la 8va petición (alcanza el 80% de fatiga, pero sin telemetría de cuota)
	pe.RecordActivity(acc)
	if !pe.ShouldPreventiveCool(acc) {
		t.Fatalf("expected account without quota telemetry to cool down at 80%% request threshold")
	}

	fatigue, _, _ := pe.GetAccountStatus(acc)
	if fatigue < 80.0 {
		t.Fatalf("expected fatigue >= 80%%, got %.2f", fatigue)
	}

	// 3b. Sticky leader hysteresis: Si la cuenta tiene cuota viva sana (>= 20% 5h y >= 15% semanal),
	// ShouldPreventiveCool DEBE devolver false a pesar de tener >80% de fatiga por requests para proteger Prompt Caching.
	pe.RecordLiveQuota(AccountQuotaTelemetry{
		AccountKey:  acc,
		Window5hPct: 90.0,
		WeeklyPct:   85.0,
		UpdatedAt:   time.Now(),
	})
	if pe.ShouldPreventiveCool(acc) {
		t.Fatalf("account with healthy live quota (90%%) must remain sticky even if request volume is high")
	}

	// 3c. SetCooldown: Si ocurre un evento reactivo (429), SetCooldown debe forzar enfriamiento
	pe.SetCooldown(acc, 15*time.Minute)
	if !pe.ShouldPreventiveCool(acc) {
		t.Fatalf("account with explicit cooldown must cool down")
	}
	_, isCooling, mins := pe.GetAccountStatus(acc)
	if !isCooling || mins <= 0 {
		t.Fatalf("expected account to be cooling with positive minutes left")
	}

	// 4. Deshabilitar motor predictivo debe saltarse la protección
	pe.SetConfig(PredictiveConfig{
		Enabled:        false,
		MaxReqsPerHour: 10,
		ThresholdPct:   80.0,
		CoolingMinutes: 10,
	})
	if pe.ShouldPreventiveCool(acc) {
		t.Fatalf("expected disabled engine to not force cooling")
	}

	// 5. Test Live Quota Telemetry Ingestion & Exhaustion Protection
	pe.SetConfig(PredictiveConfig{
		Enabled:        true,
		MaxReqsPerHour: 80,
		ThresholdPct:   80.0,
		CoolingMinutes: 15,
	})
	quotaAcc := "quota-user@gmail.com"
	pe.RecordLiveQuota(AccountQuotaTelemetry{
		AccountKey:      quotaAcc,
		Window5hPct:     100.0,
		WeeklyPct:       95.0,
		Window5hResetIn: 14400,
		Plan:            "Pro",
	})
	q, ok := pe.GetLiveQuota(quotaAcc)
	if !ok || q.Window5hPct != 100.0 {
		t.Fatalf("expected live quota to be stored and retrieved, got %+v", q)
	}
	if pe.ShouldPreventiveCool(quotaAcc) {
		t.Fatalf("account with 100%% quota should not cool down")
	}

	// When 5h quota is critically depleted (< 15%), it must trigger preventive cooling
	pe.RecordLiveQuota(AccountQuotaTelemetry{
		AccountKey:      quotaAcc,
		Window5hPct:     10.0, // Critical depletion (< 15%)
		WeeklyPct:       80.0,
		Window5hResetIn: 3600,
	})
	if !pe.ShouldPreventiveCool(quotaAcc) {
		t.Fatalf("account with 10%% 5h quota should trigger preventive cooling")
	}

	// Boundary condition: total exhaustion at 0.0% must also trigger preventive cooling
	pe.RecordLiveQuota(AccountQuotaTelemetry{
		AccountKey:      quotaAcc,
		Window5hPct:     0.0, // Absolute exhaustion
		WeeklyPct:       0.0,
		Window5hResetIn: 7200,
	})
	if !pe.ShouldPreventiveCool(quotaAcc) {
		t.Fatalf("account with 0%% quota must trigger preventive cooling")
	}

	// 6. Test Multi-Family Quota Isolation on the exact same account
	multiAcc := "multi-family-user@gmail.com"
	pe.RecordLiveQuota(AccountQuotaTelemetry{
		AccountKey:  multiAcc,
		Family:      "gemini",
		Window5hPct: 90.0,
		WeeklyPct:   95.0,
	})
	pe.RecordLiveQuota(AccountQuotaTelemetry{
		AccountKey:  multiAcc,
		Family:      "claude",
		Window5hPct: 10.0, // Claude exhausted on the same account
		WeeklyPct:   15.0,
	})

	// Gemini quota query must yield 90.0%
	qGem, okGem := pe.GetLiveQuota(multiAcc, "gemini")
	if !okGem || qGem.Window5hPct != 90.0 {
		t.Fatalf("expected Gemini quota 90.0, got %+v (ok: %v)", qGem, okGem)
	}

	// Claude quota query must yield 10.0%
	qClau, okClau := pe.GetLiveQuota(multiAcc, "claude")
	if !okClau || qClau.Window5hPct != 10.0 {
		t.Fatalf("expected Claude quota 10.0, got %+v (ok: %v)", qClau, okClau)
	}

	// In Claude family, account should preventive cool
	if !pe.ShouldPreventiveCool(multiAcc, "claude") {
		t.Fatalf("expected account to preventive cool under Claude")
	}

	// In Gemini family, account should NOT preventive cool because Gemini quota is 90%
	if pe.ShouldPreventiveCool(multiAcc, "gemini") {
		t.Fatalf("expected account NOT to cool under Gemini when Gemini has 90%% quota")
	}

	// 7. Test Cache-Aware Dynamic Hysteresis (ShouldPreventiveCoolSticky)
	stickyAcc := "sticky-cache-dev@gmail.com"
	// Configurar cuenta con 16% de cuota en 5h (zona intermedia: <20% pero >=10%)
	pe.RecordLiveQuota(AccountQuotaTelemetry{
		AccountKey:  stickyAcc,
		Window5hPct: 16.0,
		WeeklyPct:   50.0,
		UpdatedAt:   time.Now(),
	})

	// En modo normal (sin sticky / primera llamada de sesión): debe enfriar (<20%)
	if !pe.ShouldPreventiveCool(stickyAcc) {
		t.Fatalf("normal mode must cool account with 16%% quota (<20%% normal floor)")
	}

	// En modo CacheSticky: NO debe enfriar (piso relajado a 10% para salvar Prompt Cache)
	if pe.ShouldPreventiveCoolSticky(stickyAcc, true) {
		t.Fatalf("cache-sticky mode must NOT cool account with 16%% quota (floor is 10%%)")
	}

	// Si cae por debajo del 10% (ej. 8%): DEBE enfriar incluso en modo sticky para evitar un 429 inevitable
	pe.RecordLiveQuota(AccountQuotaTelemetry{
		AccountKey:  stickyAcc,
		Window5hPct: 8.0,
		WeeklyPct:   50.0,
		UpdatedAt:   time.Now(),
	})
	if !pe.ShouldPreventiveCoolSticky(stickyAcc, true) {
		t.Fatalf("cache-sticky mode MUST cool account when quota drops below 10%% critical floor")
	}

	// Cooldown explícito (429 previo) DEBE enfriar siempre, incluso con isCacheSticky=true
	pe.RecordLiveQuota(AccountQuotaTelemetry{
		AccountKey:  stickyAcc,
		Window5hPct: 80.0,
		WeeklyPct:   80.0,
		UpdatedAt:   time.Now(),
	})
	pe.SetCooldown(stickyAcc, 10*time.Minute)
	if !pe.ShouldPreventiveCoolSticky(stickyAcc, true) {
		t.Fatalf("explicit cooldown must always trigger cooling even in cache-sticky mode")
	}

	// 8. Test Velocity-Aware Floor Protection against Leader Starvation (Cliff Exhaustion)
	// Si la cuenta tiene cuota baja (12% en 5h) pero velocidad de consumo extrema (>85% límite horario),
	// el piso de cuota debe elevarse dinámicamente a 15% para evitar que caiga al 0% de golpe en mitad de stream.
	pe.SetConfig(PredictiveConfig{
		Enabled:        true,
		MaxReqsPerHour: 10,
		ThresholdPct:   80.0,
		CoolingMinutes: 10,
	})
	velocityAcc := "velocity-starve-test@gmail.com"
	pe.RecordLiveQuota(AccountQuotaTelemetry{
		AccountKey:  velocityAcc,
		Window5hPct: 12.0, // Zona 10-15%
		WeeklyPct:   60.0,
		UpdatedAt:   time.Now(),
	})

	// Con baja velocidad (0 requests en la hora): Se permite sticky a 12% (piso 10%)
	if pe.ShouldPreventiveCoolSticky(velocityAcc, true) {
		t.Fatalf("low velocity sticky account with 12%% quota should remain sticky")
	}

	// Simular ráfaga extrema de 9 peticiones sobre un límite de 10 (90% de velocidad horaria)
	for i := 0; i < 9; i++ {
		pe.RecordActivity(velocityAcc)
	}

	// Ahora, con 90% de velocidad y 12% de cuota, DEBE enfriar preventivamente para proteger la sesión
	// contra el colapso brusco al 0% (Leader Starvation protection)
	if !pe.ShouldPreventiveCoolSticky(velocityAcc, true) {
		t.Fatalf("high velocity (>85%%) sticky account with 12%% quota MUST trigger preventive cooling to avoid cliff drop to 0%%")
	}
}
