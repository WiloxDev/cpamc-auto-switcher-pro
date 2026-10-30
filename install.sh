#!/usr/bin/env bash
# ==============================================================================
# ⚡ AUTO SWITCHER PRO — Universal All-In-One Installer (Entrypoint Canónico)
#
# Suite Convergente: Plugin CPAMC (.so) + SQLite WAL + Extensión Gentle-Shell/Pi
# Soporta ejecución local (./install.sh) y vía pipe web (curl | bash)
# ==============================================================================

set -euo pipefail

# Resolver directorio real si se ejecuta desde archivo local
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

INSTALLER=""
if [ -n "${SCRIPT_DIR}" ] && [ -f "${SCRIPT_DIR}/scripts/install-all.sh" ]; then
  INSTALLER="${SCRIPT_DIR}/scripts/install-all.sh"
fi

TMP_DIR=""
if [ -z "${INSTALLER}" ]; then
  # Ejecución vía pipe web (curl | bash): descargar el instalador oficial
  # Permite fijar un tag, commit o rama inmutable vía INSTALL_REF (por defecto: main)
  REF="${INSTALL_REF:-main}"
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  INSTALLER="${TMP_DIR}/install-all.sh"
  DOWNLOAD_URL="https://raw.githubusercontent.com/WiloxDev/cpamc-auto-switcher-pro/${REF}/scripts/install-all.sh"
  if ! curl -sSL -f -o "${INSTALLER}" "${DOWNLOAD_URL}"; then
    echo "❌ Error: No se pudo descargar el instalador oficial (${REF}) desde GitHub."
    exit 1
  fi
fi

# Manejo intuitivo de argumentos: si el primer parámetro es una URL, convertir a --url
if [ $# -eq 1 ] && [[ "$1" =~ ^https?:// ]]; then
  exec bash "${INSTALLER}" --url "$1"
elif [ $# -eq 2 ] && [[ "$1" =~ ^https?:// ]]; then
  exec bash "${INSTALLER}" --url "$1" --key "$2"
else
  exec bash "${INSTALLER}" "$@"
fi

