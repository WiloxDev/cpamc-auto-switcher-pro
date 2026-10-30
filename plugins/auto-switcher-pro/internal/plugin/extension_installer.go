package plugin

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func isExtensionPath(path string) bool {
	return strings.Contains(path, "/auto-switcher-pro/extension/") || strings.Contains(path, "/auto-switcher-pro/pair")
}

func extractServerBaseURL(req ManagementRequestPayload) string {
	host := ""
	if hosts, ok := req.Headers["Host"]; ok && len(hosts) > 0 {
		host = hosts[0]
	} else if hosts, ok := req.Headers["host"]; ok && len(hosts) > 0 {
		host = hosts[0]
	} else if fwd, ok := req.Headers["X-Forwarded-Host"]; ok && len(fwd) > 0 {
		host = fwd[0]
	}
	if host == "" {
		host = "localhost:8317"
	}
	proto := "http"
	if p, ok := req.Headers["X-Forwarded-Proto"]; ok && len(p) > 0 && p[0] == "https" {
		proto = "https"
	}
	return fmt.Sprintf("%s://%s", proto, host)
}

type AgentTarget struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Path      string `json:"path"`
	Exists    bool   `json:"exists"`
	Installed bool   `json:"installed"`
}

type ExtensionDetectResponse struct {
	IsContainer bool          `json:"is_container"`
	Targets     []AgentTarget `json:"targets"`
	CurlCommand string        `json:"curl_command"`
}

func detectEnvironment() bool {
	// Simple check if running inside Docker container
	if _, err := os.Stat("/.dockerenv"); err == nil {
		return true
	}
	data, err := os.ReadFile("/proc/1/cgroup")
	if err == nil && (strings.Contains(string(data), "docker") || strings.Contains(string(data), "containerd")) {
		return true
	}
	return false
}

func getCandidateAgentTargets() []AgentTarget {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "/root"
	}

	candidates := []struct {
		id   string
		name string
		dir  string
	}{
		{"gentle-shell-pi", "Gentle Shell (~/.pi/gentle-shell)", filepath.Join(home, ".pi", "gentle-shell", "extensions")},
		{"gentle-shell", "Gentle Shell (~/.gentle-shell/agent)", filepath.Join(home, ".gentle-shell", "agent", "extensions")},
		{"pi", "Pi Vanilla", filepath.Join(home, ".pi", "agent", "extensions")},
		{"agent-wilox", "Wilox Pi", filepath.Join(home, ".pi", "agent-wilox", "extensions")},
		{"j0k3r-pi", "J0k3r Pi", filepath.Join(home, ".pi", "agent-j0k3r", "extensions")},
	}

	// Verificar ~/.gentle-shell/config.json para incluir la ruta configurada explícitamente
	cfgPath := filepath.Join(home, ".gentle-shell", "config.json")
	if data, err := os.ReadFile(cfgPath); err == nil {
		var cfg struct {
			Home string `json:"home"`
		}
		if json.Unmarshal(data, &cfg) == nil && cfg.Home != "" {
			customDir := filepath.Join(cfg.Home, "extensions")
			exists := false
			for _, c := range candidates {
				if c.dir == customDir {
					exists = true
					break
				}
			}
			if !exists {
				candidates = append([]struct {
					id   string
					name string
					dir  string
				}{{"gentle-shell-cfg", "Gentle Shell (configurado)", customDir}}, candidates...)
			}
		}
	}

	var results []AgentTarget
	for _, c := range candidates {
		parentDir := filepath.Dir(c.dir)
		_, parentExists := os.Stat(parentDir)
		extPath := filepath.Join(c.dir, "cpamc-auto-switcher")
		_, extExists := os.Stat(extPath)

		results = append(results, AgentTarget{
			ID:        c.id,
			Name:      c.name,
			Path:      c.dir,
			Exists:    parentExists == nil,
			Installed: extExists == nil,
		})
	}
	return results
}

func handleExtensionHTTP(req ManagementRequestPayload) ([]byte, error) {
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = http.MethodGet
	}

	cleanPath := strings.Split(req.Path, "?")[0]

	switch {
	case strings.HasSuffix(cleanPath, "/detect"):
		if method != http.MethodGet {
			return jsonManagementResponse(http.StatusMethodNotAllowed, map[string]string{
				"error":   "method_not_allowed",
				"message": "GET required",
			})
		}
		isCont := detectEnvironment()
		targets := getCandidateAgentTargets()
		resp := ExtensionDetectResponse{
			IsContainer: isCont,
			Targets:     targets,
			CurlCommand: "curl -sSL http://localhost:8317/auto-switcher-pro/extension/install.sh | bash",
		}
		return jsonManagementResponse(http.StatusOK, resp)

	case strings.HasSuffix(cleanPath, "/pair"):
		if method != http.MethodGet && method != http.MethodHead {
			return jsonManagementResponse(http.StatusMethodNotAllowed, map[string]string{
				"error":   "method_not_allowed",
				"message": "GET or HEAD required",
			})
		}
		serverURL := extractServerBaseURL(req)
		script := generatePairingBashScript(serverURL)
		resp := ManagementResponsePayload{
			StatusCode: http.StatusOK,
			Headers: map[string][]string{
				"Content-Type":                {"text/plain; charset=utf-8"},
				"Access-Control-Allow-Origin": {"*"},
			},
			Body: base64.StdEncoding.EncodeToString([]byte(script)),
		}
		raw, _ := json.Marshal(resp)
		return OKEnvelope(raw), nil

	case strings.HasSuffix(cleanPath, "/install.sh"):
		if method != http.MethodGet && method != http.MethodHead {
			return jsonManagementResponse(http.StatusMethodNotAllowed, map[string]string{
				"error":   "method_not_allowed",
				"message": "GET or HEAD required",
			})
		}
		script := generateInstallerBashScript()
		resp := ManagementResponsePayload{
			StatusCode: http.StatusOK,
			Headers: map[string][]string{
				"Content-Type":                {"text/plain; charset=utf-8"},
				"Access-Control-Allow-Origin": {"*"},
			},
			Body: base64.StdEncoding.EncodeToString([]byte(script)),
		}
		raw, _ := json.Marshal(resp)
		return OKEnvelope(raw), nil

	case strings.HasSuffix(cleanPath, "/install"):
		if method != http.MethodPost {
			return jsonManagementResponse(http.StatusMethodNotAllowed, map[string]string{
				"error":   "method_not_allowed",
				"message": "POST required",
			})
		}
		return handleDirectInstall(req)

	default:
		return jsonManagementResponse(http.StatusNotFound, map[string]string{
			"error":   "not_found",
			"message": "extension endpoint not found",
		})
	}
}

func handleDirectInstall(req ManagementRequestPayload) ([]byte, error) {
	type InstallReq struct {
		TargetID string `json:"target_id"`
	}
	var body InstallReq
	if len(req.Body) > 0 {
		_ = json.Unmarshal(req.Body, &body)
	}

	targets := getCandidateAgentTargets()
	var selected *AgentTarget
	for _, t := range targets {
		if t.ID == body.TargetID || (body.TargetID == "" && t.Exists) {
			selected = &t
			break
		}
	}

	if selected == nil {
		return jsonManagementResponse(http.StatusBadRequest, map[string]string{
			"error":   "no_target",
			"message": "no valid agent target found to install into",
		})
	}

	if err := os.MkdirAll(selected.Path, 0755); err != nil {
		return jsonManagementResponse(http.StatusInternalServerError, map[string]string{
			"error":   "mkdir_failed",
			"message": fmt.Sprintf("failed to create directory: %v", err),
		})
	}

	dest := filepath.Join(selected.Path, "cpamc-auto-switcher")
	homeDir, _ := os.UserHomeDir()
	sourceCandidates := []string{
		"./extensions/cpamc-auto-switcher",
		"../extensions/cpamc-auto-switcher",
		filepath.Join(homeDir, ".gentle-shell", "agent", "extensions", "cpamc-auto-switcher"),
		"/CLIProxyAPI/plugins/cpamc-auto-switcher",
	}

	var validSource string
	for _, s := range sourceCandidates {
		if fi, err := os.Stat(s); err == nil && fi.IsDir() {
			validSource = s
			break
		}
	}

	if validSource == "" {
		return jsonManagementResponse(http.StatusOK, map[string]interface{}{
			"success": false,
			"message": "Direct file copy unavailable in container. Please run the 1-line curl command.",
			"target":  selected.Path,
		})
	}

	_ = os.Remove(dest)
	if err := os.Symlink(validSource, dest); err != nil {
		return jsonManagementResponse(http.StatusInternalServerError, map[string]string{
			"error":   "symlink_failed",
			"message": fmt.Sprintf("failed to link extension: %v", err),
		})
	}

	return jsonManagementResponse(http.StatusOK, map[string]interface{}{
		"success": true,
		"message": fmt.Sprintf("Extensión instalada exitosamente en %s", dest),
		"target":  dest,
	})
}

func generatePairingBashScript(serverURL string) string {
	return fmt.Sprintf(`#!/usr/bin/env bash
# CPAMC Auto-Switcher Magic Pairing Installer
set -euo pipefail

echo "==> ⚡ CPAMC Auto-Switcher: Magic Pairing Express"

TARGET_URL="%s"
TARGET_DIR=""

if [ -f "$HOME/.gentle-shell/config.json" ]; then
    CONFIGURED_HOME=$(grep -o '"home": *"[^"]*"' "$HOME/.gentle-shell/config.json" | head -n1 | cut -d'"' -f4 || true)
    if [ -n "$CONFIGURED_HOME" ] && [ -d "$CONFIGURED_HOME" ]; then
        TARGET_DIR="${CONFIGURED_HOME}/extensions/cpamc-auto-switcher"
        SETTINGS_FILE="${CONFIGURED_HOME}/settings.json"
        echo "==> Conectando Gentle-Shell configurado (${CONFIGURED_HOME})"
    fi
fi
if [ -z "$TARGET_DIR" ]; then
    if [ -d "$HOME/.pi/gentle-shell" ]; then
        TARGET_DIR="$HOME/.pi/gentle-shell/extensions/cpamc-auto-switcher"
        SETTINGS_FILE="$HOME/.pi/gentle-shell/settings.json"
        echo "==> Conectando Gentle-Shell ($HOME/.pi/gentle-shell)"
    elif [ -d "$HOME/.gentle-shell/agent" ]; then
        TARGET_DIR="$HOME/.gentle-shell/agent/extensions/cpamc-auto-switcher"
        SETTINGS_FILE="$HOME/.gentle-shell/agent/settings.json"
        echo "==> Conectando Gentle-Shell ($HOME/.gentle-shell/agent)"
    elif [ -d "$HOME/.pi/agent" ]; then
        TARGET_DIR="$HOME/.pi/agent/extensions/cpamc-auto-switcher"
        SETTINGS_FILE="$HOME/.pi/agent/settings.json"
        echo "==> Conectando Pi ($HOME/.pi/agent)"
    elif [ -d "$HOME/.pi/agent-wilox" ]; then
        TARGET_DIR="$HOME/.pi/agent-wilox/extensions/cpamc-auto-switcher"
        SETTINGS_FILE="$HOME/.pi/agent-wilox/settings.json"
        echo "==> Conectando Wilox Pi ($HOME/.pi/agent-wilox)"
    elif [ -d "$HOME/.pi/agent-j0k3r" ]; then
        TARGET_DIR="$HOME/.pi/agent-j0k3r/extensions/cpamc-auto-switcher"
        SETTINGS_FILE="$HOME/.pi/agent-j0k3r/settings.json"
        echo "==> Conectando J0k3r Pi ($HOME/.pi/agent-j0k3r)"
    else
        TARGET_DIR="$HOME/.gentle-shell/agent/extensions/cpamc-auto-switcher"
        SETTINGS_FILE="$HOME/.gentle-shell/agent/settings.json"
        echo "==> Inicializando destino por defecto: Gentle-Shell"
    fi
fi

PARENT_DIR="$(dirname "$TARGET_DIR")"
mkdir -p "$PARENT_DIR"

# Persistir URL canónica
echo "$TARGET_URL" > "$HOME/.cliproxy_url"
chmod 600 "$HOME/.cliproxy_url" 2>/dev/null || true
echo "==> [✓] Endpoint CPAMC persistido: $TARGET_URL"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "==> Descargando suite de extensión desde repositorio oficial..."
if command -v git >/dev/null 2>&1; then
    git clone --depth 1 https://github.com/WiloxDev/cpamc-auto-switcher-pro.git "$TMP_DIR/repo" 2>/dev/null || true
fi

if [ -d "$TMP_DIR/repo/extensions/cpamc-auto-switcher" ]; then
    rm -rf "$TARGET_DIR"
    cp -r "$TMP_DIR/repo/extensions/cpamc-auto-switcher" "$TARGET_DIR"
    echo "==> ✅ Extensión enlazada con éxito en: $TARGET_DIR"
    echo "==> 🎉 ¡Pairing completado! Abre tu terminal con gentle-shell y escribe /model."
else
    echo "==> ⚠️ No se pudo clonar el repo directamente. Por favor instala la extensión en: $TARGET_DIR"
fi
`, serverURL)
}

func generateInstallerBashScript() string {
	return `#!/usr/bin/env bash
# CPAMC Auto-Switcher Universal Extension One-Click Installer
set -euo pipefail

echo "==> ⚡ CPAMC Auto-Switcher Extension Express Installer"

TARGET_DIR=""

if [ -f "$HOME/.gentle-shell/config.json" ]; then
    CONFIGURED_HOME=$(grep -o '"home": *"[^"]*"' "$HOME/.gentle-shell/config.json" | head -n1 | cut -d'"' -f4 || true)
    if [ -n "$CONFIGURED_HOME" ] && [ -d "$CONFIGURED_HOME" ]; then
        TARGET_DIR="${CONFIGURED_HOME}/extensions/cpamc-auto-switcher"
        echo "==> Detectado: Gentle-Shell configurado (${CONFIGURED_HOME})"
    fi
fi
if [ -z "$TARGET_DIR" ]; then
    if [ -d "$HOME/.pi/gentle-shell" ]; then
        TARGET_DIR="$HOME/.pi/gentle-shell/extensions/cpamc-auto-switcher"
        echo "==> Detectado: Gentle-Shell ($HOME/.pi/gentle-shell)"
    elif [ -d "$HOME/.gentle-shell/agent" ]; then
        TARGET_DIR="$HOME/.gentle-shell/agent/extensions/cpamc-auto-switcher"
        echo "==> Detectado: Gentle-Shell ($HOME/.gentle-shell/agent)"
    elif [ -d "$HOME/.pi/agent" ]; then
        TARGET_DIR="$HOME/.pi/agent/extensions/cpamc-auto-switcher"
        echo "==> Detectado: Pi ($HOME/.pi/agent)"
    elif [ -d "$HOME/.pi/agent-wilox" ]; then
        TARGET_DIR="$HOME/.pi/agent-wilox/extensions/cpamc-auto-switcher"
        echo "==> Detectado: Wilox Pi ($HOME/.pi/agent-wilox)"
    elif [ -d "$HOME/.pi/agent-j0k3r" ]; then
        TARGET_DIR="$HOME/.pi/agent-j0k3r/extensions/cpamc-auto-switcher"
        echo "==> Detectado: J0k3r Pi ($HOME/.pi/agent-j0k3r)"
    else
        TARGET_DIR="$HOME/.gentle-shell/agent/extensions/cpamc-auto-switcher"
        echo "==> Ningún agente detectado aún. Configurando destino por defecto: Gentle-Shell"
    fi
fi

PARENT_DIR="$(dirname "$TARGET_DIR")"
mkdir -p "$PARENT_DIR"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "==> Descargando suite de extensión desde CPAMC / GitHub..."

if command -v git >/dev/null 2>&1; then
    git clone --depth 1 https://github.com/WiloxDev/cpamc-auto-switcher-pro.git "$TMP_DIR/repo" 2>/dev/null || true
fi

if [ -d "$TMP_DIR/repo/extensions/cpamc-auto-switcher" ]; then
    rm -rf "$TARGET_DIR"
    cp -r "$TMP_DIR/repo/extensions/cpamc-auto-switcher" "$TARGET_DIR"
    echo "==> ✅ Extensión instalada con éxito en: $TARGET_DIR"
    echo "==> ¡Listo! Abre tu agente (gentle-shell o pi) y los modelos estarán enlazados automáticamente."
else
    echo "==> ⚠️ No se pudo descargar automáticamente vía git. Por favor copia la carpeta 'extensions/cpamc-auto-switcher' en $PARENT_DIR"
fi
`
}
