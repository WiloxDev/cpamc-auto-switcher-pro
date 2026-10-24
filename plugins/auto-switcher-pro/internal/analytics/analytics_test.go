package analytics

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSQLiteAnalyticsLifecycle(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "analytics-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	db, err := ResetDBForTest(filepath.Join(tempDir, "test_rotations.db"))
	if err != nil {
		t.Fatalf("ResetDBForTest failed: %v", err)
	}
	if db == nil {
		t.Fatal("expected non-nil db instance")
	}

	// 1. Insert test events
	now := time.Now().UnixMilli()
	RecordEvent(RotationEvent{
		Timestamp:       now - 1000,
		PoolID:          "Pool-01-gemini",
		PoolPrefix:      "agy",
		SelectedAccount: "antigravity-leader@gmail.com.json",
		AccountEmail:    "leader@gmail.com",
		IsFailover:      false,
		CascadeIndex:    0,
		TargetModel:     "gemini-3.8-flash-high",
	})

	RecordEvent(RotationEvent{
		Timestamp:       now,
		PoolID:          "Pool-01-gemini",
		PoolPrefix:      "agy",
		SelectedAccount: "antigravity-reserve@gmail.com.json",
		AccountEmail:    "reserve@gmail.com",
		IsFailover:      true,
		CascadeIndex:    1,
		TargetModel:     "gemini-3.8-flash-high",
	})

	// Wait for worker queue to flush to SQLite
	time.Sleep(150 * time.Millisecond)

	// 2. Query metrics
	snap, err := QueryMetrics("24h")
	if err != nil {
		t.Fatalf("QueryMetrics failed: %v", err)
	}

	if snap.Totals.TotalRequests != 2 {
		t.Errorf("expected 2 total requests, got %d", snap.Totals.TotalRequests)
	}
	if snap.Totals.LeaderRequests != 1 {
		t.Errorf("expected 1 leader request, got %d", snap.Totals.LeaderRequests)
	}
	if snap.Totals.FailoverRescues != 1 {
		t.Errorf("expected 1 failover rescue, got %d", snap.Totals.FailoverRescues)
	}
	if snap.Totals.FailoverRatePct != 50.0 {
		t.Errorf("expected 50%% failover rate, got %f", snap.Totals.FailoverRatePct)
	}
	if len(snap.Pools) != 1 || snap.Pools[0].PoolID != "Pool-01-gemini" {
		t.Errorf("expected pool 'Pool-01-gemini' in aggregates, got %v", snap.Pools)
	}
	if len(snap.Accounts) != 2 {
		t.Errorf("expected 2 accounts in aggregates, got %d", len(snap.Accounts))
	}

	// 3. Test Account Health persistence
	coolUntil := now + (15 * 60 * 1000)
	SaveAccountHealth(AccountHealth{
		AccountKey:  "leader@gmail.com",
		Email:       "leader@gmail.com",
		CoolUntilMs: coolUntil,
		HealthScore: 95.5,
		Window5hPct: 82.0,
		WeeklyPct:   90.0,
	})

	// 4. Test Session Affinity (Prompt Cache stickiness)
	SetSessionAffinity(SessionAffinity{
		SessionID:    "session-xyz-123",
		PoolID:       "Pool-01-gemini",
		AccountEmail: "leader@gmail.com",
		LastTurnMs:   now,
	})

	// 5. Test Audit Event logging
	RecordAuditEvent(AuditEvent{
		PoolID:         "Pool-01-gemini",
		EventType:      "PREVENTIVE",
		TriggerReason:  "hourly_threshold_exceeded",
		PreviousLeader: "leader@gmail.com",
		NewLeader:      "reserve@gmail.com",
		LatencyMs:      12,
		StatusCode:     200,
	})

	// 6. Test Flight Recorder incident capture
	RecordFlightEvent(FlightRecorderEvent{
		AccountEmail: "reserve@gmail.com",
		PoolID:       "Pool-01-gemini",
		ErrorKind:    "RATE_LIMIT_429",
		StatusCode:   429,
		ErrorMessage: "Resource has been exhausted",
		LatencyMs:    450,
	})

	// 7. Test Agent Profile assignments (Universal Matrix)
	err = UpsertAgentProfile(AgentProfileRecord{
		Universe:      "gentle_ai",
		AgentID:       "orchestrator",
		PrimaryPool:   "Pool-04-claude",
		FallbackPool:  "Pool-01-gemini",
		ThinkingLevel: "high",
		Concurrency:   1,
	})
	if err != nil {
		t.Fatalf("UpsertAgentProfile failed: %v", err)
	}

	err = UpsertAgentProfile(AgentProfileRecord{
		Universe:      "jok3r_pi",
		AgentID:       "02-apply",
		PrimaryPool:   "Pool-04-claude",
		FallbackPool:  "Pool-02-gemini",
		ThinkingLevel: "medium",
		Concurrency:   1,
	})
	if err != nil {
		t.Fatalf("UpsertAgentProfile failed: %v", err)
	}

	profilesGentle, err := GetAgentProfiles("gentle_ai")
	if err != nil || len(profilesGentle) != 1 || profilesGentle[0].PrimaryPool != "Pool-04-claude" {
		t.Fatalf("expected 1 gentle_ai profile with Pool-04-claude, got: %+v (err: %v)", profilesGentle, err)
	}

	allProfiles, err := GetAgentProfiles("")
	if err != nil || len(allProfiles) != 2 {
		t.Fatalf("expected 2 total profiles, got: %+v (err: %v)", allProfiles, err)
	}

	// Wait for worker queue to flush
	time.Sleep(150 * time.Millisecond)

	// Validate Account Health
	healthMap, err := GetAllAccountHealth()
	if err != nil {
		t.Fatalf("GetAllAccountHealth failed: %v", err)
	}
	h, ok := healthMap["leader@gmail.com"]
	if !ok || h.CoolUntilMs != coolUntil || h.HealthScore != 95.5 {
		t.Errorf("expected saved health with coolUntil=%d score=95.5, got %+v", coolUntil, h)
	}

	// Validate partial update does not corrupt pre-existing metrics
	newCoolUntil := coolUntil + 5000
	SaveAccountHealth(AccountHealth{
		AccountKey:  "leader@gmail.com",
		Email:       "leader@gmail.com",
		CoolUntilMs: newCoolUntil,
		HealthScore: 0.0, // must not overwrite 95.5
		Window5hPct: 0.0, // must not overwrite 82.0
		WeeklyPct:   0.0, // must not overwrite 90.0
	})
	FlushWriteQueueForTest()
	healthMapAfter, err := GetAllAccountHealth()
	if err != nil {
		t.Fatalf("GetAllAccountHealth after partial update failed: %v", err)
	}
	hAfter := healthMapAfter["leader@gmail.com"]
	if hAfter.CoolUntilMs != newCoolUntil {
		t.Errorf("expected updated coolUntil=%d, got %d", newCoolUntil, hAfter.CoolUntilMs)
	}
	if hAfter.HealthScore != 95.5 || hAfter.Window5hPct != 82.0 || hAfter.WeeklyPct != 90.0 {
		t.Errorf("metrics were corrupted by partial update: %+v", hAfter)
	}

	// Validate Session Affinity
	aff, ok := GetSessionAffinity("session-xyz-123", "Pool-01-gemini")
	if !ok || aff.AccountEmail != "leader@gmail.com" {
		t.Errorf("expected valid session affinity for leader@gmail.com, got %+v (ok=%v)", aff, ok)
	}
	if aff.TurnCount < 1 {
		t.Errorf("expected TurnCount >= 1, got %d", aff.TurnCount)
	}

	// Trigger second turn for same session to verify turn_count increment
	SetSessionAffinity(SessionAffinity{
		SessionID:    "session-xyz-123",
		PoolID:       "Pool-01-gemini",
		AccountEmail: "leader@gmail.com",
		LastTurnMs:   time.Now().UnixMilli(),
	})
	time.Sleep(50 * time.Millisecond)
	affTurn2, ok := GetSessionAffinity("session-xyz-123", "Pool-01-gemini")
	if !ok || affTurn2.TurnCount < 2 {
		t.Errorf("expected TurnCount >= 2 after second turn, got %d", affTurn2.TurnCount)
	}

	// Validate Audit Events
	audits, err := QueryAuditEvents(10)
	if err != nil || len(audits) == 0 {
		t.Fatalf("QueryAuditEvents failed or empty: %v", err)
	}
	if audits[0].EventType != "PREVENTIVE" || audits[0].NewLeader != "reserve@gmail.com" {
		t.Errorf("unexpected audit event: %+v", audits[0])
	}

	// Validate Flight Recorder
	flights, err := QueryFlightEvents(10)
	if err != nil || len(flights) == 0 {
		t.Fatalf("QueryFlightEvents failed or empty: %v", err)
	}
	if flights[0].ErrorKind != "RATE_LIMIT_429" || flights[0].StatusCode != 429 {
		t.Errorf("unexpected flight event: %+v", flights[0])
	}

	// 7. Test AutoVacuumCheckpoint
	// Insert an ancient event (60 days old)
	ancientTs := now - (60 * 24 * 60 * 60 * 1000)
	RecordAuditEvent(AuditEvent{
		Timestamp:      ancientTs,
		PoolID:         "Pool-01-gemini",
		EventType:      "PREVENTIVE",
		TriggerReason:  "ancient_record",
		PreviousLeader: "old@gmail.com",
		NewLeader:      "new@gmail.com",
	})
	time.Sleep(100 * time.Millisecond)

	// Run checkpoint keeping only last 30 days
	if err := AutoVacuumCheckpoint(30); err != nil {
		t.Fatalf("AutoVacuumCheckpoint failed: %v", err)
	}

	auditsAfter, err := QueryAuditEvents(100)
	if err != nil {
		t.Fatalf("QueryAuditEvents after checkpoint failed: %v", err)
	}
	for _, a := range auditsAfter {
		if a.TriggerReason == "ancient_record" {
			t.Errorf("expected ancient_record to be purged by AutoVacuumCheckpoint")
		}
	}
}
