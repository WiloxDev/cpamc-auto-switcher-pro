package license

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ErrLicenseExpired se retorna cuando la firma criptográfica y el MachineID son válidos
// pero la fecha límite de la licencia ha sido superada.
var ErrLicenseExpired = errors.New("la licencia ha expirado")

// IsAirgapModeEnabled verifica si el sistema opera en modo aislado sin red externa.
func IsAirgapModeEnabled() bool {
	val := strings.ToLower(strings.TrimSpace(os.Getenv("CPAMC_AIRGAP_MODE")))
	return val == "1" || val == "true"
}

// MasterPublicKeyHexV2 es la clave pública Ed25519 primaria de última generación.
// Las licencias emitidas con la nueva semilla privada serán validadas prioritariamente por esta clave.
const MasterPublicKeyHexV2 = "8c310a1ee2a8e20d6222e717762b696d0bb0a7ea516dfd79a857f39aff98fabb"

// MasterPublicKeyHexV1 es la clave pública histórica (legacy), mantenida de forma transitoria
// en el anillo de claves para asegurar migración transparente sin brickeo de clientes existentes.
const MasterPublicKeyHexV1 = "5703fbe52952c260651807d527db5e6021b38cdb40f4ff7ef5b898f3288ab1e1"

// MasterPublicKeyHex mantiene compatibilidad hacia atrás con referencias directas al símbolo clásico.
const MasterPublicKeyHex = MasterPublicKeyHexV2

const (
	TrialDurationDays = 30
	StatusTrial       = "trial"
	StatusActive      = "active"
	StatusExpired     = "expired"
	DefaultHubURL     = "https://hub.wiloxdev.com"
)

// LicenseClaims represents the payload signed inside an activation key.
type LicenseClaims struct {
	MachineID string `json:"machine_id"` // Strictly machine-locked
	Client    string `json:"client"`     // Buyer identifier (e.g. email or handle)
	Tier      string `json:"tier"`       // "pro" or "enterprise"
	IssuedAt  int64  `json:"iat"`        // Unix timestamp
	ExpiresAt int64  `json:"exp"`        // Unix timestamp (0 for lifetime)
}

// LicenseFile represents the persisted state on disk.
type LicenseFile struct {
	FirstBootAt    int64          `json:"first_boot_at"`
	LastSeenAt     int64          `json:"last_seen_at"`
	MachineID      string         `json:"machine_id,omitempty"`
	MACAddress     string         `json:"mac_address,omitempty"`
	TotalRequests  int64          `json:"total_requests,omitempty"`  // Total de peticiones balanceadas
	TotalFailovers int64          `json:"total_failovers,omitempty"` // Rotaciones reales por rescate de reserva
	LicenseKey     string         `json:"license_key,omitempty"`
	ActiveClaims   *LicenseClaims `json:"active_claims,omitempty"`
}

// StatusReport is returned to the web UI and management API.
type StatusReport struct {
	MachineID      string `json:"machine_id"`
	MACAddress     string `json:"mac_address,omitempty"`
	Status         string `json:"status"` // "trial" | "active" | "expired"
	DaysRemaining  int    `json:"days_remaining"`
	TrialTotalDays int    `json:"trial_total_days"`
	Tier           string `json:"tier"`
	Client         string `json:"client,omitempty"`
	ExpiresAt      string `json:"expires_at,omitempty"`
	IsPro          bool   `json:"is_pro"`
	CanRotate      bool   `json:"can_rotate"`
}

func getLicenseStoragePath() string {
	candidates := []string{
		"/CLIProxyAPI/plugins/auto-switcher-pro-license.json",
		filepath.Join(os.Getenv("HOME"), "services/cliproxy/plugins/auto-switcher-pro-license.json"),
		filepath.Join(os.Getenv("HOME"), ".local/share/auto-switcher-pro/license.json"),
		"./auto-switcher-pro-license.json",
	}
	for _, p := range candidates {
		dir := filepath.Dir(p)
		if fi, err := os.Stat(dir); err == nil && fi.IsDir() {
			return p
		}
	}
	return "./auto-switcher-pro-license.json"
}

var licenseFileMu sync.Mutex

// LoadOrInitLicense loads the license file or creates initial 30-day trial record.
func LoadOrInitLicense() (*LicenseFile, error) {
	licenseFileMu.Lock()
	defer licenseFileMu.Unlock()

	path := getLicenseStoragePath()
	now := time.Now().Unix()

	if data, err := os.ReadFile(path); err == nil {
		var lf LicenseFile
		if err := json.Unmarshal(data, &lf); err == nil && lf.FirstBootAt > 0 {
			// Anti-tamper check: clock rollback detection
			if now < lf.LastSeenAt-3600 {
				// Clock went back more than 1 hour -> advance last seen to prevent abuse
				lf.LastSeenAt = now
			} else if now > lf.LastSeenAt {
				lf.LastSeenAt = now
			}

			updated := false
			// Asegurar que el MachineID y MACAddress queden guardados en el archivo persistente
			if lf.MachineID == "" {
				lf.MachineID = GetMachineID()
				updated = true
			}
			if lf.MACAddress == "" {
				lf.MACAddress = GetMACAddress()
				updated = true
			}
			if updated {
				_ = saveLicenseFileLocked(path, &lf)
			}
			return &lf, nil
		}
	}

	// Initialize new trial record
	lf := &LicenseFile{
		FirstBootAt: now,
		LastSeenAt:  now,
		MachineID:   GetMachineID(),
		MACAddress:  GetMACAddress(),
	}
	_ = saveLicenseFileLocked(path, lf)
	return lf, nil
}

func saveLicenseFile(path string, lf *LicenseFile) error {
	licenseFileMu.Lock()
	defer licenseFileMu.Unlock()
	return saveLicenseFileLocked(path, lf)
}

func saveLicenseFileLocked(path string, lf *LicenseFile) error {
	dir := filepath.Dir(path)
	_ = os.MkdirAll(dir, 0755)
	data, err := json.MarshalIndent(lf, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// VerifyActivationKey validates an Ed25519 signature against current machine ID
// using the master dual-key ring (prioritizing V2, with graceful fallback to V1 legacy).
func VerifyActivationKey(keyStr string, currentMachineID string) (*LicenseClaims, error) {
	var expiredClaims *LicenseClaims

	// 1. Validar contra clave primaria V2
	pubV2Hex := os.Getenv("CPAMC_MASTER_PUBKEY_V2")
	if pubV2Hex == "" {
		pubV2Hex = MasterPublicKeyHexV2
	}
	if pubV2Bytes, err := hex.DecodeString(pubV2Hex); err == nil && len(pubV2Bytes) == ed25519.PublicKeySize {
		if claims, err := verifyActivationKeyWithPub(keyStr, currentMachineID, pubV2Bytes); err == nil {
			return claims, nil
		} else if errors.Is(err, ErrLicenseExpired) {
			expiredClaims = claims
		}
	}

	// 2. Fallback transitorio a clave legacy V1
	pubV1Hex := os.Getenv("CPAMC_MASTER_PUBKEY_V1")
	if pubV1Hex == "" {
		pubV1Hex = MasterPublicKeyHexV1
	}
	if pubV1Bytes, err := hex.DecodeString(pubV1Hex); err == nil && len(pubV1Bytes) == ed25519.PublicKeySize {
		if claims, err := verifyActivationKeyWithPub(keyStr, currentMachineID, pubV1Bytes); err == nil {
			return claims, nil
		} else if errors.Is(err, ErrLicenseExpired) && expiredClaims == nil {
			expiredClaims = claims
		}
	}

	if expiredClaims != nil {
		return expiredClaims, ErrLicenseExpired
	}

	return nil, errors.New("firma criptográfica inválida o clave adulterada")
}

// verifyActivationKeyWithPub es el núcleo de verificación inyectable (usado por tests con pares efímeros).
func verifyActivationKeyWithPub(keyStr string, currentMachineID string, pubBytes []byte) (*LicenseClaims, error) {
	keyStr = strings.TrimSpace(keyStr)
	parts := strings.Split(keyStr, ".")
	if len(parts) != 2 {
		return nil, errors.New("formato de clave inválido (debe ser payload.signature)")
	}

	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, fmt.Errorf("error al decodificar payload: %w", err)
	}

	sigBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("error al decodificar firma: %w", err)
	}

	// Verify Ed25519 signature
	if !ed25519.Verify(pubBytes, payloadBytes, sigBytes) {
		return nil, errors.New("firma criptográfica inválida o clave adulterada")
	}

	var claims LicenseClaims
	if err := json.Unmarshal(payloadBytes, &claims); err != nil {
		return nil, fmt.Errorf("error al interpretar claims: %w", err)
	}

	// Strict Machine-Lock check
	if claims.MachineID != currentMachineID {
		return nil, fmt.Errorf("esta licencia pertenece a otra máquina (%s)", claims.MachineID)
	}

	// Expiration check (0 means lifetime)
	now := time.Now().Unix()
	if claims.ExpiresAt > 0 && now > claims.ExpiresAt {
		return &claims, ErrLicenseExpired
	}

	return &claims, nil
}

// ActivateKey activates and persists a signed key.
func ActivateKey(keyStr string) (*StatusReport, error) {
	currentMachine := GetMachineID()
	claims, err := VerifyActivationKey(keyStr, currentMachine)
	if err != nil {
		return nil, err
	}

	path := getLicenseStoragePath()
	lf, _ := LoadOrInitLicense()
	lf.LicenseKey = keyStr
	lf.ActiveClaims = claims
	lf.LastSeenAt = time.Now().Unix()

	if err := saveLicenseFile(path, lf); err != nil {
		return nil, fmt.Errorf("error al guardar licencia: %w", err)
	}

	return GetLicenseStatus(), nil
}

// TelemetryInfo represents usage and environment metrics reported to the licensing hub.
type TelemetryInfo struct {
	Version        string   `json:"version"`
	OS             string   `json:"os"`
	Rotations      int64    `json:"rotations"`       // Peticiones totales
	TotalFailovers int64    `json:"total_failovers"` // Conmutaciones por rescate de reserva
	ActivePools    []string `json:"active_pools"`
}

var (
	telemetryProvider func() TelemetryInfo
	lastSyncUnix      int64
	syncMutex         sync.Mutex

	memRequests    atomic.Int64
	memFailovers   atomic.Int64
	memUsageInited atomic.Bool
	flushMu        sync.Mutex
	lastFlushUnix  atomic.Int64
)

func initUsageCountersIfNeeded() {
	if memUsageInited.Load() {
		return
	}
	flushMu.Lock()
	defer flushMu.Unlock()
	if memUsageInited.Load() {
		return
	}
	lf, err := LoadOrInitLicense()
	if err == nil && lf != nil {
		memRequests.Store(lf.TotalRequests)
		memFailovers.Store(lf.TotalFailovers)
	}
	memUsageInited.Store(true)
}

// FlushUsage synchronously persists in-memory usage metrics to the license file.
func FlushUsage() {
	if !memUsageInited.Load() {
		return
	}
	flushMu.Lock()
	defer flushMu.Unlock()

	path := getLicenseStoragePath()
	lf, err := LoadOrInitLicense()
	if err != nil || lf == nil {
		return
	}

	reqs := memRequests.Load()
	fails := memFailovers.Load()

	if reqs != lf.TotalRequests || fails != lf.TotalFailovers {
		lf.TotalRequests = reqs
		lf.TotalFailovers = fails
		_ = saveLicenseFile(path, lf)
	}
	lastFlushUnix.Store(time.Now().Unix())
}

// RecordRotation atomically increments and persists request and failover metrics in RAM
// with amortized asynchronous flush to disk, eliminating per-turn disk I/O latency.
func RecordRotation(isFailover bool) (int64, int64) {
	initUsageCountersIfNeeded()
	reqs := memRequests.Add(1)
	var fails int64
	if isFailover {
		fails = memFailovers.Add(1)
	} else {
		fails = memFailovers.Load()
	}

	now := time.Now().Unix()
	if reqs%50 == 0 || now-lastFlushUnix.Load() > 30 {
		go FlushUsage()
	}

	return reqs, fails
}

// GetPersistedUsage returns the stored requests and failover metrics.
func GetPersistedUsage() (int64, int64) {
	if memUsageInited.Load() {
		return memRequests.Load(), memFailovers.Load()
	}
	lf, _ := LoadOrInitLicense()
	return lf.TotalRequests, lf.TotalFailovers
}

// SetTelemetryProvider registers a provider function for usage telemetry.
func SetTelemetryProvider(provider func() TelemetryInfo) {
	telemetryProvider = provider
}

// anonymizeIdentifier creates a 16-character pseudonymous hash of hardware identifiers
// to protect user privacy against cleartext eavesdropping in transit.
func anonymizeIdentifier(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	h := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(h[:8])
}

// SyncWithCloudHub contacts the central Contabo VPS to verify/update status in background.
func SyncWithCloudHub(machineID string) {
	// Entornos aislados (air-gapped / intranet): silenciar telemetría si está explícitamente configurado
	if IsAirgapModeEnabled() {
		return
	}

	now := time.Now().Unix()
	syncMutex.Lock()
	if now-lastSyncUnix < 20 { // Throttle: máximo un ping cada 20 segundos
		syncMutex.Unlock()
		return
	}
	lastSyncUnix = now
	syncMutex.Unlock()

	hubURL := os.Getenv("AUTO_SWITCHER_HUB_URL")
	if hubURL == "" {
		hubURL = os.Getenv("CPAMC_LICENSE_HUB_URL")
	}
	if hubURL == "" {
		hubURL = DefaultHubURL
	}
	hubURL = strings.TrimRight(hubURL, "/")

	go func() {
		client := &http.Client{Timeout: 4 * time.Second}
		type pingPayload struct {
			MachineID      string   `json:"machine_id"`
			MACAddress     string   `json:"mac_address,omitempty"`
			ClientName     string   `json:"client_name,omitempty"`
			Version        string   `json:"version,omitempty"`
			OS             string   `json:"os,omitempty"`
			Rotations      int64    `json:"rotations,omitempty"`
			TotalFailovers int64    `json:"total_failovers,omitempty"`
			ActivePools    []string `json:"active_pools,omitempty"`
		}

		payload := pingPayload{
			MachineID:  machineID,
			MACAddress: anonymizeIdentifier(GetMACAddress()),
			ClientName: anonymizeIdentifier(GetSystemIdentity()),
			OS:         runtime.GOOS,
		}
		if telemetryProvider != nil {
			info := telemetryProvider()
			payload.Version = info.Version
			payload.Rotations = info.Rotations
			payload.TotalFailovers = info.TotalFailovers
			payload.ActivePools = info.ActivePools
			if info.OS != "" {
				payload.OS = info.OS
			}
		}

		jsonBytes, _ := json.Marshal(payload)
		resp, err := client.Post(hubURL+"/api/v1/license/ping", "application/json", strings.NewReader(string(jsonBytes)))
		if err != nil || resp.StatusCode != http.StatusOK {
			return
		}
		defer resp.Body.Close()

		var res struct {
			OK           bool   `json:"ok"`
			Status       string `json:"status"`
			Tier         string `json:"tier"`
			LicenseToken string `json:"license_token"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&res); err == nil && res.OK {
			if res.LicenseToken != "" {
				// Server pushed an active approved token -> auto-activate locally!
				_, _ = ActivateKey(res.LicenseToken)
			}
		}
	}()
}

// ComputeStatusForClaims es una función pura desacoplada que calcula el estado operativo
// en base a los claims, resultado de verificación, máquina actual y marcas de tiempo.
func ComputeStatusForClaims(claims *LicenseClaims, verifyErr error, currentMachine string, now int64, trialEnd int64) *StatusReport {
	// 1. Licencia Pro válida o en período de gracia
	if claims != nil && (verifyErr == nil || errors.Is(verifyErr, ErrLicenseExpired)) {
		var expStr string
		daysRemaining := 9999
		if claims.ExpiresAt > 0 {
			diff := claims.ExpiresAt - now
			if diff > 0 {
				daysRemaining = int(diff / 86400)
				expStr = time.Unix(claims.ExpiresAt, 0).Format("2006-01-02")
			} else {
				daysRemaining = 0
				expStr = time.Unix(claims.ExpiresAt, 0).Format("2006-01-02")
			}
		} else {
			expStr = "De por vida (Lifetime)"
		}

		// Licencia activa (no expirada)
		if claims.ExpiresAt == 0 || (claims.ExpiresAt > now) {
			return &StatusReport{
				MachineID:      currentMachine,
				Status:         StatusActive,
				DaysRemaining:  daysRemaining,
				TrialTotalDays: TrialDurationDays,
				Tier:           strings.ToUpper(claims.Tier),
				Client:         claims.Client,
				ExpiresAt:      expStr,
				IsPro:          true,
				CanRotate:      true,
			}
		}

		// Período de gracia de 7 días: si venció hace <= 7 días, mantiene CanRotate activo
		const gracePeriodSeconds = int64(7 * 86400)
		if now-claims.ExpiresAt <= gracePeriodSeconds {
			return &StatusReport{
				MachineID:      currentMachine,
				Status:         "grace_period",
				DaysRemaining:  0,
				TrialTotalDays: TrialDurationDays,
				Tier:           strings.ToUpper(claims.Tier) + " (PERÍODO DE GRACIA)",
				Client:         claims.Client,
				ExpiresAt:      expStr,
				IsPro:          true,
				CanRotate:      true,
			}
		}

		// Venció hace más de 7 días -> expirado
		return &StatusReport{
			MachineID:      currentMachine,
			Status:         StatusExpired,
			DaysRemaining:  0,
			TrialTotalDays: TrialDurationDays,
			Tier:           strings.ToUpper(claims.Tier) + " (EXPIRADO)",
			Client:         claims.Client,
			ExpiresAt:      expStr,
			IsPro:          true,
			CanRotate:      false,
		}
	}

	// 2. Modelo 100% Gratuito y Libre (Community / Coffee-ware)
	// El software no bloquea rotaciones ni expira por tiempo de uso:
	// se sostiene mediante aportes voluntarios (invitar un café).
	diff := trialEnd - now
	daysLeft := int(diff / 86400)
	if daysLeft < 0 {
		daysLeft = 0
	}

	return &StatusReport{
		MachineID:      currentMachine,
		Status:         StatusActive,
		DaysRemaining:  9999,
		TrialTotalDays: TrialDurationDays,
		Tier:           "COMMUNITY (100% GRATUITO)",
		ExpiresAt:      "De por vida (Coffee-ware)",
		IsPro:          true,
		CanRotate:      true,
	}
}

// GetLicenseStatus computes the current operational status.
func GetLicenseStatus() *StatusReport {
	currentMachine := GetMachineID()
	lf, _ := LoadOrInitLicense()
	now := time.Now().Unix()

	// Asynchronously ping cloud hub for auto-activation without blocking local execution
	SyncWithCloudHub(currentMachine)

	trialEnd := lf.FirstBootAt + int64(TrialDurationDays*86400)

	// Check if a persisted license key exists
	if lf.LicenseKey != "" {
		claims, err := VerifyActivationKey(lf.LicenseKey, currentMachine)
		if claims != nil && (err == nil || errors.Is(err, ErrLicenseExpired)) {
			return ComputeStatusForClaims(claims, err, currentMachine, now, trialEnd)
		}
	}

	return ComputeStatusForClaims(nil, nil, currentMachine, now, trialEnd)
}

// RequestReset sends a request to the cloud hub to generate a reset PIN for this machine.
func RequestReset(email string) (map[string]interface{}, error) {
	hubURL := os.Getenv("CPAMC_LICENSE_HUB_URL")
	if hubURL == "" {
		hubURL = DefaultHubURL
	}
	hubURL = strings.TrimRight(hubURL, "/")

	currentMachine := GetMachineID()
	client := &http.Client{Timeout: 5 * time.Second}
	payload := map[string]string{
		"email":      strings.TrimSpace(email),
		"machine_id": currentMachine,
	}
	jsonBytes, _ := json.Marshal(payload)

	resp, err := client.Post(hubURL+"/api/v1/license/request-reset", "application/json", strings.NewReader(string(jsonBytes)))
	if err != nil {
		return nil, fmt.Errorf("error al conectar con el servidor de licencias: %w", err)
	}
	defer resp.Body.Close()

	var res map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, fmt.Errorf("respuesta inválida del servidor: %w", err)
	}

	return res, nil
}

// VerifyReset validates the PIN and activates the license locally on this new machine.
func VerifyReset(email string, pin string) (*StatusReport, error) {
	hubURL := os.Getenv("CPAMC_LICENSE_HUB_URL")
	if hubURL == "" {
		hubURL = DefaultHubURL
	}
	hubURL = strings.TrimRight(hubURL, "/")

	currentMachine := GetMachineID()
	client := &http.Client{Timeout: 5 * time.Second}
	payload := map[string]string{
		"email":      strings.TrimSpace(email),
		"machine_id": currentMachine,
		"pin":        strings.TrimSpace(pin),
	}
	jsonBytes, _ := json.Marshal(payload)

	resp, err := client.Post(hubURL+"/api/v1/license/verify-reset", "application/json", strings.NewReader(string(jsonBytes)))
	if err != nil {
		return nil, fmt.Errorf("error al conectar con el servidor de licencias: %w", err)
	}
	defer resp.Body.Close()

	var res struct {
		OK           bool   `json:"ok"`
		Message      string `json:"message"`
		LicenseToken string `json:"license_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, fmt.Errorf("respuesta inválida: %w", err)
	}

	if !res.OK || res.LicenseToken == "" {
		msg := res.Message
		if msg == "" {
			msg = "código de verificación inválido"
		}
		return nil, errors.New(msg)
	}

	// Activar localmente la clave recibida
	return ActivateKey(res.LicenseToken)
}
