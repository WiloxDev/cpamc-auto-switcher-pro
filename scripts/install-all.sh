#!/usr/bin/env bash
# ==============================================================================
# CPAMC AUTO-SWITCHER · UNIVERSAL ALL-IN-ONE INSTALLER
# Soporta: Local Docker, WSL, Servidor LAN y VPS Remoto en la Nube
# ==============================================================================

set -euo pipefail

# Colores y Formato
BOLD="\033[1m"
GREEN="\033[0;32m"
CYAN="\033[0;36m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
MAGENTA="\033[0;35m"
ITALIC="\033[3m"
RESET="\033[0m"

REPO_URL="https://github.com/WiloxDev/cpamc-auto-switcher-pro"
DEFAULT_URL="http://localhost:8317"

# Variables de configuración con soporte para Flags y Env Vars
TARGET_URL="${CPAMC_URL:-${CLIPROXYAPI_BASE_URL:-}}"
TARGET_KEY="${CPAMC_KEY:-${CLIPROXYAPI_MANAGEMENT_KEY:-}}"
NON_INTERACTIVE=false
INSTALL_PLUGIN_ONLY=false
INSTALL_EXTENSION_ONLY=false
DOCKER_FOUND=false
DOCKER_CONTAINER=""
DOCKER_PORT=""
DOCKER_PLUGINS_HOST=""
DOCKER_CONFIG_HOST=""
PROCESS_FOUND=false
PROCESS_PORT=""

print_banner() {
    cat << "EOF"
  ██████╗██████╗  █████╗ ███╗   ███╗ ██████╗ 
 ██╔════╝██╔══██╗██╔══██╗████╗ ████║██╔════╝ 
 ██║     ██████╔╝███████║██╔████╔██║██║      
 ██║     ██╔═══╝ ██╔══██║██║╚██╔╝██║██║      
 ╚██████╗██║     ██║  ██║██║ ╚═╝ ██║╚██████╗ 
  ╚═════╝╚═╝     ╚═╝  ╚═╝╚═╝     ╚═╝ ╚═════╝ 
  ⚡ AUTO-SWITCHER PRO · ALL-IN-ONE INSTALLER ⚡
EOF
    echo -e "${CYAN}Suite Oficial: Plugin CPAMC (.so) + Extensión Pi / Gentle-Shell${RESET}\n"
}

show_help() {
    print_banner
    cat << EOF
Uso:
  curl -sSL <url>/install-all.sh | bash [opciones]

Opciones:
  -u, --url <url>      URL del servidor CPAMC (ej: http://localhost:8317, http://192.168.1.100:8317, https://vps.com:8317)
  -k, --key <key>      Management Key o API Key de CPAMC (opcional si no requiere autenticación)
  -y, --yes            Modo no interactivo: aplica valores detectados o por defecto sin preguntar
      --plugin-only    Instalar única y exclusivamente el plugin .so en CPAMC
      --ext-only       Instalar única y exclusivamente la extensión del agente en Pi / Gentle-Shell
  -h, --help           Muestra esta ayuda

Variables de Entorno:
  CPAMC_URL            URL base de CPAMC
  CPAMC_KEY            Clave de administración de CPAMC

Ejemplos:
  1. Instalación estándar local (automática):
     bash scripts/install-all.sh

  2. Conectar agente local a un VPS remoto:
     bash scripts/install-all.sh --url "https://ai.midominio.com:8317" --key "mi-secreto"

  3. Servidor en Red Local (LAN):
     bash scripts/install-all.sh --url "http://192.168.1.100:8317"
EOF
    exit 0
}

# Procesar argumentos de línea de comandos
while [[ $# -gt 0 ]]; do
    case "$1" in
        -u|--url)
            TARGET_URL="$2"
            shift 2
            ;;
        -k|--key)
            TARGET_KEY="$2"
            shift 2
            ;;
        -y|--yes)
            NON_INTERACTIVE=true
            shift
            ;;
        --plugin-only)
            INSTALL_PLUGIN_ONLY=true
            shift
            ;;
        --ext-only)
            INSTALL_EXTENSION_ONLY=true
            shift
            ;;
        -h|--help)
            show_help
            ;;
        *)
            echo -e "${RED}[ERROR] Opción desconocida: $1${RESET}" >&2
            echo "Usa --help para ver las opciones disponibles." >&2
            exit 1
            ;;
    esac
done

# ------------------------------------------------------------------------------
# 1. DETECCIÓN DEL ENTORNO LOCAL Y CPAMC
# ------------------------------------------------------------------------------
detect_local_cpamc() {
    DOCKER_FOUND=false
    DOCKER_CONTAINER=""
    DOCKER_PORT=""
    DOCKER_PLUGINS_HOST=""
    DOCKER_CONFIG_HOST=""
    PROCESS_FOUND=false
    PROCESS_PORT=""

    # 1. Detección Docker / Podman
    if command -v docker >/dev/null 2>&1; then
        local cid
        cid=$(docker ps -q -f name=cli-proxy-api 2>/dev/null || true)
        if [ -n "$cid" ]; then
            DOCKER_FOUND=true
            DOCKER_CONTAINER="cli-proxy-api"
            
            # Detectar puerto host mapeado
            local p
            p=$(docker inspect "$cid" --format '{{(index (index .NetworkSettings.Ports "8317/tcp") 0).HostPort}}' 2>/dev/null || true)
            if [ -n "$p" ]; then
                DOCKER_PORT="$p"
            else
                DOCKER_PORT="8317"
            fi

            # Extraer volumen bind de plugins y config.yaml
            local inspect_mounts
            inspect_mounts=$(docker inspect "$cid" --format '{{json .Mounts}}' 2>/dev/null || true)
            if [ -n "$inspect_mounts" ]; then
                DOCKER_PLUGINS_HOST=$(echo "$inspect_mounts" | grep -o '"Source":"[^"]*","Destination":"/CLIProxyAPI/plugins"' | cut -d'"' -f4 || true)
                DOCKER_CONFIG_HOST=$(echo "$inspect_mounts" | grep -o '"Source":"[^"]*","Destination":"/CLIProxyAPI/config.yaml"' | cut -d'"' -f4 || true)
            fi
        fi
    fi

    # 2. Detección de Procesos Locales en RAM (cli-proxy-api / CLIProxyAPI)
    if [ "$DOCKER_FOUND" = false ]; then
        local pids
        pids=$(pgrep -f "cli-proxy-api" 2>/dev/null || pgrep -f "CLIProxyAPI" 2>/dev/null || true)
        if [ -n "$pids" ]; then
            PROCESS_FOUND=true
            local detected_port=""
            if command -v ss >/dev/null 2>&1; then
                detected_port=$(ss -tulpn 2>/dev/null | grep -E "cli-proxy|CLIProxy" | grep -oE ":[0-9]+" | head -n1 | tr -d ":" || true)
            fi
            if [ -z "$detected_port" ] && command -v lsof >/dev/null 2>&1; then
                detected_port=$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E "cli-proxy|CLIProxy" | grep -oE ":[0-9]+" | head -n1 | tr -d ":" || true)
            fi
            PROCESS_PORT="${detected_port:-8317}"
        fi
    fi
}

# ------------------------------------------------------------------------------
# 1.1. BOOTSTRAP AUTOMÁTICO DE CPAMC OFICIAL (router-for-me/CLIProxyAPI)
# ------------------------------------------------------------------------------
bootstrap_official_cpamc() {
    local arch="amd64"
    local uname_m
    uname_m=$(uname -m)
    if [ "$uname_m" = "aarch64" ] || [ "$uname_m" = "arm64" ]; then
        arch="arm64"
    fi

    echo -e "\n${CYAN}================================================================${RESET}"
    echo -e "${BOLD}⚡ AUTO-DESPLIEGUE DE CPAMC OFICIAL (CLIProxyAPI v8+)${RESET}"
    echo -e "${CYAN}================================================================${RESET}"
    echo -e "Origen oficial: ${BOLD}https://github.com/router-for-me/CLIProxyAPI${RESET}"

    local cpamc_home="$HOME/cliproxyapi"
    mkdir -p "$cpamc_home/plugins" 2>/dev/null || true
    mkdir -p "$HOME/.cli-proxy-api" 2>/dev/null || true

    # 1. Generar Claves Criptográficas Seguras (Dual: Admin v8 + Consumo API)
    local gen_mgmt_key=""
    local gen_api_key=""
    if command -v openssl >/dev/null 2>&1; then
        gen_mgmt_key=$(openssl rand -hex 16)
        gen_api_key="sk-$(openssl rand -hex 16)"
    else
        gen_mgmt_key=$(head -c 16 /dev/urandom 2>/dev/null | od -An -tx1 | tr -d ' \n' || echo "cpa_mgmt_$(date +%s)")
        gen_api_key="sk-$(head -c 16 /dev/urandom 2>/dev/null | od -An -tx1 | tr -d ' \n' || echo "cpa_api_$(date +%s)")"
    fi
    TARGET_KEY="${TARGET_KEY:-$gen_mgmt_key}"
    TARGET_API_KEY="${TARGET_API_KEY:-$gen_api_key}"

    # Guardar localmente ambas claves en archivos protegidos
    echo "$TARGET_KEY" > "$HOME/.cliproxy_management_key" 2>/dev/null || true
    chmod 600 "$HOME/.cliproxy_management_key" 2>/dev/null || true
    echo "$TARGET_API_KEY" > "$HOME/.cliproxy_api_key" 2>/dev/null || true
    chmod 600 "$HOME/.cliproxy_api_key" 2>/dev/null || true

    # 2. Generar config.yaml inicial con plugins y claves canónicas de CPAMC v8 si no existe
    local config_file="$cpamc_home/config.yaml"
    if [ ! -f "$config_file" ]; then
        cat << EOC > "$config_file"
server:
  port: 8317
management:
  secret-key: "${TARGET_KEY}"
api-keys:
  - "${TARGET_API_KEY}"
plugins:
  enabled: true
  dir: plugins
  configs:
    auto-switcher-pro-linux-${arch}:
      enabled: true
EOC
        chmod 600 "$config_file" 2>/dev/null || true
        echo -e "${GREEN}    [✓] Archivo config.yaml inicial generado con claves de administración (v8) y API separadas.${RESET}"
    fi

    # 3. Copiar plugin Auto Switcher Pro (.so)
    local repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd || true)"
    local so_name="auto-switcher-pro-linux-${arch}.so"
    local local_so="${repo_root}/bin/${so_name}"
    if [ -f "$local_so" ]; then
        cp -f "$local_so" "$cpamc_home/plugins/${so_name}"
    else
        curl -sSL -f -o "$cpamc_home/plugins/${so_name}" "${REPO_URL}/raw/main/bin/${so_name}" 2>/dev/null || true
    fi
    chmod 755 "$cpamc_home/plugins/${so_name}" 2>/dev/null || true

    # 4. Despliegue de servicio: Vía Docker (preferente) o Binario Nativo
    if command -v docker >/dev/null 2>&1; then
        echo -e "Levantando contenedor Docker oficial ${BOLD}eceasy/cli-proxy-api:latest${RESET}..."
        docker rm -f cli-proxy-api >/dev/null 2>&1 || true
        if docker run -d --name cli-proxy-api --restart always \
            -p 8317:8317 \
            -v "$cpamc_home/config.yaml:/CLIProxyAPI/config.yaml" \
            -v "$cpamc_home/plugins:/CLIProxyAPI/plugins" \
            -v "$HOME/.cli-proxy-api:/root/.cli-proxy-api" \
            eceasy/cli-proxy-api:latest >/dev/null 2>&1; then
            echo -e "${GREEN}    [✓] Contenedor oficial cli-proxy-api iniciado y escuchando en :8317.${RESET}"
            DOCKER_FOUND=true
            DOCKER_CONTAINER="cli-proxy-api"
            DOCKER_PORT="8317"
            DOCKER_PLUGINS_HOST="$cpamc_home/plugins"
            DOCKER_CONFIG_HOST="$cpamc_home/config.yaml"
            TARGET_URL="http://localhost:8317"
            sleep 2
            return 0
        fi
    fi

    # Si Docker no está disponible, descargar binario oficial de GitHub Releases
    echo -e "Descargando binario oficial de CLIProxyAPI desde GitHub Releases..."
    local api_releases="https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest"
    local pattern="CLIProxyAPI_.*_linux_${arch}\.tar\.gz"
    if [ "$(uname)" = "Darwin" ]; then
        pattern="CLIProxyAPI_.*_darwin_${arch}\.tar\.gz"
    fi

    local dl_url=""
    dl_url=$(curl -sSL "$api_releases" 2>/dev/null | grep "browser_download_url" | grep -E "$pattern" | grep -v "no-plugin" | head -n1 | cut -d'"' -f4 || true)

    if [ -n "$dl_url" ]; then
        local tmp_tar
        tmp_tar="$(mktemp)"
        echo -e "Descargando paquete oficial: ${CYAN}${dl_url}${RESET}..."
        if curl -sSL -f -o "$tmp_tar" "$dl_url"; then
            tar -xzf "$tmp_tar" -C "$cpamc_home"
            rm -f "$tmp_tar"
            chmod +x "$cpamc_home/cli-proxy-api" 2>/dev/null || true
            echo -e "${GREEN}    [✓] Binario oficial CLIProxyAPI instalado en ${cpamc_home}.${RESET}"

            # Iniciar proceso en segundo plano
            nohup "$cpamc_home/cli-proxy-api" -config "$config_file" > "$cpamc_home/cliproxy.log" 2>&1 &
            sleep 2
            TARGET_URL="http://localhost:8317"
            PROCESS_FOUND=true
            PROCESS_PORT="8317"
            return 0
        fi
        rm -f "$tmp_tar" 2>/dev/null || true
    fi

    echo -e "${YELLOW}    [!] No se pudo descargar automáticamente el binario oficial de CPAMC.${RESET}"
    return 1
}

# ------------------------------------------------------------------------------
# 2. ASISTENTE GUIADO DE CONEXIÓN (BOUNDED DISCOVERY / LAN / VPS)
# ------------------------------------------------------------------------------
resolve_connectivity() {
    if [ -n "$TARGET_URL" ]; then
        TARGET_URL="${TARGET_URL%/}"
        TARGET_URL="${TARGET_URL%/v1}"
        return 0
    fi

    # Sondeo acotado ultrarrápido (timeout 800ms) sobre candidatos deterministas (cero escaneos ciegos)
    local candidate_urls=()
    if [ "$DOCKER_FOUND" = true ]; then
        candidate_urls+=("http://localhost:${DOCKER_PORT:-8317}")
    fi
    if [ "$PROCESS_FOUND" = true ]; then
        candidate_urls+=("http://localhost:${PROCESS_PORT:-8317}")
    fi
    if [ -f "$HOME/.cliproxy_url" ]; then
        local saved_url
        saved_url=$(cat "$HOME/.cliproxy_url" 2>/dev/null | tr -d '\r\n')
        [ -n "$saved_url" ] && candidate_urls+=("$saved_url")
    fi
    candidate_urls+=("http://localhost:8317")
    candidate_urls+=("http://127.0.0.1:8317")

    # Si corre en WSL2, añadir gateway de host Windows
    if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi "microsoft" /proc/version 2>/dev/null; then
        local wsl_gw
        wsl_gw=$(ip route show default 2>/dev/null | awk '{print $3}' || true)
        [ -n "$wsl_gw" ] && candidate_urls+=("http://${wsl_gw}:8317")
        candidate_urls+=("http://host.docker.internal:8317")
    fi

    echo -e "🔍 Verificando candidatos locales..."
    for cand in "${candidate_urls[@]}"; do
        local clean_cand="${cand%/}"
        clean_cand="${clean_cand%/v1}"
        local code=""
        code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 0.8 -m 1.5 "${clean_cand}/v1/models" 2>/dev/null || true)
        if [ "$code" = "200" ] || [ "$code" = "401" ] || [ "$code" = "403" ]; then
            TARGET_URL="$clean_cand"
            echo -e "${GREEN}    [✓] Servidor CPAMC detectado en:${RESET} ${BOLD}${TARGET_URL}${RESET}"
            break
        fi
    done

    if [ -n "$TARGET_URL" ]; then
        if [ "$NON_INTERACTIVE" = true ]; then
            [ -z "$TARGET_KEY" ] && [ -f "$HOME/.cliproxy_management_key" ] && TARGET_KEY=$(cat "$HOME/.cliproxy_management_key" 2>/dev/null | tr -d '\r\n')
            return 0
        fi

        echo -e "\n${BOLD}¿Deseas conectar tu agente a esta instancia activa detectada?${RESET}"
        local confirm_use=""
        read -r -p "👉 [S/n] (por defecto: S): " confirm_use
        confirm_use="${confirm_use:-S}"
        if [[ "$confirm_use" =~ ^[SsYy]$ ]]; then
            if [ -z "$TARGET_KEY" ] && [ -f "$HOME/.cliproxy_management_key" ]; then
                TARGET_KEY=$(cat "$HOME/.cliproxy_management_key" 2>/dev/null | tr -d '\r\n')
            fi
            return 0
        fi
        TARGET_URL=""
    fi

    if [ "$DOCKER_FOUND" = true ]; then
        echo -e "${GREEN}ℹ️  Contenedor Docker local detectado:${RESET} ${BOLD}${DOCKER_CONTAINER}${RESET} (Puerto: ${CYAN}${DOCKER_PORT}${RESET})"
    elif [ "$PROCESS_FOUND" = true ]; then
        echo -e "${GREEN}ℹ️  Proceso CPAMC detectado en RAM${RESET} (Puerto: ${CYAN}${PROCESS_PORT}${RESET})"
    else
        echo -e "${YELLOW}ℹ️  No se detectó un servidor CPAMC en localhost.${RESET}"
    fi

    echo -e "${BOLD}¿Dónde está alojado tu servidor CPAMC?${RESET}"
    echo -e "  ${CYAN}[1]${RESET} Descargar e instalar CPAMC oficial automáticamente (${GREEN}router-for-me/CLIProxyAPI${RESET})"
    echo -e "  ${CYAN}[2]${RESET} Localhost estándar (${GREEN}http://localhost:${DOCKER_PORT:-${PROCESS_PORT:-8317}}${RESET})"
    echo -e "  ${CYAN}[3]${RESET} Servidor en Red Local / LAN (${YELLOW}ej: http://192.168.1.100:8317${RESET})"
    echo -e "  ${CYAN}[4]${RESET} VPS / Servidor Remoto en la Nube (${MAGENTA}ej: https://vps.midominio.com:8317${RESET})"
    echo -e "  ${CYAN}[5]${RESET} Modo solo cliente (instalar únicamente extensión de Gentle-Shell)"
    echo -e "  ${CYAN}[6]${RESET} Escribir URL personalizada manualmente"
    echo ""

    local choice=""
    if [ "$NON_INTERACTIVE" = true ]; then
        choice="1"
    else
        read -r -p "👉 Selecciona una opción [1-6] (por defecto: 1): " choice
        choice="${choice:-1}"
    fi

    case "$choice" in
        1)
            bootstrap_official_cpamc || TARGET_URL="http://localhost:8317"
            ;;
        2)
            TARGET_URL="http://localhost:${DOCKER_PORT:-${PROCESS_PORT:-8317}}"
            ;;
        3)
            echo ""
            echo -e "${YELLOW}📌 Ejemplo para Red Local:${RESET} http://192.168.1.100:8317"
            read -r -p "✍️  Ingresa la IP y puerto de tu CPAMC: " input_url
            TARGET_URL="${input_url:-http://192.168.1.100:8317}"
            ;;
        4)
            echo ""
            echo -e "${MAGENTA}📌 Ejemplos para VPS / Remoto:${RESET}"
            echo -e "   - https://cpamc.midominio.com"
            echo -e "   - http://vps-servidor.xyz:8317"
            read -r -p "✍️  Ingresa la URL pública o dominio de tu VPS: " input_url
            TARGET_URL="${input_url:-https://vps.midominio.com:8317}"
            ;;
        5)
            INSTALL_EXTENSION_ONLY=true
            read -r -p "✍️  Ingresa la URL de tu CPAMC remoto: " input_url
            TARGET_URL="${input_url:-http://localhost:8317}"
            ;;
        6)
            read -r -p "✍️  Ingresa la URL completa de CPAMC: " input_url
            TARGET_URL="${input_url:-http://localhost:8317}"
            ;;
        *)
            bootstrap_official_cpamc || TARGET_URL="http://localhost:8317"
            ;;
    esac

    # Limpiar formato
    TARGET_URL="${TARGET_URL%/}"
    TARGET_URL="${TARGET_URL%/v1}"

    # Preguntar Management Key si no fue provista
    if [ -z "$TARGET_KEY" ] && [ -f "$HOME/.cliproxy_management_key" ]; then
        TARGET_KEY=$(cat "$HOME/.cliproxy_management_key" 2>/dev/null | tr -d '\r\n')
    fi

    if [ -z "$TARGET_KEY" ] && [ "$NON_INTERACTIVE" = false ]; then
        echo ""
        echo -e "${CYAN}🔑 Autenticación Administrativa (Management Key):${RESET}"
        echo -e "   (Nota: Es la clave de gestión para consultar pools y cuotas, NO la API key de modelos)"
        read -r -p "Ingresa tu Management Key (Enter para omitir si no requiere): " input_key
        TARGET_KEY="$input_key"
    fi
}

# ------------------------------------------------------------------------------
# 3. VERIFICACIÓN DE CONECTIVIDAD
# ------------------------------------------------------------------------------
verify_connection() {
    echo -e "\n${CYAN}==> Verificando conectividad con CPAMC en: ${BOLD}${TARGET_URL}${RESET}..."
    local check_endpoint="${TARGET_URL}/v1/models"
    local http_code=""

    if command -v curl >/dev/null 2>&1; then
        http_code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 4 "${check_endpoint}" || true)
    fi

    if [ "$http_code" = "200" ] || [ "$http_code" = "401" ] || [ "$http_code" = "403" ]; then
        echo -e "${GREEN}    [✓] Conexión establecida con éxito (HTTP ${http_code})${RESET}"
    else
        echo -e "${YELLOW}    [!] Advertencia: No se pudo verificar respuesta inmediata en ${check_endpoint} (HTTP ${http_code:-timeout}).${RESET}"
        echo -e "        Continuando la instalación con el endpoint configurado."
    fi

    # Persistir endpoint y key en archivos canónicos con permisos 600
    echo "${TARGET_URL}" > "${HOME}/.cliproxy_url"
    chmod 600 "${HOME}/.cliproxy_url" 2>/dev/null || true
    if [ -n "$TARGET_KEY" ]; then
        echo "${TARGET_KEY}" > "${HOME}/.cliproxy_management_key"
        chmod 600 "${HOME}/.cliproxy_management_key" 2>/dev/null || true
    fi
}

# ------------------------------------------------------------------------------
# 4. INSTALACIÓN DEL PLUGIN CPAMC (.so)
# ------------------------------------------------------------------------------
install_plugin() {
    if [ "$INSTALL_EXTENSION_ONLY" = true ]; then
        return 0
    fi

    echo -e "\n${CYAN}================================================================${RESET}"
    echo -e "${BOLD}PASO 1: INSTALACIÓN DEL PLUGIN CPAMC (Auto Switcher Pro)${RESET}"
    echo -e "${CYAN}================================================================${RESET}"

    local plugin_target_dir=""
    local config_file=""

    if [ "$DOCKER_FOUND" = true ] && [ -n "$DOCKER_PLUGINS_HOST" ] && [ -d "$DOCKER_PLUGINS_HOST" ]; then
        plugin_target_dir="$DOCKER_PLUGINS_HOST"
        config_file="$DOCKER_CONFIG_HOST"
        echo -e "Detectado directorio de plugins en Docker: ${GREEN}${plugin_target_dir}${RESET}"
    elif [ -d "$HOME/services/cliproxy/plugins" ]; then
        plugin_target_dir="$HOME/services/cliproxy/plugins"
        config_file="$HOME/services/cliproxy/config.yaml"
    elif [ -d "./plugins" ]; then
        plugin_target_dir="$(pwd)/plugins"
        config_file="$(pwd)/config.yaml"
    else
        echo -e "${YELLOW}ℹ️  No se detectó directorio de plugins local de CPAMC en esta máquina.${RESET}"
        echo -e "   Si este host es solo el cliente (donde corre el agente) y CPAMC está en un VPS,"
        echo -e "   el plugin ya debe estar instalado en tu servidor CPAMC."
        return 0
    fi

    # Detectar arquitectura
    local arch="amd64"
    local uname_m
    uname_m=$(uname -m)
    if [ "$uname_m" = "aarch64" ] || [ "$uname_m" = "arm64" ]; then
        arch="arm64"
    fi
    local so_name="auto-switcher-pro-linux-${arch}.so"

    echo -e "Copiando/actualizando plugin ${BOLD}${so_name}${RESET} en ${plugin_target_dir}..."

    # Buscar binario compilado localmente si estamos en el repositorio
    local repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd || true)"
    local local_so="${repo_root}/bin/${so_name}"
    local tmp_so="${plugin_target_dir}/${so_name}.tmp.$$"
    local old_so="${plugin_target_dir}/${so_name}.old"

    if [ -f "$local_so" ]; then
        cp -f "$local_so" "$tmp_so"
        echo -e "${GREEN}    [✓] Plugin preparado desde binario local compilado.${RESET}"
    else
        echo -e "Descargando plugin binario precompilado desde GitHub..."
        local ref="${INSTALL_REF:-main}"
        local dl_url="${REPO_URL}/raw/${ref}/bin/${so_name}"
        local sha_url="${REPO_URL}/raw/${ref}/bin/${so_name}.sha256"
        if curl -sSL -f -o "$tmp_so" "$dl_url" 2>/dev/null; then
            echo -e "${GREEN}    [✓] Plugin descargado con éxito.${RESET}"
            # Verificación de integridad SHA256 si existe checksum publicado
            local tmp_sha="${tmp_so}.sha256"
            if curl -sSL -f -o "$tmp_sha" "$sha_url" 2>/dev/null; then
                echo -e "    Validando integridad criptográfica SHA256..."
                local expected_hash actual_hash
                expected_hash=$(awk '{print $1}' "$tmp_sha")
                actual_hash=$(sha256sum "$tmp_so" | awk '{print $1}')
                if [ -n "$expected_hash" ] && [ "$expected_hash" = "$actual_hash" ]; then
                    echo -e "${GREEN}    [✓] Integridad SHA256 verificada con éxito (${actual_hash:0:16}...)${RESET}"
                else
                    echo -e "${RED}    [✗] Error de seguridad: El hash SHA256 del binario no coincide.${RESET}"
                    echo -e "        Esperado: ${expected_hash}"
                    echo -e "        Obtenido: ${actual_hash}"
                    rm -f "$tmp_so" "$tmp_sha"
                    return 1
                fi
                rm -f "$tmp_sha"
            fi
        else
            echo -e "${YELLOW}    [!] No se pudo descargar directamente desde raw GitHub.${RESET}"
            echo -e "    Por favor compila localmente con './scripts/build-plugin.sh ${arch}' si eres desarrollador."
            rm -f "$tmp_so"
            return 1
        fi
    fi

    chmod 755 "$tmp_so" 2>/dev/null || true

    # Hot-Swap Seguro de Inodo (Evita SIGSEGV en Linux y bloqueos en caliente)
    if [ -f "${plugin_target_dir}/${so_name}" ]; then
        mv -f "${plugin_target_dir}/${so_name}" "$old_so" 2>/dev/null || true
    fi
    mv -f "$tmp_so" "${plugin_target_dir}/${so_name}"
    rm -f "$old_so" 2>/dev/null || true
    echo -e "${GREEN}    [✓] Binario CGO desplegado mediante sustitución atómica de inodo.${RESET}"

    # Asegurar permisos saludables en directorio de almacenamiento para SQLite WAL
    chmod 775 "${plugin_target_dir}" 2>/dev/null || true

    # Configuración atómica en config.yaml si existe
    if [ -f "$config_file" ]; then
        if ! grep -q "auto-switcher-pro-linux-${arch}" "$config_file"; then
            echo -e "Habilitando plugin en ${config_file}..."
            cp "$config_file" "${config_file}.bak-pre-auto-switcher"
            if grep -q "plugins:" "$config_file"; then
                # Añadir config bajo sección plugins
                sed -i "/configs:/a \        auto-switcher-pro-linux-${arch}:\n            enabled: true" "$config_file" 2>/dev/null || true
            else
                # Crear sección completa
                cat << EOY >> "$config_file"

plugins:
    enabled: true
    dir: plugins
    configs:
        auto-switcher-pro-linux-${arch}:
            enabled: true
EOY
            fi
            echo -e "${GREEN}    [✓] Entrada activada en config.yaml (respaldo guardado en .bak).${RESET}"
        else
            echo -e "${GREEN}    [✓] Plugin ya se encuentra activado en config.yaml.${RESET}"
        fi
    fi

    # Reiniciar Docker si aplica
    if [ "$DOCKER_FOUND" = true ]; then
        echo -e "Reiniciando contenedor ${DOCKER_CONTAINER} para cargar el nuevo plugin..."
        docker restart "$DOCKER_CONTAINER" >/dev/null 2>&1 || true
        echo -e "${GREEN}    [✓] Contenedor reiniciado con éxito.${RESET}"
    fi
}

# ------------------------------------------------------------------------------
# 5. INSTALACIÓN DE LA EXTENSIÓN PI / GENTLE-SHELL
# ------------------------------------------------------------------------------
install_extension() {
    if [ "$INSTALL_PLUGIN_ONLY" = true ]; then
        return 0
    fi

    echo -e "\n${CYAN}================================================================${RESET}"
    echo -e "${BOLD}PASO 2: INSTALACIÓN DE LA EXTENSIÓN DEL AGENTE (Pi & Gentle-Shell)${RESET}"
    echo -e "${CYAN}================================================================${RESET}"

    # Detectar agentes instalados
    local target_agent_dirs=()

    # Detección de Gentle-Shell según configuración activa (~/.gentle-shell/config.json)
    if [ -f "$HOME/.gentle-shell/config.json" ]; then
        local configured_home
        configured_home=$(grep -o '"home": *"[^"]*"' "$HOME/.gentle-shell/config.json" | head -n1 | cut -d'"' -f4 || true)
        if [ -n "$configured_home" ] && [ -d "$configured_home" ]; then
            target_agent_dirs+=("$configured_home")
            echo -e "Detectado agente: ${GREEN}Gentle Shell (configurado)${RESET} (${configured_home})"
        fi
    fi

    if [ -d "$HOME/.pi/gentle-shell" ]; then
        if [[ ! " ${target_agent_dirs[*]} " =~ " $HOME/.pi/gentle-shell " ]]; then
            target_agent_dirs+=("$HOME/.pi/gentle-shell")
            echo -e "Detectado agente: ${GREEN}Gentle Shell${RESET} (~/.pi/gentle-shell)"
        fi
    fi
    if [ -d "$HOME/.gentle-shell/agent" ]; then
        if [[ ! " ${target_agent_dirs[*]} " =~ " $HOME/.gentle-shell/agent " ]]; then
            target_agent_dirs+=("$HOME/.gentle-shell/agent")
            echo -e "Detectado agente: ${GREEN}Gentle Shell (legado/agent)${RESET} (~/.gentle-shell/agent)"
        fi
    fi
    if [ -d "$HOME/.pi/agent" ]; then
        target_agent_dirs+=("$HOME/.pi/agent")
        echo -e "Detectado agente: ${GREEN}Pi Vanilla${RESET} (~/.pi/agent)"
    fi
    if [ -d "$HOME/.pi/agent-wilox" ]; then
        target_agent_dirs+=("$HOME/.pi/agent-wilox")
        echo -e "Detectado agente: ${GREEN}Wilox Pi${RESET} (~/.pi/agent-wilox)"
    elif [ -d "$HOME/.pi/agent-j0k3r" ]; then
        target_agent_dirs+=("$HOME/.pi/agent-j0k3r")
        echo -e "Detectado agente legado: ${YELLOW}Wilox/J0k3r Pi${RESET} (~/.pi/agent-j0k3r)"
    fi

    # Si ninguno existe aún, preparar Gentle-Shell por defecto
    if [ ${#target_agent_dirs[@]} -eq 0 ]; then
        local def_dir="$HOME/.gentle-shell/agent"
        mkdir -p "$def_dir"
        target_agent_dirs+=("$def_dir")
        echo -e "${YELLOW}ℹ️  No se detectaron agentes previos. Inicializando Gentle-Shell (~/.gentle-shell/agent)${RESET}"
    fi

    # Origen de la extensión y agentes
    local repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd || true)"
    local local_ext_src="${repo_root}/extensions/cpamc-auto-switcher"
    local local_subagents_src="${repo_root}/subagents"
    local local_agents_src="${repo_root}/agents"
    local local_skills_src="${repo_root}/skills"
    local tmp_dir=""

    if [ ! -d "$local_ext_src" ]; then
        tmp_dir=$(mktemp -d)
        echo "Descargando paquete de extensión desde GitHub..."
        if command -v git >/dev/null 2>&1; then
            git clone --depth 1 "$REPO_URL.git" "$tmp_dir/repo" >/dev/null 2>&1 || true
            local_ext_src="$tmp_dir/repo/extensions/cpamc-auto-switcher"
            local_subagents_src="$tmp_dir/repo/subagents"
            local_agents_src="$tmp_dir/repo/agents"
            local_skills_src="$tmp_dir/repo/skills"
        fi
    fi

    # Instalar en cada agente detectado
    for agent_home in "${target_agent_dirs[@]}"; do
        local ext_dir="${agent_home}/extensions"
        mkdir -p "$ext_dir"

        # Auto-limpieza proactiva de respaldos residuales que Gentle-Shell cargue por colisión
        local backup_dir="${agent_home}/backups/extensions"
        mkdir -p "$backup_dir"
        find "$ext_dir" -maxdepth 1 -type d -name "cpamc-auto-switcher.bak*" 2>/dev/null | while read -r old_bak; do
            if [ -d "$old_bak" ]; then
                mv "$old_bak" "$backup_dir/" 2>/dev/null || true
                echo -e "    ${YELLOW}🧹 Respaldo duplicado evacuado automáticamente a: ${backup_dir}/${RESET}"
            fi
        done

        local ext_dest="${ext_dir}/cpamc-auto-switcher"

        if [ -d "$local_ext_src" ]; then
            if [ -d "$ext_dest" ]; then
                local ts=$(date +%Y%m%d-%H%M%S)
                mv "$ext_dest" "${backup_dir}/cpamc-auto-switcher.bak-${ts}" 2>/dev/null || rm -rf "$ext_dest"
            fi
            cp -r "$local_ext_src" "$ext_dest"
            echo -e "${GREEN}    [✓] Extensión instalada en: ${ext_dest}${RESET}"
        else
            echo -e "${RED}    [ERROR] No se pudo encontrar el origen de extensions/cpamc-auto-switcher.${RESET}"
        fi

        # Aprovisionar subagentes de Planned Workflow
        if [ -d "$local_subagents_src" ]; then
            mkdir -p "${agent_home}/subagents"
            cp -r "$local_subagents_src"/* "${agent_home}/subagents/" 2>/dev/null || true
            echo -e "${GREEN}    [✓] Subagentes Planned Workflow sincronizados en: ${agent_home}/subagents${RESET}"
        fi

        # Aprovisionar agentes de Gentle AI
        if [ -d "$local_agents_src" ]; then
            mkdir -p "${agent_home}/agents"
            cp -r "$local_agents_src"/* "${agent_home}/agents/" 2>/dev/null || true
            echo -e "${GREEN}    [✓] Agentes Gentle AI sincronizados en: ${agent_home}/agents${RESET}"
        fi

        # Aprovisionar skills transversales (Anti-Overengineering)
        if [ -d "$local_skills_src" ]; then
            mkdir -p "${agent_home}/skills"
            cp -r "$local_skills_src"/* "${agent_home}/skills/" 2>/dev/null || true
            echo -e "${GREEN}    [✓] Skills transversales sincronizados en: ${agent_home}/skills${RESET}"
        fi

        # Persistir configuración en settings.json del agente de forma inmune y permanente
        local settings_file="${agent_home}/settings.json"
        local eff_key="${TARGET_API_KEY:-$TARGET_KEY}"
        echo -e "    Configurando endpoint permanente en ${BOLD}${settings_file}${RESET}..."
        
        # Si settings.json no existe o está vacío, inicializarlo
        if [ ! -s "$settings_file" ]; then
            echo "{}" > "$settings_file"
        fi

        # Inyección limpia usando node o python si están disponibles
        if command -v node >/dev/null 2>&1; then
            node -e "
                const fs = require('fs');
                const file = process.argv[1];
                const url = process.argv[2];
                const apiKey = process.argv[3];
                const mgmtKey = process.argv[4];
                let data = {};
                try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e){}
                data.cpamc = data.cpamc || {};
                data.cpamc.baseUrl = url;
                if (apiKey) data.cpamc.apiKey = apiKey;
                if (mgmtKey) data.cpamc.managementKey = mgmtKey;
                fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
            " "$settings_file" "$TARGET_URL" "$eff_key" "$TARGET_KEY" 2>/dev/null || true
        fi

        # Configuración inicial de estilo de QuotaCard (Esencial Default vs Pro Pestañas)
        local pref_file="${agent_home}/cpamc-preferences.json"
        if [ ! -f "$pref_file" ]; then
            echo '{"viewMode":"essential","activeTab":"quota"}' > "$pref_file"
            echo -e "    ${CYAN}[i] QuotaCard inicializada en Modo Esencial / Compacto (Default).${RESET}"
            echo -e "        ↳ ${ITALIC}Puedes alternar en cualquier momento en caliente con /cpamc-card${RESET}"
        fi
    done

    # Exportar variables en ~/.bashrc si no existen para máxima compatibilidad con procesos shell
    if ! grep -q "CPAMC_URL" "$HOME/.bashrc" 2>/dev/null; then
        echo -e "\n# CPAMC Auto Switcher Endpoint Config" >> "$HOME/.bashrc"
        echo "export CPAMC_URL=\"${TARGET_URL}\"" >> "$HOME/.bashrc"
        [ -n "$TARGET_KEY" ] && echo "export CPAMC_KEY=\"${TARGET_KEY}\"" >> "$HOME/.bashrc"
        [ -n "$TARGET_API_KEY" ] && echo "export CLIPROXYAPI_API_KEY=\"${TARGET_API_KEY}\"" >> "$HOME/.bashrc"
        echo -e "${GREEN}    [✓] Variables de entorno añadidas a ~/.bashrc para entornos interactivos.${RESET}"
    fi

    # Limpieza temporal
    if [ -n "$tmp_dir" ] && [ -d "$tmp_dir" ]; then
        rm -rf "$tmp_dir"
    fi

    # Fase 3: TEST DE FUEGO INTERACTIVO (Validar GET /v1/models con Bearer API Key)
    local test_key="${TARGET_API_KEY:-$TARGET_KEY}"
    if [ -n "$test_key" ]; then
        echo -e "\n${YELLOW}🔥 Ejecutando Test de Fuego sobre el catálogo de modelos (/v1/models)...${RESET}"
        local http_code
        http_code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${test_key}" "${TARGET_URL}/v1/models" 2>/dev/null || echo "000")
        if [ "$http_code" = "200" ]; then
            echo -e "${GREEN}  ✅ [TEST DE FUEGO PASS] Catálogo autenticado con éxito (HTTP 200).${RESET}"
        elif [ "$http_code" = "401" ]; then
            echo -e "${YELLOW}  ⚠️ [TEST DE FUEGO] Error HTTP 401 en /v1/models. Revisa la clave API.${RESET}"
        else
            echo -e "${CYAN}  ℹ️ [TEST DE FUEGO] Servidor activo (HTTP ${http_code}), listo para vincular cuentas.${RESET}"
        fi
    fi
}

# ------------------------------------------------------------------------------
# 6. RESUMEN FINAL Y GUÍA DE USO
# ------------------------------------------------------------------------------
print_summary() {
    echo -e "\n${GREEN}================================================================${RESET}"
    echo -e "${BOLD}🎉 ¡INSTALACIÓN COMPLETADA EXITOSAMENTE!${RESET}"
    echo -e "${GREEN}================================================================${RESET}"
    echo -e "  🌐 Endpoint CPAMC activo:   ${CYAN}${BOLD}${TARGET_URL}${RESET}"
    if [ -n "$TARGET_KEY" ]; then
        echo -e "  🔑 Clave de Administración: ${GREEN}Activa${RESET}"
        if [ -f "$HOME/.cliproxy_management_key" ]; then
            echo -e "     ↳ Guardada localmente en: ${YELLOW}$HOME/.cliproxy_management_key${RESET} (chmod 600)"
        fi
    fi
    if [ -f "$HOME/.cliproxy_api_key" ]; then
        echo -e "  🔑 Clave de Consumo (Modelos): ${GREEN}Activa${RESET}"
        echo -e "     ↳ Guardada localmente en: ${YELLOW}$HOME/.cliproxy_api_key${RESET} (chmod 600)"
    fi
    echo -e "  🧩 Extensión de Agente:     ${GREEN}Enlazada y lista${RESET}"
    echo -e "----------------------------------------------------------------"
    echo -e "${BOLD}🚀 PASO FINAL PARA ACTIVAR TUS MODELOS:${RESET}"
    echo -e "  1. Abre la consola web de CPAMC en tu navegador:"
    echo -e "     ${CYAN}${BOLD}${TARGET_URL}/management.html${RESET}"
    if [ -n "$TARGET_KEY" ]; then
        echo -e "     (Ingresa tu Management Key si la consola te la solicita)"
    fi
    echo -e "  2. Vincula tu primera cuenta de IA (Google Antigravity, Claude, OpenAI, etc.)."
    echo -e "     ↳ ${ITALIC}Nota: Si aún no tienes cuentas vinculadas, la instalación ya está lista.${RESET}"
    echo -e "       ${ITALIC}En cuanto agregues una cuenta nativa o crees un pool, aparecerá en /model.${RESET}"
    echo -e "  3. Abre una NUEVA ventana de terminal y ejecuta tu agente:"
    echo -e "     ${CYAN}gentle-shell${RESET}   o   ${CYAN}pi${RESET}"
    echo -e "  4. Escribe ${BOLD}/model${RESET} para empezar a trabajar con tus modelos balanceados."
    echo -e "${GREEN}================================================================${RESET}\n"
}

# ------------------------------------------------------------------------------
# FLUJO PRINCIPAL
# ------------------------------------------------------------------------------
main() {
    print_banner
    detect_local_cpamc
    resolve_connectivity
    verify_connection
    install_plugin
    install_extension
    print_summary
}

main
