package plugin

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"auto-switcher-pro/internal/analytics"
	"auto-switcher-pro/internal/handlers"
	"auto-switcher-pro/internal/license"
	"auto-switcher-pro/internal/version"
	"auto-switcher-pro/internal/web"
)

// ABIVersion defines the supported CLIProxyAPI C-ABI version.
const ABIVersion uint32 = 1

// Envelope wraps all method responses in the standard CLIProxyAPI JSON protocol.
type Envelope struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *EnvelopeError  `json:"error,omitempty"`
}

// EnvelopeError represents an error returned in the standard envelope.
type EnvelopeError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ManagementRequestPayload represents an incoming HTTP request forwarded by CLIProxyAPI host.
type ManagementRequestPayload struct {
	Method  string              `json:"Method"`
	Path    string              `json:"Path"`
	Headers map[string][]string `json:"Headers"`
	Query   map[string][]string `json:"Query"`
	Body    []byte              `json:"Body"`
}

// ManagementResponsePayload represents the HTTP response returned to CLIProxyAPI host.
type ManagementResponsePayload struct {
	StatusCode int                 `json:"StatusCode"`
	Headers    map[string][]string `json:"Headers"`
	Body       string              `json:"Body"` // Base64 encoded payload body
}

// HandlePluginMethod dispatches incoming CLIProxyAPI plugin method calls.
func HandlePluginMethod(method string, request []byte) ([]byte, error) {
	switch method {
	case "plugin.shutdown":
		GetAuthDirectoryWatcher().Stop()
		GetAutonomousQuotaPoller().Stop()
		license.FlushUsage()
		analytics.Shutdown(2 * time.Second)
		return OKEnvelope([]byte(`{"ok":true}`)), nil

	case "plugin.register", "plugin.reconfigure":
		GetAuthDirectoryWatcher().Start()
		GetAutonomousQuotaPoller().Start()

		registration := map[string]any{
			"schema_version": 6,
			"metadata": map[string]any{
				// Historical PascalCase keys for CPAMC native console
				"Name":             "Auto switcher pro",
				"Version":          version.Version,
				"Author":           "WiloxDev",
				"Description":      "Auto Switcher Pro: Infrastructure Control, Visual Profile Topology & Pulse Tokens Telemetry",
				"GitHubRepository": "https://github.com/WiloxDev/cpamc-auto-switcher-pro",
				"Logo":             "",
				"ConfigFields":     []any{},
				// Dual-cased keys for EasyCLIProxyAPI (src/services/plugins.ts metadata parser)
				"name":              "Auto switcher pro",
				"version":           version.Version,
				"author":            "WiloxDev",
				"description":       "Auto Switcher Pro: Infrastructure Control, Visual Profile Topology & Pulse Tokens Telemetry",
				"github_repository": "https://github.com/WiloxDev/cpamc-auto-switcher-pro",
				"logo":              "",
				"config_fields":     []any{},
			},
			"capabilities": map[string]any{
				"management_api": true,
				"model_provider": true,
				"model_router":   true,
				"scheduler":      true,
			},
		}
		raw, err := json.Marshal(registration)
		if err != nil {
			return nil, err
		}
		return OKEnvelope(raw), nil

	case "management.register":
		regResponse := map[string]any{
			"routes": []map[string]any{
				{
					"Method":      http.MethodGet,
					"Path":        manifestRoutePath,
					"Description": "Entrega en O(1) la agregación de pools, líderes activos en RAM, telemetría y estado",
				},
				{
					"Method":      http.MethodGet,
					"Path":        accountsRoutePath,
					"Description": "Alias O(1) de telemetría de cuentas, balanceo y SQLite WAL",
				},
				{
					"Method":      http.MethodGet,
					"Path":        poolsRoutePath,
					"Description": "Lista los pools de balanceo de carga registrados en el plugin",
				},
				{
					"Method":      http.MethodPost,
					"Path":        poolsRoutePath,
					"Description": "Crea o actualiza un pool de balanceo de carga en el registro del plugin",
				},
				{
					"Method":      http.MethodPost,
					"Path":        poolsRoutePath + "/rotate",
					"Description": "Rota de forma atómica y puramente virtual el líder activo de un pool en RAM hacia la siguiente reserva",
				},
				{
					"Method":      http.MethodDelete,
					"Path":        poolsRoutePath,
					"Description": "Disuelve un pool de balanceo de carga del registro del plugin",
				},
				{
					"Method":      http.MethodPost,
					"Path":        virtualizeRoutePath,
					"Description": "Clona una cuenta física en una credencial virtual con prefijo y exclusiones por familia (legacy / multi-prefix)",
				},
				{
					"Method":      http.MethodDelete,
					"Path":        virtualizeRoutePath,
					"Description": "Elimina una credencial virtual de disco",
				},
				{
					"Method":      http.MethodGet,
					"Path":        maintenanceScanRoutePath,
					"Description": "Escanea el estado del sistema, residuos en cuentas y versiones de CPAMC Console",
				},
				{
					"Method":      http.MethodPost,
					"Path":        maintenanceCleanRoutePath,
					"Description": "Limpia y depura modelos residuales ajenos en credenciales",
				},
				{
					"Method":      http.MethodPost,
					"Path":        maintenanceUpdateRoutePath,
					"Description": "Descarga y actualiza de forma segura management.html desde el release oficial con rollback",
				},
				{
					"Method":      http.MethodGet,
					"Path":        metricsRoutePath,
					"Description": "Obtiene métricas y telemetría de rotaciones y failovers locales de pools",
				},
				{
					"Method":      http.MethodGet,
					"Path":        "/auto-switcher-pro/license/session",
					"Description": "Proporciona sesión autorizada por hardware e identidad de máquina licenciada",
				},
				{
					"Method":      http.MethodGet,
					"Path":        "/auto-switcher-pro/license/status",
					"Description": "Obtiene el estado de la licencia de la máquina y días de evaluación",
				},
				{
					"Method":      http.MethodPost,
					"Path":        "/auto-switcher-pro/license/activate",
					"Description": "Activa o traslada una clave de licencia PRO en la máquina",
				},
				{
					"Method":      http.MethodGet,
					"Path":        "/auto-switcher-pro/report",
					"Description": "Genera un paquete de diagnóstico y telemetría para soporte técnico",
				},
				{
					"Method":      http.MethodGet,
					"Path":        predictiveRoutePath,
					"Description": "Obtiene estado y fatiga del motor de rebalanceo predictivo",
				},
				{
					"Method":      http.MethodPost,
					"Path":        predictiveRoutePath,
					"Description": "Actualiza la configuración del motor de rebalanceo predictivo",
				},
				{
					"Method":      http.MethodGet,
					"Path":        predictiveRoutePath + "/telemetry",
					"Description": "Obtiene telemetría viva de cuotas de las cuentas",
				},
				{
					"Method":      http.MethodPost,
					"Path":        predictiveRoutePath + "/telemetry",
					"Description": "Ingiere telemetría viva de cuotas por cuenta individual o en lote",
				},
				{
					"Method":      http.MethodGet,
					"Path":        healthRoutePath,
					"Description": "Health check completo (licencia, upstream, pools activos)",
				},
				{
					"Method":      http.MethodGet,
					"Path":        readyRoutePath,
					"Description": "Readiness check ligero (licencia, registry inicializado)",
				},
				{
					"Method":      http.MethodGet,
					"Path":        sseProxyRoutePath,
					"Description": "SSE Proxy con keep-alive para streaming sin cortes (terminated)",
				},
				{
					"Method":      http.MethodGet,
					"Path":        auditLogRoutePath,
					"Description": "Obtiene la bitácora histórica de rotaciones y eventos de caja negra forense",
				},
				{
					"Method":      http.MethodGet,
					"Path":        agentMatrixRoutePath,
					"Description": "Obtiene la matriz de orquestación de modelos para Gentle-AI y jok3r-pi",
				},
				{
					"Method":      http.MethodPost,
					"Path":        agentMatrixRoutePath,
					"Description": "Actualiza y sincroniza la matriz de agentes en SQLite WAL y perfiles en disco",
				},
				{
					"Method":      http.MethodPost,
					"Path":        agentMatrixPingRoutePath,
					"Description": "Ejecuta una prueba de fuego (dry-run ping) verificando latencia y salud de una ruta de modelo",
				},
				{
					"Method":      http.MethodPost,
					"Path":        agentMatrixHeartbeatRoutePath,
					"Description": "Registra el latido / presencia de un arnés de orquestación (Gentle-AI o j0k3r-pi)",
				},
				{
					"Method":      http.MethodPost,
					"Path":        agentMatrixScanRoutePath,
					"Description": "Escanea el entorno y detecta los arneses y agentes reales del equipo",
				},
				{
					"Method":      http.MethodPost,
					"Path":        agentMatrixWarmupRoutePath,
					"Description": "Dispara el Shadow Warmup asíncrono durante el triage del orquestador",
				},
				{
					"Method":      http.MethodGet,
					"Path":        agentMatrixVersionRoutePath,
					"Description": "Audita y compara la versión del arnés (instalación local vs npm oficial vs GitHub main)",
				},
				{
					"Method":      http.MethodGet,
					"Path":        versionRoutePath,
					"Description": "Audita la versión instalada del plugin y sincronización con GitHub Releases",
				},
				{
					"Method":      http.MethodGet,
					"Path":        incidentsRoutePath,
					"Description": "Consulta el historial de incidentes de disyuntor anti-bucle y autopsias forenses",
				},
				{
					"Method":      http.MethodPost,
					"Path":        incidentsRoutePath,
					"Description": "Registra un incidente de disyuntor anti-bucle mitigado desde las extensiones",
				},
				{
					"Method":      http.MethodGet,
					"Path":        "/auto-switcher-pro/pair",
					"Description": "Entrega el script interactivo de Magic Pairing para conectar agentes remotos",
				},
				{
					"Method":      http.MethodGet,
					"Path":        "/auto-switcher-pro/extension/install.sh",
					"Description": "Entrega el script instalador para extensiones de agentes",
				},
				{
					"Method":      http.MethodGet,
					"Path":        "/auto-switcher-pro/extension/detect",
					"Description": "Detecta los agentes y arneses instalados en el sistema",
				},
			},
			"resources": []map[string]any{
				{
					"Path":        "/00-home",
					"path":        "/00-home",
					"Menu":        "🏠 Inicio & Resumen",
					"menu":        "🏠 Inicio & Resumen",
					"Description": "Centro integral de control, métricas, estado de pools y accesos rápidos",
					"description": "Centro integral de control, métricas, estado de pools y accesos rápidos",
				},
				{
					"Path":        "/01-create-groups",
					"path":        "/01-create-groups",
					"Menu":        "🛠️ Armar Pools",
					"menu":        "🛠️ Armar Pools",
					"Description": "Asistente y orquestador para armar o disolver grupos y pools de perfiles",
					"description": "Asistente y orquestador para armar o disolver grupos y pools de perfiles",
				},
				{
					"Path":        "/02-control-switcher",
					"path":        "/02-control-switcher",
					"Menu":        "♊ Control Switcher",
					"menu":        "♊ Control Switcher",
					"Description": "CPAMC · Centro de Control de Infraestructura IA",
					"description": "CPAMC · Centro de Control de Infraestructura IA",
				},
				{
					"Path":        "/03-auto-auth-files",
					"path":        "/03-auto-auth-files",
					"Menu":        "🗂️ Auto Auth Files",
					"menu":        "🗂️ Auto Auth Files",
					"Description": "Visualizador y trazabilidad de cuentas maestras OAuth y credenciales virtuales",
					"description": "Visualizador y trazabilidad de cuentas maestras OAuth y credenciales virtuales",
				},
				{
					"Path":        "/04-create-prefixes",
					"path":        "/04-create-prefixes",
					"Menu":        "📋 Directorio Cuentas",
					"menu":        "📋 Directorio Cuentas",
					"Description": "Directorio e inspección de cuentas vinculadas y prefijos (edición manual de emergencia)",
					"description": "Directorio e inspección de cuentas vinculadas y prefijos (edición manual de emergencia)",
				},
				{
					"Path":        "/05-agent-matrix",
					"path":        "/05-agent-matrix",
					"Menu":        "🎛️ Matriz de Agentes",
					"menu":        "🎛️ Matriz de Agentes",
					"Description": "Control unificado de orquestadores y subagentes para Gentle-AI (OpenCode) y j0k3r-pi",
					"description": "Control unificado de orquestadores y subagentes para Gentle-AI (OpenCode) y j0k3r-pi",
				},
				{
					"Path":        "/06-pulse-tokens",
					"path":        "/06-pulse-tokens",
					"Menu":        "🏷️ Pulse Tokens",
					"menu":        "🏷️ Pulse Tokens",
					"Description": "Telemetría y analítica de consumo de tokens y latencias",
					"description": "Telemetría y analítica de consumo de tokens y latencias",
				},
				{
					"Path":        "/07-profiles",
					"path":        "/07-profiles",
					"Menu":        "🔵 Visual Profile",
					"menu":        "🔵 Visual Profile",
					"Description": "Visual profile prefix management and topology editor",
					"description": "Visual profile prefix management and topology editor",
				},
				{
					"Path":        "/08-audit-log",
					"path":        "/08-audit-log",
					"Menu":        "📜 Bitácora",
					"menu":        "📜 Bitácora",
					"Description": "Historial forense de rotaciones, rescates 429 e incidentes en disco (SQLite WAL)",
					"description": "Historial forense de rotaciones, rescates 429 e incidentes en disco (SQLite WAL)",
				},
				{
					"Path":        "/09-maintenance",
					"path":        "/09-maintenance",
					"Menu":        "🩺 Salud & Limpieza",
					"menu":        "🩺 Salud & Limpieza",
					"Description": "Diagnóstico, depuración de residuos y actualización segura de CPAMC Console",
					"description": "Diagnóstico, depuración de residuos y actualización segura de CPAMC Console",
				},
				{
					"Path":        "/10-quick-guide",
					"path":        "/10-quick-guide",
					"Menu":        "❓ Guía Rápida",
					"menu":        "❓ Guía Rápida",
					"Description": "Manual de usuario, arquitectura de pools y guía operativa de Auto Switcher Pro",
					"description": "Manual de usuario, arquitectura de pools y guía operativa de Auto Switcher Pro",
				},
			},
		}
		raw, err := json.Marshal(regResponse)
		if err != nil {
			return nil, err
		}
		return OKEnvelope(raw), nil

	case "management.handle":
		return HandleManagementHTTP(request)

	case methodModelStatic, methodModelRegister:
		resp := handleModelStatic()
		raw, err := json.Marshal(resp)
		if err != nil {
			return nil, err
		}
		return OKEnvelope(raw), nil

	case methodModelForAuth:
		var req modelForAuthRequest
		if len(request) > 0 {
			if err := json.Unmarshal(request, &req); err != nil {
				return ErrorEnvelope("bad_request", "malformed model.for_auth request: "+err.Error()), nil
			}
		}
		resp := handleModelForAuth(req)
		raw, err := json.Marshal(resp)
		if err != nil {
			return nil, err
		}
		return OKEnvelope(raw), nil

	case methodModelRoute:
		var req modelRouteRequest
		if len(request) > 0 {
			if err := json.Unmarshal(request, &req); err != nil {
				return ErrorEnvelope("bad_request", "malformed model.route request: "+err.Error()), nil
			}
		}
		resp := handleModelRoute(req)
		raw, err := json.Marshal(resp)
		if err != nil {
			return nil, err
		}
		return OKEnvelope(raw), nil

	case methodSchedulerPick:
		var req schedulerPickRequest
		if len(request) > 0 {
			if err := json.Unmarshal(request, &req); err != nil {
				return ErrorEnvelope("bad_request", "malformed scheduler.pick request: "+err.Error()), nil
			}
		}
		resp := handleSchedulerPick(req)
		raw, err := json.Marshal(resp)
		if err != nil {
			return nil, err
		}
		return OKEnvelope(raw), nil

	default:
		return ErrorEnvelope("unknown_method", "unknown method: "+method), nil
	}
}

// MatchProfilesRoute validates that rawPath targets the exact '/profiles' segment
// and extracts the relative asset subpath.
// Rejects paths where 'profiles' is only a substring (e.g., '/profiles_evil', '/myprofiles').
func MatchProfilesRoute(rawPath string) (subpath string, matched bool) {
	if rawPath == "" {
		return "", false
	}

	unescaped := rawPath
	if u, err := url.PathUnescape(rawPath); err == nil {
		unescaped = u
	}

	// Normalize Windows backslashes
	normalized := strings.ReplaceAll(unescaped, "\\", "/")

	// Strip query string and fragment if present in raw path
	if idx := strings.IndexAny(normalized, "?#"); idx != -1 {
		normalized = normalized[:idx]
	}

	// Split by '/' to inspect exact path segments
	segments := strings.Split(normalized, "/")

	matchedIdx := -1
	for i, seg := range segments {
		if seg == "00-home" || seg == "home" || seg == "profiles" || seg == "center" ||
			seg == "control-switcher" || seg == "02-control-switcher" ||
			seg == "pulse-tokens" || seg == "06-pulse-tokens" || seg == "pulso-tokens" ||
			seg == "create-prefixes" || seg == "04-create-prefixes" ||
			seg == "create-groups" || seg == "01-create-groups" ||
			seg == "auto-auth-files" || seg == "03-auto-auth-files" ||
			seg == "maintenance" || seg == "09-maintenance" ||
			seg == "quick-guide" || seg == "10-quick-guide" ||
			seg == "audit-log" || seg == "08-audit-log" ||
			seg == "agent-matrix" || seg == "05-agent-matrix" ||
			seg == "07-profiles" {
			matchedIdx = i
			break
		}
	}

	if matchedIdx == -1 {
		return "", false
	}

	subSegments := segments[matchedIdx+1:]
	rawSub := strings.Join(subSegments, "/")
	rawSub = strings.TrimPrefix(rawSub, "/")
	rawSub = strings.TrimSpace(rawSub)

	if rawSub == "" {
		rawSub = "index.html"
	}

	return rawSub, true
}

// HandleManagementHTTP resolves asset requests under the /profiles route and serves embedded files.
// Enforces exact /profiles segment routing, validates against directory traversal, and restricts to GET/HEAD.
func HandleManagementHTTP(request []byte) ([]byte, error) {
	var req ManagementRequestPayload
	if len(request) > 0 {
		if err := json.Unmarshal(request, &req); err != nil {
			resp := ManagementResponsePayload{
				StatusCode: http.StatusBadRequest,
				Headers: map[string][]string{
					"Content-Type":           {"application/json; charset=utf-8"},
					"X-Content-Type-Options": {"nosniff"},
				},
				Body: base64.StdEncoding.EncodeToString([]byte(`{"error":"bad_request","message":"malformed JSON request payload"}`)),
			}
			raw, _ := json.Marshal(resp)
			return OKEnvelope(raw), nil
		}
	}

	// 1. Method guard: only GET and HEAD are permitted on static management resources
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = http.MethodGet // default when omitted
	}

	// Manifest unified O(1) route
	if isManifestPath(req.Path) {
		return handleManifestHTTP(req)
	}

	// Pool management routes: GET to list pools, POST to create/update, DELETE to dissolve
	if isPoolsPath(req.Path) {
		return handlePoolsHTTP(req)
	}

	// Maintenance API routes
	if isMaintenancePath(req.Path) {
		return handleMaintenanceHTTP(req)
	}

	// Extension installer routes
	if isExtensionPath(req.Path) {
		return handleExtensionHTTP(req)
	}

	// License management routes
	if isLicensePath(req.Path) {
		return handleLicenseHTTP(req)
	}

	// Plugin version and GitHub sync routes
	if isVersionPath(req.Path) {
		return handleVersionHTTP(req)
	}

	// Metrics telemetry routes
	if isMetricsPath(req.Path) {
		return handleMetricsHTTP(req)
	}

	// Predictive rebalancing routes
	if isPredictivePath(req.Path) {
		return handlePredictiveHTTP(req)
	}

	// Health check routes
	if isHealthPath(req.Path) {
		return handleHealthHTTP(req)
	}

	// Self-healing integrity audit routes
	if isSelfHealingPath(req.Path) {
		return handleSelfHealingHTTP(req)
	}

	// Readiness check routes
	if isReadyPath(req.Path) {
		return handleReadyHTTP(req)
	}

	// SSE Proxy routes
	if isSSEProxyPath(req.Path) {
		return handleSSEProxyHTTP(req)
	}

	// Audit log & flight recorder routes
	if isAuditLogPath(req.Path) {
		return handleAuditLogHTTP(req)
	}

	// Guard incidents & circuit breaker forensics routes
	if isIncidentsPath(req.Path) {
		return handleIncidentsHTTP(req)
	}

	// Telemetry anonymous trace export for deterministic 429 replay
	if isTelemetryTracePath(req.Path) {
		return handleTelemetryTraceHTTP(req)
	}

	// Agent matrix & orchestration routes
	if isAgentMatrixPath(req.Path) {
		return handleAgentMatrixHTTP(req)
	}

	// Virtualize route: POST for cloning, DELETE for removing virtual credential.
	if isVirtualizePath(req.Path) {
		if method == http.MethodPost {
			return handleVirtualizeHTTP(req)
		}
		if method == http.MethodDelete {
			return handleDeleteVirtualHTTP(req)
		}
		resp := ManagementResponsePayload{
			StatusCode: http.StatusMethodNotAllowed,
			Headers: map[string][]string{
				"Content-Type":           {"application/json; charset=utf-8"},
				"X-Content-Type-Options": {"nosniff"},
			},
			Body: base64.StdEncoding.EncodeToString([]byte(`{"error":"method_not_allowed","message":"method not allowed"}`)),
		}
		raw, _ := json.Marshal(resp)
		return OKEnvelope(raw), nil
	}

	if method != http.MethodGet && method != http.MethodHead {
		resp := ManagementResponsePayload{
			StatusCode: http.StatusMethodNotAllowed,
			Headers: map[string][]string{
				"Content-Type":           {"application/json; charset=utf-8"},
				"X-Content-Type-Options": {"nosniff"},
			},
			Body: base64.StdEncoding.EncodeToString([]byte(`{"error":"method_not_allowed","message":"method not allowed"}`)),
		}
		raw, _ := json.Marshal(resp)
		return OKEnvelope(raw), nil
	}

	// 2. Exact segment-scoped routing: must match '/profiles' as an exact path segment
	subpath, matched := MatchProfilesRoute(req.Path)
	if !matched {
		resp := ManagementResponsePayload{
			StatusCode: http.StatusNotFound,
			Headers: map[string][]string{
				"Content-Type":           {"application/json; charset=utf-8"},
				"X-Content-Type-Options": {"nosniff"},
			},
			Body: base64.StdEncoding.EncodeToString([]byte(`{"error":"not_found","message":"resource not found"}`)),
		}
		raw, _ := json.Marshal(resp)
		return OKEnvelope(raw), nil
	}

	// 3. Security guard: detect directory traversal attempts in path and subpath
	unescapedReqPath := req.Path
	if u, err := url.PathUnescape(req.Path); err == nil {
		unescapedReqPath = u
	}
	if strings.Contains(req.Path, "..") ||
		strings.Contains(unescapedReqPath, "..") ||
		strings.Contains(subpath, "..") ||
		strings.Contains(subpath, "\x00") ||
		strings.Contains(req.Path, "\x00") {
		resp := ManagementResponsePayload{
			StatusCode: http.StatusBadRequest,
			Headers: map[string][]string{
				"Content-Type":           {"application/json; charset=utf-8"},
				"X-Content-Type-Options": {"nosniff"},
			},
			Body: base64.StdEncoding.EncodeToString([]byte(`{"error":"invalid_path","message":"invalid or unsafe path"}`)),
		}
		raw, _ := json.Marshal(resp)
		return OKEnvelope(raw), nil
	}

	// Clean and normalize subpath for asset retrieval
	cleanSubpath := path.Clean(strings.ReplaceAll(subpath, "\\", "/"))
	cleanSubpath = strings.TrimPrefix(cleanSubpath, "/")
	if cleanSubpath == "" || cleanSubpath == "." {
		cleanSubpath = "index.html"
	}

	// 4. Retrieve asset from embedded storage
	assetBytes, contentType, err := web.GetAsset(cleanSubpath)
	if err != nil {
		statusCode := http.StatusNotFound
		errCode := "not_found"
		errMsg := "resource not found"

		if errors.Is(err, web.ErrInvalidPath) {
			statusCode = http.StatusBadRequest
			errCode = "invalid_path"
			errMsg = "invalid or unsafe asset path"
		}

		resp := ManagementResponsePayload{
			StatusCode: statusCode,
			Headers: map[string][]string{
				"Content-Type":           {"application/json; charset=utf-8"},
				"X-Content-Type-Options": {"nosniff"},
			},
			Body: base64.StdEncoding.EncodeToString([]byte(`{"error":"` + errCode + `","message":"` + errMsg + `"}`)),
		}
		raw, _ := json.Marshal(resp)
		return OKEnvelope(raw), nil
	}

	headers := handlers.DefaultSecurityHeaders(contentType)

	// For HEAD requests, response headers must match but body must be empty
	var bodyEncoded string
	if method != http.MethodHead {
		bodyEncoded = base64.StdEncoding.EncodeToString(assetBytes)
	}

	resp := ManagementResponsePayload{
		StatusCode: http.StatusOK,
		Headers:    headers,
		Body:       bodyEncoded,
	}

	raw, err := json.Marshal(resp)
	if err != nil {
		return nil, err
	}
	return OKEnvelope(raw), nil
}

// OKEnvelope creates a successful Envelope with raw JSON result.
func OKEnvelope(result []byte) []byte {
	raw, _ := json.Marshal(Envelope{OK: true, Result: json.RawMessage(result)})
	return raw
}

// ErrorEnvelope creates an error Envelope with specified code and message.
func ErrorEnvelope(code, message string) []byte {
	raw, _ := json.Marshal(Envelope{OK: false, Error: &EnvelopeError{Code: code, Message: message}})
	return raw
}
