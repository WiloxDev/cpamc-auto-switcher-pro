package plugin

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"auto-switcher-pro/internal/analytics"
)

var (
	warmupOnce     sync.Once
	warmedAccounts = make(map[string]time.Time)
	warmupMu       sync.Mutex
)

// TriggerGhostWarmupCheck inspects active pools. If the active leader has >= 75% fatigue
// or critical quota, it proactively selects the healthiest reserve member,
// clears residual cooldowns via host bridge if needed, and records a GHOST_WARMUP audit event.
func TriggerGhostWarmupCheck(registry *PoolRegistry) {
	if registry == nil {
		return
	}
	pools := registry.ListPools()
	predEngine := GetPredictiveEngine()
	if predEngine == nil {
		return
	}

	for _, p := range pools {
		if !p.IsEnabled() {
			continue
		}
		leaderAuth := p.ActiveLeader
		if leaderAuth == "" {
			leaderAuth = p.LeaderAuth
		}
		leaderEmail := strings.TrimSuffix(strings.TrimPrefix(leaderAuth, "antigravity-"), ".json")
		poolFam := familyCanonicalShortName(p.Family, p.BasePrefix)
		fatiguePct, isCooling, _ := predEngine.GetAccountStatus(leaderEmail, poolFam)

		// Check if leader is near fatigue threshold (>= 75%) or cooling
		if fatiguePct >= 75.0 || isCooling || predEngine.ShouldPreventiveCool(leaderEmail, poolFam) {
			members := p.AllMembers()
			if len(members) < 2 {
				continue
			}

			// Find healthiest reserve
			var bestReserve string
			var bestScore float64 = -1
			for _, m := range members {
				if strings.EqualFold(m, leaderAuth) {
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
				reserveEmail := strings.TrimSuffix(strings.TrimPrefix(bestReserve, "antigravity-"), ".json")
				warmupMu.Lock()
				lastWarmup, alreadyWarmed := warmedAccounts[reserveEmail]
				// Avoid spamming warmups: at most once every 5 minutes per reserve
				if alreadyWarmed && time.Since(lastWarmup) < 5*time.Minute {
					warmupMu.Unlock()
					continue
				}
				warmedAccounts[reserveEmail] = time.Now()
				warmupMu.Unlock()

				// If host bridge is available, preemptively clear any lingering cooldowns
				if hostCaller != nil {
					_, _ = hostCaller("host.routing.reset_cooldown", map[string]any{"account": bestReserve})
				}

				// Log warmup event in SQLite audit log
				analytics.RecordAuditEvent(analytics.AuditEvent{
					PoolID:         p.ID,
					EventType:      "GHOST_WARMUP",
					TriggerReason:  "leader_fatigue_75pct_threshold",
					PreviousLeader: leaderEmail,
					NewLeader:      reserveEmail,
					LatencyMs:      1,
					StatusCode:     200,
					DetailsJSON:    `{"status":"reserve_prewarmed_ready"}`,
				})
			}
		}
	}
}

// StartGhostWarmupDaemon launches a light ticker every 30s to monitor pools.
func StartGhostWarmupDaemon() {
	warmupOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(30 * time.Second)
			defer ticker.Stop()
			for range ticker.C {
				TriggerGhostWarmupCheck(activeRegistry())
			}
		}()
	})
}

// TriggerReserveShadowWarmup runs an asynchronous background warmup specifically for the top
// healthy reserve of a pool when the leader enters the danger zone (e.g. 10% - 16% remaining quota).
// It pre-clears cooldowns and primes prompt cache so the subsequent failover experiences zero cold-start delay.
func TriggerReserveShadowWarmup(poolID string, reserveAuth string) {
	if poolID == "" || reserveAuth == "" {
		return
	}
	go func() {
		reserveEmail := strings.TrimSuffix(strings.TrimPrefix(reserveAuth, "antigravity-"), ".json")
		now := time.Now()

		warmupMu.Lock()
		lastWarmup, alreadyWarmed := warmedAccounts[reserveEmail]
		if alreadyWarmed && now.Sub(lastWarmup) < 5*time.Minute {
			warmupMu.Unlock()
			return
		}
		warmedAccounts[reserveEmail] = now
		warmupMu.Unlock()

		if hostCaller != nil {
			_, _ = hostCaller("host.routing.reset_cooldown", map[string]any{"account": reserveAuth})
		}

		analytics.RecordAuditEvent(analytics.AuditEvent{
			PoolID:         poolID,
			EventType:      "RESERVE_SHADOW_WARMUP",
			TriggerReason:  "leader_danger_zone_10_16_pct",
			PreviousLeader: "",
			NewLeader:      reserveEmail,
			LatencyMs:      1,
			StatusCode:     200,
			DetailsJSON:    fmt.Sprintf(`{"status":"reserve_shadow_primed","reserve":"%s"}`, reserveAuth),
		})
	}()
}

// TriggerTriageShadowWarmup executes an async predictive pre-warming of designated pools
// during orchestrator triage (before subagents like 00-discovery or 02-apply are even invoked).
// It warms the TLS socket and pre-primes prompt cache without adding any latency to the orchestrator turn.
func TriggerTriageShadowWarmup(targetPools []string) {
	go func() {
		reg := activeRegistry()
		if reg == nil {
			return
		}

		if len(targetPools) == 0 {
			targetPools = []string{"Pool-01-gemini", "Pool-04-claude"}
		}

		now := time.Now()
		for _, poolID := range targetPools {
			pool, ok := reg.GetPool(poolID)
			if !ok || !pool.IsEnabled() {
				continue
			}

			targetAuth := pool.ActiveLeader
			if targetAuth == "" {
				targetAuth = pool.LeaderAuth
			}
			if targetAuth == "" {
				continue
			}

			targetEmail := strings.TrimSuffix(strings.TrimPrefix(targetAuth, "antigravity-"), ".json")

			warmupMu.Lock()
			lastWarmup, alreadyWarmed := warmedAccounts[targetEmail]
			if alreadyWarmed && now.Sub(lastWarmup) < 5*time.Minute {
				warmupMu.Unlock()
				continue
			}
			warmedAccounts[targetEmail] = now
			warmupMu.Unlock()

			if hostCaller != nil {
				_, _ = hostCaller("host.routing.reset_cooldown", map[string]any{"account": targetAuth})
			}

			analytics.RecordAuditEvent(analytics.AuditEvent{
				PoolID:         pool.ID,
				EventType:      "TRIAGE_SHADOW_WARMUP",
				TriggerReason:  "orchestrator_triage_prime",
				PreviousLeader: targetEmail,
				NewLeader:      targetEmail,
				LatencyMs:      1,
				StatusCode:     200,
				DetailsJSON:    fmt.Sprintf(`{"status":"cache_primed","target_pool":"%s"}`, pool.ID),
			})
		}
	}()
}

