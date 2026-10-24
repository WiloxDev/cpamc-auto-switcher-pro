package analytics

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	_ "modernc.org/sqlite"
)

var (
	dbInstance *sql.DB
	dbOnce     sync.Once
	dbPath     string
	dbMu       sync.RWMutex
)

// resolveDBPath locates the writable storage directory for rotations.db.
func resolveDBPath() string {
	candidates := []string{
		"/CLIProxyAPI/plugins/rotations.db",
		filepath.Join(os.Getenv("HOME"), "services/cliproxy/plugins/rotations.db"),
		filepath.Join(os.Getenv("HOME"), ".local/share/auto-switcher-pro/rotations.db"),
		"./rotations.db",
	}
	for _, p := range candidates {
		dir := filepath.Dir(p)
		if fi, err := os.Stat(dir); err == nil && fi.IsDir() {
			return p
		}
	}
	return "./rotations.db"
}

// ResetDBForTest resets the singleton instance and directs storage to tPath.
func ResetDBForTest(tPath string) (*sql.DB, error) {
	dbMu.Lock()
	defer dbMu.Unlock()
	if dbInstance != nil {
		_ = dbInstance.Close()
		dbInstance = nil
	}
	dbPath = tPath
	dbOnce = sync.Once{}
	return InitDB()
}

// InitDB initializes SQLite in WAL mode and creates required tables.
func InitDB() (*sql.DB, error) {
	var initErr error
	dbOnce.Do(func() {
		if dbPath == "" {
			dbPath = resolveDBPath()
		}
		_ = os.MkdirAll(filepath.Dir(dbPath), 0755)

		dsn := fmt.Sprintf("%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)", dbPath)
		db, err := sql.Open("sqlite", dsn)
		if err != nil {
			initErr = err
			return
		}

		db.SetMaxOpenConns(5)
		db.SetMaxIdleConns(2)
		db.SetConnMaxLifetime(time.Hour)

		schema := `
		CREATE TABLE IF NOT EXISTS pool_rotations (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			timestamp INTEGER NOT NULL,
			pool_id TEXT DEFAULT '',
			pool_prefix TEXT NOT NULL,
			selected_account TEXT NOT NULL,
			account_email TEXT NOT NULL,
			is_failover INTEGER NOT NULL,
			cascade_index INTEGER NOT NULL,
			target_model TEXT NOT NULL,
			status_code INTEGER DEFAULT 200
		);
		CREATE INDEX IF NOT EXISTS idx_rotations_ts ON pool_rotations(timestamp);
		CREATE INDEX IF NOT EXISTS idx_rotations_pool ON pool_rotations(pool_prefix);
		CREATE INDEX IF NOT EXISTS idx_rotations_account ON pool_rotations(account_email);

		CREATE TABLE IF NOT EXISTS account_health (
			account_key TEXT PRIMARY KEY,
			email TEXT NOT NULL,
			cool_until_ms INTEGER DEFAULT 0,
			hourly_req_count INTEGER DEFAULT 0,
			consecutive_errors INTEGER DEFAULT 0,
			health_score REAL DEFAULT 100.0,
			window_5h_pct REAL DEFAULT 100.0,
			weekly_pct REAL DEFAULT 100.0,
			last_used_ms INTEGER DEFAULT 0,
			updated_at_ms INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_account_health_updated ON account_health(updated_at_ms);

		CREATE TABLE IF NOT EXISTS session_affinity (
			session_id TEXT NOT NULL,
			pool_id TEXT NOT NULL,
			account_email TEXT NOT NULL,
			turn_count INTEGER DEFAULT 1,
			last_turn_ms INTEGER NOT NULL,
			PRIMARY KEY (session_id, pool_id)
		);
		CREATE INDEX IF NOT EXISTS idx_session_affinity_last ON session_affinity(last_turn_ms);

		CREATE TABLE IF NOT EXISTS audit_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			timestamp INTEGER NOT NULL,
			pool_id TEXT NOT NULL,
			event_type TEXT NOT NULL,
			trigger_reason TEXT NOT NULL,
			previous_leader TEXT,
			new_leader TEXT,
			latency_ms INTEGER DEFAULT 0,
			status_code INTEGER DEFAULT 200,
			details_json TEXT DEFAULT '{}'
		);
		CREATE INDEX IF NOT EXISTS idx_audit_events_ts ON audit_events(timestamp);
		CREATE INDEX IF NOT EXISTS idx_audit_events_pool ON audit_events(pool_id);

		CREATE TABLE IF NOT EXISTS flight_recorder (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			timestamp INTEGER NOT NULL,
			account_email TEXT NOT NULL,
			pool_id TEXT NOT NULL,
			error_kind TEXT NOT NULL,
			status_code INTEGER DEFAULT 0,
			error_message TEXT NOT NULL,
			headers_snapshot TEXT DEFAULT '',
			latency_ms INTEGER DEFAULT 0,
			quota_snapshot_json TEXT DEFAULT '{}'
		);
		CREATE INDEX IF NOT EXISTS idx_flight_recorder_ts ON flight_recorder(timestamp);
		CREATE INDEX IF NOT EXISTS idx_flight_recorder_acc ON flight_recorder(account_email);

		CREATE TABLE IF NOT EXISTS agent_profiles (
			universe TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			primary_pool TEXT NOT NULL,
			fallback_pool TEXT NOT NULL,
			thinking_level TEXT DEFAULT 'medium',
			auto_downgrade INTEGER DEFAULT 0,
			max_claude_turns INTEGER DEFAULT 3,
			concurrency INTEGER DEFAULT 1,
			updated_at_ms INTEGER NOT NULL,
			PRIMARY KEY (universe, agent_id)
		);
		CREATE INDEX IF NOT EXISTS idx_agent_profiles_univ ON agent_profiles(universe);

		CREATE TABLE IF NOT EXISTS harness_registry (
			harness_id TEXT PRIMARY KEY,
			harness_name TEXT NOT NULL,
			detected_at_ms INTEGER NOT NULL,
			last_seen_ms INTEGER NOT NULL,
			metadata_json TEXT DEFAULT '{}'
		);
		`
		if _, err := db.Exec(schema); err != nil {
			initErr = fmt.Errorf("failed to init schema: %w", err)
			return
		}
		// Non-destructive migrations
		_, _ = db.Exec(`ALTER TABLE session_affinity ADD COLUMN turn_count INTEGER DEFAULT 1;`)
		_, _ = db.Exec(`ALTER TABLE agent_profiles ADD COLUMN auto_downgrade INTEGER DEFAULT 0;`)
		_, _ = db.Exec(`ALTER TABLE agent_profiles ADD COLUMN max_claude_turns INTEGER DEFAULT 3;`)

		// Idempotent column check for existing databases
		_, _ = db.Exec(`ALTER TABLE pool_rotations ADD COLUMN pool_id TEXT DEFAULT '';`)
		_, _ = db.Exec(`CREATE INDEX IF NOT EXISTS idx_rotations_pool_id ON pool_rotations(pool_id);`)

		dbInstance = db
		initWriteWorker()
	})

	if initErr != nil {
		return nil, initErr
	}
	return dbInstance, nil
}

// ---------------------------------------------------------------------------
// Model Entities
// ---------------------------------------------------------------------------

// RotationEvent represents a single routed request event.
type RotationEvent struct {
	Timestamp       int64  `json:"timestamp"`
	PoolID          string `json:"pool_id"`
	PoolPrefix      string `json:"pool_prefix"`
	SelectedAccount string `json:"selected_account"`
	AccountEmail    string `json:"account_email"`
	IsFailover      bool   `json:"is_failover"`
	CascadeIndex    int    `json:"cascade_index"`
	TargetModel     string `json:"target_model"`
	StatusCode      int    `json:"status_code"`
}

// AccountHealth represents the persistent state and score of an account.
type AccountHealth struct {
	AccountKey        string  `json:"account_key"`
	Email             string  `json:"email"`
	CoolUntilMs       int64   `json:"cool_until_ms"`
	HourlyReqCount    int     `json:"hourly_req_count"`
	ConsecutiveErrors int     `json:"consecutive_errors"`
	HealthScore       float64 `json:"health_score"` // 0.0 - 100.0
	Window5hPct       float64 `json:"window_5h_pct"`
	WeeklyPct         float64 `json:"weekly_pct"`
	LastUsedMs        int64   `json:"last_used_ms"`
	UpdatedAtMs       int64   `json:"updated_at_ms"`
}

// SessionAffinity maps an active agent session to a pool account for Prompt Cache preservation.
type SessionAffinity struct {
	SessionID    string `json:"session_id"`
	PoolID       string `json:"pool_id"`
	AccountEmail string `json:"account_email"`
	TurnCount    int    `json:"turn_count"`
	LastTurnMs   int64  `json:"last_turn_ms"`
}

// AuditEvent represents a rotation or rebalance decision.
type AuditEvent struct {
	ID             int64  `json:"id,omitempty"`
	Timestamp      int64  `json:"timestamp"`
	PoolID         string `json:"pool_id"`
	EventType      string `json:"event_type"` // "PREVENTIVE", "FAILOVER", "REBALANCE", "STICKY_SESSION"
	TriggerReason  string `json:"trigger_reason"`
	PreviousLeader string `json:"previous_leader"`
	NewLeader      string `json:"new_leader"`
	LatencyMs      int64  `json:"latency_ms"`
	StatusCode     int    `json:"status_code"`
	DetailsJSON    string `json:"details_json"`
}

// FlightRecorderEvent represents a crash, 429, or network drop incident.
type FlightRecorderEvent struct {
	ID                int64  `json:"id,omitempty"`
	Timestamp         int64  `json:"timestamp"`
	AccountEmail      string `json:"account_email"`
	PoolID            string `json:"pool_id"`
	ErrorKind         string `json:"error_kind"`
	StatusCode        int    `json:"status_code"`
	ErrorMessage      string `json:"error_message"`
	HeadersSnapshot   string `json:"headers_snapshot"`
	LatencyMs         int64  `json:"latency_ms"`
	QuotaSnapshotJSON string `json:"quota_snapshot_json"`
}

// ---------------------------------------------------------------------------
// Asynchronous Write Worker Pool (Zero I/O Block on Request Processing)
// ---------------------------------------------------------------------------

type writeTask struct {
	kind string // "rotation", "health", "affinity", "audit", "flight", "flush"
	data any
}

var (
	writeQueue      chan writeTask
	writeQueueOnce  sync.Once
	writeWorkerDone chan struct{}
	isShuttingDown  atomic.Bool

	vacuumTicker *time.Ticker
	vacuumStopCh chan struct{}
	vacuumMu     sync.Mutex
)

func initWriteWorker() {
	writeQueueOnce.Do(func() {
		writeQueue = make(chan writeTask, 2048)
		writeWorkerDone = make(chan struct{})
		vacuumStopCh = make(chan struct{})
		go runWriteWorker()
		go startAutoVacuumDaemon()
	})
}

func enqueueWrite(task writeTask) {
	if isShuttingDown.Load() {
		return
	}
	initWriteWorker()
	select {
	case writeQueue <- task:
	default:
		// Queue saturated: drop safely to avoid memory exhaustion
	}
}

func runWriteWorker() {
	defer func() {
		if writeWorkerDone != nil {
			close(writeWorkerDone)
		}
	}()
	for task := range writeQueue {
		dbMu.RLock()
		db := dbInstance
		dbMu.RUnlock()

		if db == nil {
			var err error
			db, err = InitDB()
			if err != nil || db == nil {
				continue
			}
		}

		executeWriteTask(db, task)
	}
}

func executeWriteTask(db *sql.DB, task writeTask) {
	switch task.kind {
	case "rotation":
		evt, ok := task.data.(RotationEvent)
		if !ok {
			return
		}
		isFailoverInt := 0
		if evt.IsFailover {
			isFailoverInt = 1
		}
		stmt := `INSERT INTO pool_rotations (
			timestamp, pool_id, pool_prefix, selected_account, account_email, is_failover, cascade_index, target_model, status_code
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		_, _ = db.Exec(stmt,
			evt.Timestamp,
			evt.PoolID,
			evt.PoolPrefix,
			evt.SelectedAccount,
			evt.AccountEmail,
			isFailoverInt,
			evt.CascadeIndex,
			evt.TargetModel,
			evt.StatusCode,
		)

	case "health":
		h, ok := task.data.(AccountHealth)
		if !ok {
			return
		}
		if h.UpdatedAtMs == 0 {
			h.UpdatedAtMs = time.Now().UnixMilli()
		}
		stmt := `INSERT INTO account_health (
			account_key, email, cool_until_ms, hourly_req_count, consecutive_errors,
			health_score, window_5h_pct, weekly_pct, last_used_ms, updated_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(account_key) DO UPDATE SET
			email=CASE WHEN excluded.email != '' THEN excluded.email ELSE account_health.email END,
			cool_until_ms=excluded.cool_until_ms,
			hourly_req_count=CASE WHEN excluded.hourly_req_count > 0 THEN excluded.hourly_req_count ELSE account_health.hourly_req_count END,
			consecutive_errors=CASE WHEN excluded.consecutive_errors > 0 THEN excluded.consecutive_errors ELSE account_health.consecutive_errors END,
			health_score=CASE WHEN excluded.health_score > 0 THEN excluded.health_score ELSE account_health.health_score END,
			window_5h_pct=CASE WHEN excluded.window_5h_pct > 0 THEN excluded.window_5h_pct ELSE account_health.window_5h_pct END,
			weekly_pct=CASE WHEN excluded.weekly_pct > 0 THEN excluded.weekly_pct ELSE account_health.weekly_pct END,
			last_used_ms=CASE WHEN excluded.last_used_ms > 0 THEN excluded.last_used_ms ELSE account_health.last_used_ms END,
			updated_at_ms=excluded.updated_at_ms`
		_, _ = db.Exec(stmt,
			h.AccountKey,
			h.Email,
			h.CoolUntilMs,
			h.HourlyReqCount,
			h.ConsecutiveErrors,
			h.HealthScore,
			h.Window5hPct,
			h.WeeklyPct,
			h.LastUsedMs,
			h.UpdatedAtMs,
		)

	case "affinity":
		aff, ok := task.data.(SessionAffinity)
		if !ok {
			return
		}
		if aff.LastTurnMs == 0 {
			aff.LastTurnMs = time.Now().UnixMilli()
		}
		stmt := `INSERT INTO session_affinity (
			session_id, pool_id, account_email, turn_count, last_turn_ms
		) VALUES (?, ?, ?, 1, ?)
		ON CONFLICT(session_id, pool_id) DO UPDATE SET
			account_email=excluded.account_email,
			turn_count=session_affinity.turn_count + 1,
			last_turn_ms=excluded.last_turn_ms`
		_, _ = db.Exec(stmt, aff.SessionID, aff.PoolID, aff.AccountEmail, aff.LastTurnMs)

	case "audit":
		evt, ok := task.data.(AuditEvent)
		if !ok {
			return
		}
		if evt.Timestamp == 0 {
			evt.Timestamp = time.Now().UnixMilli()
		}
		if evt.StatusCode == 0 {
			evt.StatusCode = 200
		}
		stmt := `INSERT INTO audit_events (
			timestamp, pool_id, event_type, trigger_reason, previous_leader, new_leader, latency_ms, status_code, details_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		_, _ = db.Exec(stmt,
			evt.Timestamp,
			evt.PoolID,
			evt.EventType,
			evt.TriggerReason,
			evt.PreviousLeader,
			evt.NewLeader,
			evt.LatencyMs,
			evt.StatusCode,
			evt.DetailsJSON,
		)

	case "flight":
		rec, ok := task.data.(FlightRecorderEvent)
		if !ok {
			return
		}
		if rec.Timestamp == 0 {
			rec.Timestamp = time.Now().UnixMilli()
		}
		stmt := `INSERT INTO flight_recorder (
			timestamp, account_email, pool_id, error_kind, status_code, error_message, headers_snapshot, latency_ms, quota_snapshot_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		_, _ = db.Exec(stmt,
			rec.Timestamp,
			rec.AccountEmail,
			rec.PoolID,
			rec.ErrorKind,
			rec.StatusCode,
			rec.ErrorMessage,
			rec.HeadersSnapshot,
			rec.LatencyMs,
			rec.QuotaSnapshotJSON,
		)

	case "flush":
		if doneCh, ok := task.data.(chan struct{}); ok && doneCh != nil {
			close(doneCh)
		}
	}
}

// FlushWriteQueueForTest enqueues a flush sentinel into the asynchronous writeQueue
// and blocks until the worker executes all preceding tasks and acknowledges completion.
// This provides deterministic synchronization for tests without arbitrary sleeps.
func FlushWriteQueueForTest() {
	initWriteWorker()
	done := make(chan struct{})
	enqueueWrite(writeTask{
		kind: "flush",
		data: done,
	})
	select {
	case <-done:
	case <-time.After(3 * time.Second):
	}
}

// ---------------------------------------------------------------------------
// Public Recording & Query APIs
// ---------------------------------------------------------------------------

// RecordEvent asynchronously records a rotation event into SQLite without blocking request dispatch.
func RecordEvent(evt RotationEvent) {
	if evt.Timestamp == 0 {
		evt.Timestamp = time.Now().UnixMilli()
	}
	if evt.StatusCode == 0 {
		evt.StatusCode = 200
	}
	enqueueWrite(writeTask{kind: "rotation", data: evt})
}

// SaveAccountHealth asynchronously persists account health and cooldown state.
func SaveAccountHealth(h AccountHealth) {
	if h.AccountKey == "" {
		return
	}
	enqueueWrite(writeTask{kind: "health", data: h})
}

// SetSessionAffinity asynchronously links an agent session to an account for caching affinity.
func SetSessionAffinity(aff SessionAffinity) {
	if aff.SessionID == "" || aff.PoolID == "" || aff.AccountEmail == "" {
		return
	}
	enqueueWrite(writeTask{kind: "affinity", data: aff})
}

// RecordAuditEvent asynchronously logs a rotation or rebalance decision.
func RecordAuditEvent(evt AuditEvent) {
	enqueueWrite(writeTask{kind: "audit", data: evt})
}

// RecordFlightEvent asynchronously records an incident into the flight recorder black box.
func RecordFlightEvent(rec FlightRecorderEvent) {
	enqueueWrite(writeTask{kind: "flight", data: rec})
}

// GetAllAccountHealth synchronously reads all saved account health records from SQLite.
func GetAllAccountHealth() (map[string]AccountHealth, error) {
	db, err := InitDB()
	if err != nil || db == nil {
		return nil, fmt.Errorf("db unavailable: %w", err)
	}

	rows, err := db.Query(`SELECT
		account_key, email, cool_until_ms, hourly_req_count, consecutive_errors,
		health_score, window_5h_pct, weekly_pct, last_used_ms, updated_at_ms
	FROM account_health`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	results := make(map[string]AccountHealth)
	for rows.Next() {
		var h AccountHealth
		if err := rows.Scan(
			&h.AccountKey,
			&h.Email,
			&h.CoolUntilMs,
			&h.HourlyReqCount,
			&h.ConsecutiveErrors,
			&h.HealthScore,
			&h.Window5hPct,
			&h.WeeklyPct,
			&h.LastUsedMs,
			&h.UpdatedAtMs,
		); err == nil {
			results[h.AccountKey] = h
		}
	}
	return results, nil
}

// GetSessionAffinity checks if an active session has a pinned healthy account (TTL: 5 minutes).
func GetSessionAffinity(sessionID, poolID string) (SessionAffinity, bool) {
	db, err := InitDB()
	if err != nil || db == nil {
		return SessionAffinity{}, false
	}

	var aff SessionAffinity
	query := `SELECT session_id, pool_id, account_email, turn_count, last_turn_ms
		FROM session_affinity
		WHERE session_id = ? AND pool_id = ?`
	err = db.QueryRow(query, sessionID, poolID).Scan(
		&aff.SessionID,
		&aff.PoolID,
		&aff.AccountEmail,
		&aff.TurnCount,
		&aff.LastTurnMs,
	)
	if err != nil {
		return SessionAffinity{}, false
	}

	// 5-minute Prompt Cache TTL validity
	now := time.Now().UnixMilli()
	if now-aff.LastTurnMs > 5*60*1000 {
		return aff, false
	}

	return aff, true
}

// QueryRecentRotations retrieves the latest N rotation events from pool_rotations.
func QueryRecentRotations(limit int) ([]RotationEvent, error) {
	db, err := InitDB()
	if err != nil || db == nil {
		return nil, fmt.Errorf("db unavailable: %w", err)
	}

	if limit <= 0 || limit > 200 {
		limit = 50
	}

	rows, err := db.Query(`SELECT
		timestamp, pool_id, pool_prefix, selected_account, account_email,
		is_failover, cascade_index, target_model, status_code
	FROM pool_rotations ORDER BY timestamp DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []RotationEvent
	for rows.Next() {
		var e RotationEvent
		var isFailoverInt int
		if err := rows.Scan(
			&e.Timestamp,
			&e.PoolID,
			&e.PoolPrefix,
			&e.SelectedAccount,
			&e.AccountEmail,
			&isFailoverInt,
			&e.CascadeIndex,
			&e.TargetModel,
			&e.StatusCode,
		); err == nil {
			e.IsFailover = (isFailoverInt != 0)
			events = append(events, e)
		}
	}
	return events, nil
}

// QueryAuditEvents returns the most recent audit records.
func QueryAuditEvents(limit int) ([]AuditEvent, error) {
	db, err := InitDB()
	if err != nil || db == nil {
		return nil, fmt.Errorf("db unavailable: %w", err)
	}

	if limit <= 0 || limit > 200 {
		limit = 50
	}

	rows, err := db.Query(`SELECT
		id, timestamp, pool_id, event_type, trigger_reason, previous_leader, new_leader, latency_ms, status_code, details_json
	FROM audit_events ORDER BY timestamp DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []AuditEvent
	for rows.Next() {
		var e AuditEvent
		if err := rows.Scan(
			&e.ID,
			&e.Timestamp,
			&e.PoolID,
			&e.EventType,
			&e.TriggerReason,
			&e.PreviousLeader,
			&e.NewLeader,
			&e.LatencyMs,
			&e.StatusCode,
			&e.DetailsJSON,
		); err == nil {
			events = append(events, e)
		}
	}
	return events, nil
}

// QueryFlightEvents returns the most recent black box incidents.
func QueryFlightEvents(limit int) ([]FlightRecorderEvent, error) {
	db, err := InitDB()
	if err != nil || db == nil {
		return nil, fmt.Errorf("db unavailable: %w", err)
	}

	if limit <= 0 || limit > 100 {
		limit = 20
	}

	rows, err := db.Query(`SELECT
		id, timestamp, account_email, pool_id, error_kind, status_code, error_message, headers_snapshot, latency_ms, quota_snapshot_json
	FROM flight_recorder ORDER BY timestamp DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []FlightRecorderEvent
	for rows.Next() {
		var f FlightRecorderEvent
		if err := rows.Scan(
			&f.ID,
			&f.Timestamp,
			&f.AccountEmail,
			&f.PoolID,
			&f.ErrorKind,
			&f.StatusCode,
			&f.ErrorMessage,
			&f.HeadersSnapshot,
			&f.LatencyMs,
			&f.QuotaSnapshotJSON,
		); err == nil {
			events = append(events, f)
		}
	}
	return events, nil
}

// AutoVacuumCheckpoint purges rotation and audit records older than maxAgeDays (default: 30 days)
// and forces SQLite to truncate its WAL journal file, keeping disk usage lean.
func AutoVacuumCheckpoint(maxAgeDays int) error {
	db, err := InitDB()
	if err != nil || db == nil {
		return fmt.Errorf("db unavailable: %w", err)
	}

	if maxAgeDays <= 0 {
		maxAgeDays = 30
	}

	cutoffMs := time.Now().AddDate(0, 0, -maxAgeDays).UnixMilli()

	// 1. Purge old records
	_, _ = db.Exec(`DELETE FROM pool_rotations WHERE timestamp < ?`, cutoffMs)
	_, _ = db.Exec(`DELETE FROM audit_events WHERE timestamp < ?`, cutoffMs)
	_, _ = db.Exec(`DELETE FROM flight_recorder WHERE timestamp < ?`, cutoffMs)
	_, _ = db.Exec(`DELETE FROM session_affinity WHERE last_turn_ms < ?`, cutoffMs)

	// 2. Truncate WAL journal to reclaim physical disk space
	_, err = db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`)
	return err
}

// AgentProfileRecord represents a persisted agent assignment in SQLite WAL.
type AgentProfileRecord struct {
	Universe       string `json:"universe"`         // "gentle_ai" or "jok3r_pi"
	AgentID        string `json:"agent_id"`         // "orchestrator", "worker", "01-planning", etc.
	PrimaryPool    string `json:"primary_pool"`     // "Pool-04-claude"
	FallbackPool   string `json:"fallback_pool"`    // "Pool-01-gemini"
	ThinkingLevel  string `json:"thinking_level"`   // "low", "medium", "high"
	AutoDowngrade  bool   `json:"auto_downgrade"`   // true for automatic cost mitigation on Turn >= 2
	MaxClaudeTurns int    `json:"max_claude_turns"` // Max consecutive turns in Claude before Circuit Breaker trips (default 3, 0 = unlimited)
	Concurrency    int    `json:"concurrency"`      // 1 to 5
	UpdatedAtMs    int64  `json:"updated_at_ms"`
}

// RegisterHarness records or updates a detected harness in the persistent registry.
func RegisterHarness(harnessID, harnessName, metadataJSON string) error {
	db, err := InitDB()
	if err != nil || db == nil {
		return fmt.Errorf("db unavailable: %w", err)
	}
	if harnessID == "" {
		return fmt.Errorf("harness_id cannot be empty")
	}
	if harnessName == "" {
		harnessName = harnessID
	}
	if metadataJSON == "" {
		metadataJSON = "{}"
	}
	now := time.Now().UnixMilli()
	_, err = db.Exec(`INSERT INTO harness_registry (harness_id, harness_name, detected_at_ms, last_seen_ms, metadata_json)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(harness_id) DO UPDATE SET
			harness_name = excluded.harness_name,
			last_seen_ms = excluded.last_seen_ms,
			metadata_json = excluded.metadata_json`,
		harnessID, harnessName, now, now, metadataJSON)
	return err
}

// IsHarnessDetected checks whether a specific harness has been registered and is detected.
func IsHarnessDetected(harnessID string) bool {
	db, err := InitDB()
	if err != nil || db == nil {
		return false
	}
	var count int
	err = db.QueryRow(`SELECT COUNT(*) FROM harness_registry WHERE harness_id = ?`, harnessID).Scan(&count)
	return err == nil && count > 0
}

// UnregisterHarness removes a harness from the detected registry.
func UnregisterHarness(harnessID string) error {
	db, err := InitDB()
	if err != nil || db == nil {
		return fmt.Errorf("db unavailable: %w", err)
	}
	_, err = db.Exec(`DELETE FROM harness_registry WHERE harness_id = ?`, harnessID)
	return err
}

// UpsertAgentProfile stores or updates an agent profile assignment.
func UpsertAgentProfile(p AgentProfileRecord) error {
	db, err := InitDB()
	if err != nil || db == nil {
		return fmt.Errorf("db unavailable: %w", err)
	}

	if p.Universe == "" || p.AgentID == "" {
		return fmt.Errorf("universe and agent_id cannot be empty")
	}
	if p.ThinkingLevel == "" {
		p.ThinkingLevel = "medium"
	}
	if p.Concurrency <= 0 {
		p.Concurrency = 1
	}
	if p.UpdatedAtMs <= 0 {
		p.UpdatedAtMs = time.Now().UnixMilli()
	}

	autoDowngradeInt := 0
	if p.AutoDowngrade {
		autoDowngradeInt = 1
	}

	maxClaudeTurns := p.MaxClaudeTurns
	if maxClaudeTurns < 0 {
		maxClaudeTurns = 3
	}

	_, err = db.Exec(`INSERT INTO agent_profiles (
		universe, agent_id, primary_pool, fallback_pool, thinking_level, auto_downgrade, max_claude_turns, concurrency, updated_at_ms
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(universe, agent_id) DO UPDATE SET
		primary_pool = excluded.primary_pool,
		fallback_pool = excluded.fallback_pool,
		thinking_level = excluded.thinking_level,
		auto_downgrade = excluded.auto_downgrade,
		max_claude_turns = excluded.max_claude_turns,
		concurrency = excluded.concurrency,
		updated_at_ms = excluded.updated_at_ms`,
		p.Universe,
		p.AgentID,
		p.PrimaryPool,
		p.FallbackPool,
		p.ThinkingLevel,
		autoDowngradeInt,
		maxClaudeTurns,
		p.Concurrency,
		p.UpdatedAtMs,
	)
	return err
}

// GetAgentProfiles retrieves stored agent profiles for a given universe ("gentle_ai", "jok3r_pi", or "" for all).
func GetAgentProfiles(universe string) ([]AgentProfileRecord, error) {
	db, err := InitDB()
	if err != nil || db == nil {
		return nil, fmt.Errorf("db unavailable: %w", err)
	}

	query := `SELECT universe, agent_id, primary_pool, fallback_pool, thinking_level, auto_downgrade, max_claude_turns, concurrency, updated_at_ms
		FROM agent_profiles`
	var rows *sql.Rows
	if universe != "" {
		query += ` WHERE universe = ? ORDER BY agent_id ASC`
		rows, err = db.Query(query, universe)
	} else {
		query += ` ORDER BY universe ASC, agent_id ASC`
		rows, err = db.Query(query)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var profiles []AgentProfileRecord
	for rows.Next() {
		var p AgentProfileRecord
		var autoDownInt int
		var maxClaudeTurns sql.NullInt64
		if err := rows.Scan(
			&p.Universe,
			&p.AgentID,
			&p.PrimaryPool,
			&p.FallbackPool,
			&p.ThinkingLevel,
			&autoDownInt,
			&maxClaudeTurns,
			&p.Concurrency,
			&p.UpdatedAtMs,
		); err == nil {
			p.AutoDowngrade = autoDownInt == 1
			if maxClaudeTurns.Valid {
				p.MaxClaudeTurns = int(maxClaudeTurns.Int64)
			} else {
				p.MaxClaudeTurns = 3
			}
			profiles = append(profiles, p)
		}
	}
	return profiles, nil
}

func startAutoVacuumDaemon() {
	// Ejecutar checkpoint y vaciado inicial inmediato en startup para compactar registros antiguos
	_ = AutoVacuumCheckpoint(30)

	vacuumMu.Lock()
	vacuumTicker = time.NewTicker(6 * time.Hour)
	t := vacuumTicker
	stopCh := vacuumStopCh
	vacuumMu.Unlock()

	defer t.Stop()
	for {
		select {
		case <-t.C:
			_ = AutoVacuumCheckpoint(30)
		case <-stopCh:
			return
		}
	}
}

// Shutdown cooperatively stops the auto-vacuum daemon, drains pending writeQueue tasks,
// consolidates the SQLite WAL journal (TRUNCATE), and closes the database connection.
func Shutdown(timeout time.Duration) {
	isShuttingDown.Store(true)

	// 1. Stop vacuum daemon
	vacuumMu.Lock()
	if vacuumTicker != nil {
		vacuumTicker.Stop()
	}
	if vacuumStopCh != nil {
		select {
		case <-vacuumStopCh:
		default:
			close(vacuumStopCh)
		}
	}
	vacuumMu.Unlock()

	// 2. Drain pending tasks in writeQueue
	if writeQueue != nil {
		close(writeQueue)
		if writeWorkerDone != nil {
			select {
			case <-writeWorkerDone:
			case <-time.After(timeout):
			}
		}
	}

	// 3. Truncate WAL to main database file and close
	dbMu.Lock()
	defer dbMu.Unlock()
	if dbInstance != nil {
		_, _ = dbInstance.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`)
		_ = dbInstance.Close()
		dbInstance = nil
	}
}
