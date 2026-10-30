package plugin

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"sync"

	"auto-switcher-pro/internal/license"
)

func isLicensePath(path string) bool {
	return strings.Contains(path, "/auto-switcher-pro/license/")
}

var (
	mgmtKeyWarnOnce sync.Once
)

// getLocalManagementKey resolves the local management key from env or disk storage,
// logging explicit audit diagnostics when operating in degraded fallback mode.
func getLocalManagementKey() string {
	key, source, warnMsg := getLocalManagementKeyResolution()
	if warnMsg != "" {
		mgmtKeyWarnOnce.Do(func() {
			log.Printf("[AutoSwitcher] %s", warnMsg)
		})
	} else if source != "" {
		mgmtKeyWarnOnce.Do(func() {
			log.Printf("[AutoSwitcher] Clave de gestión local resuelta con éxito (origen: %s)", source)
		})
	}
	return key
}

// getLocalManagementKeyResolution evaluates candidates returning the resolved key, its source and audit warning.
func getLocalManagementKeyResolution() (key string, source string, warnMsg string) {
	// 1. Environment variables
	if k := os.Getenv("CLIPROXY_MANAGEMENT_KEY"); strings.TrimSpace(k) != "" {
		return strings.TrimSpace(k), "env:CLIPROXY_MANAGEMENT_KEY", ""
	}
	if k := os.Getenv("CPAMC_MANAGEMENT_KEY"); strings.TrimSpace(k) != "" {
		return strings.TrimSpace(k), "env:CPAMC_MANAGEMENT_KEY", ""
	}

	// 2. ~/.cliproxy_management_key (canonical user home)
	if u, err := user.Current(); err == nil && u.HomeDir != "" {
		p := filepath.Join(u.HomeDir, ".cliproxy_management_key")
		if data, err := os.ReadFile(p); err == nil && len(strings.TrimSpace(string(data))) > 0 {
			return strings.TrimSpace(string(data)), "disk:home", ""
		}
	}

	// 3. Common fallback locations
	for _, p := range []string{
		"/root/.cliproxy_management_key",
		".cliproxy_management_key",
		"/tmp/.cliproxy_management_key",
	} {
		if data, err := os.ReadFile(p); err == nil && len(strings.TrimSpace(string(data))) > 0 {
			return strings.TrimSpace(string(data)), fmt.Sprintf("disk_fallback:%s", p),
				fmt.Sprintf("ℹ️ Operando con clave de gestión desde ruta de fallback: %s. En Docker, se recomienda definir CLIPROXY_MANAGEMENT_KEY o montar el volumen de usuario.", p)
		}
	}

	return "", "none", "⚠️ [MODO DEGRADADO] No se encontró la clave de gestión local de CPAMC. " +
		"Verifique que ~/.cliproxy_management_key exista o configure CLIPROXY_MANAGEMENT_KEY en el entorno para evitar fallbacks silenciosos."
}

func handleLicenseHTTP(req ManagementRequestPayload) ([]byte, error) {
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = http.MethodGet
	}

	cleanPath := strings.Split(req.Path, "?")[0]

	switch {
	case strings.HasSuffix(cleanPath, "/session") || strings.HasSuffix(cleanPath, "/handshake"):
		if method != http.MethodGet {
			return jsonManagementResponse(http.StatusMethodNotAllowed, map[string]string{
				"error":   "method_not_allowed",
				"message": "GET required",
			})
		}

		status := license.GetLicenseStatus()
		if status.Status == "expired" && !status.CanRotate {
			return jsonManagementResponse(http.StatusOK, map[string]interface{}{
				"ok":          false,
				"authorized":  false,
				"status":      status.Status,
				"machine_id":  status.MachineID,
				"mac_address": status.MACAddress,
				"message":     "La licencia de esta máquina ha expirado o no es válida.",
			})
		}

		payload := map[string]interface{}{
			"ok":             true,
			"authorized":     true,
			"status":         status.Status,
			"machine_id":     status.MachineID,
			"mac_address":    status.MACAddress,
			"days_remaining": status.DaysRemaining,
		}

		// Security: Do not leak CPAMC management_key over unauthenticated HTTP by default.
		// Only expose local management key if explicitly enabled via opt-in environment variable.
		if os.Getenv("AUTO_SWITCHER_ALLOW_LOCAL_HANDSHAKE") == "1" || strings.EqualFold(os.Getenv("AUTO_SWITCHER_ALLOW_LOCAL_HANDSHAKE"), "true") {
			if key := getLocalManagementKey(); key != "" {
				payload["management_key"] = key
			}
		}

		return jsonManagementResponse(http.StatusOK, payload)

	case strings.HasSuffix(cleanPath, "/status"):
		if method != http.MethodGet {
			return jsonManagementResponse(http.StatusMethodNotAllowed, map[string]string{
				"error":   "method_not_allowed",
				"message": "GET required",
			})
		}
		status := license.GetLicenseStatus()
		return jsonManagementResponse(http.StatusOK, status)

	case strings.HasSuffix(cleanPath, "/activate"):
		if method != http.MethodPost {
			return jsonManagementResponse(http.StatusMethodNotAllowed, map[string]string{
				"error":   "method_not_allowed",
				"message": "POST required",
			})
		}

		type ActivateReq struct {
			Key string `json:"key"`
		}
		var body ActivateReq
		if len(req.Body) > 0 {
			_ = json.Unmarshal(req.Body, &body)
		}

		if strings.TrimSpace(body.Key) == "" {
			return jsonManagementResponse(http.StatusBadRequest, map[string]string{
				"error":   "missing_key",
				"message": "Debes proporcionar una clave de activación",
			})
		}

		updatedStatus, err := license.ActivateKey(strings.TrimSpace(body.Key))
		if err != nil {
			return jsonManagementResponse(http.StatusBadRequest, map[string]string{
				"error":   "activation_failed",
				"message": err.Error(),
			})
		}

		return jsonManagementResponse(http.StatusOK, map[string]interface{}{
			"success": true,
			"message": "¡Licencia activada con éxito!",
			"license": updatedStatus,
		})

	case strings.HasSuffix(cleanPath, "/request-reset"):
		if method != http.MethodPost {
			return jsonManagementResponse(http.StatusMethodNotAllowed, map[string]string{
				"error":   "method_not_allowed",
				"message": "POST required",
			})
		}
		type RequestResetReq struct {
			Email string `json:"email"`
		}
		var body RequestResetReq
		if len(req.Body) > 0 {
			_ = json.Unmarshal(req.Body, &body)
		}
		if strings.TrimSpace(body.Email) == "" {
			return jsonManagementResponse(http.StatusBadRequest, map[string]string{
				"error":   "missing_email",
				"message": "Debes proporcionar tu correo electrónico",
			})
		}
		res, err := license.RequestReset(body.Email)
		if err != nil {
			return jsonManagementResponse(http.StatusBadRequest, map[string]string{
				"error":   "request_failed",
				"message": err.Error(),
			})
		}
		return jsonManagementResponse(http.StatusOK, res)

	case strings.HasSuffix(cleanPath, "/verify-reset"):
		if method != http.MethodPost {
			return jsonManagementResponse(http.StatusMethodNotAllowed, map[string]string{
				"error":   "method_not_allowed",
				"message": "POST required",
			})
		}
		type VerifyResetReq struct {
			Email string `json:"email"`
			PIN   string `json:"pin"`
		}
		var body VerifyResetReq
		if len(req.Body) > 0 {
			_ = json.Unmarshal(req.Body, &body)
		}
		if strings.TrimSpace(body.Email) == "" || strings.TrimSpace(body.PIN) == "" {
			return jsonManagementResponse(http.StatusBadRequest, map[string]string{
				"error":   "missing_parameters",
				"message": "Correo y código PIN son requeridos",
			})
		}
		updatedStatus, err := license.VerifyReset(body.Email, body.PIN)
		if err != nil {
			return jsonManagementResponse(http.StatusBadRequest, map[string]string{
				"error":   "verification_failed",
				"message": err.Error(),
			})
		}
		return jsonManagementResponse(http.StatusOK, map[string]interface{}{
			"success": true,
			"message": "¡Licencia transferida y activada con éxito!",
			"license": updatedStatus,
		})

	default:
		return jsonManagementResponse(http.StatusNotFound, map[string]string{
			"error":   "not_found",
			"message": "license endpoint not found",
		})
	}
}
