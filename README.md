# ⚡ Auto Switcher Pro & CPAMC Quota Card
### Failover Reactivo en <5ms, Balanceador Inteligente y Telemetría en Vivo para Agentes de Codificación

[![Release](https://img.shields.io/badge/Release-v2.5.0-blue?style=flat-square)](https://github.com/WiloxDev/cpamc-auto-switcher-pro/releases)
[![Tests Passing](https://img.shields.io/badge/Tests-89%2F89%20Passing%20(TS)%20%7C%20Go%20100%25-brightgreen?style=flat-square)](https://github.com/WiloxDev/cpamc-auto-switcher-pro)
[![Plataformas](https://img.shields.io/badge/Plataformas-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey?style=flat-square)](#-instalación-rápida-60-segundos)
[![Harnesses](https://img.shields.io/badge/Harness-Gentle--Shell%20%7C%20Wilox--Pi%20%7C%20Pi-purple?style=flat-square)](#-compatibilidad)

Elimina las interrupciones por límite de tasa (**HTTP 429 Rate Limits**), monitorea tus cuotas de modelos en tiempo real sin salir del terminal y mantén tus agentes de IA codificando sin fricción ni pérdida de contexto en **Gentle-Shell**, **Wilox-Pi** y **Pi Vanilla**.

---

## ⚡ Instalación Rápida (60 Segundos)

Elige tu caso según dónde esté tu servidor CPAMC:

### Caso 1: Todo en esta máquina (Recomendado para empezar)
> Detecta o inicia automáticamente CPAMC oficial (`router-for-me/CLIProxyAPI`), despliega el plugin CGO y monta la extensión visual en tu agente.

**🐧 Linux / 🍏 macOS (Bash o Zsh):**
```bash
curl -fsSL https://raw.githubusercontent.com/WiloxDev/cpamc-auto-switcher-pro/main/install.sh | bash
```

**🪟 Windows (PowerShell como Administrador):**
```powershell
irm https://raw.githubusercontent.com/WiloxDev/cpamc-auto-switcher-pro/main/scripts/install-windows.ps1 | iex
```

---

### Caso 2: Tu servidor CPAMC está en otra máquina (LAN / Proxmox / VPS)
> Instala **única y exclusivamente la extensión** en esta terminal de trabajo y la conecta a la IP remota sin tocar nada del servidor.

**🐧 Linux / 🍏 macOS:**
```bash
./install.sh --ext-only --url "http://192.168.1.50:8317" --key "TU_MANAGEMENT_KEY"
```

**🪟 Windows (PowerShell):**
```powershell
.\scripts\install-windows.ps1 -ExtensionOnly -Url "http://192.168.1.50:8317" -Key "TU_MANAGEMENT_KEY"
```

---

### Caso 3: Solo Plugin CGO (Servidor CPAMC ya existente)
> Agrega o actualiza el motor de balanceo en un servidor CPAMC que ya tengas corriendo (Docker o binario).

```bash
./install.sh --plugin-only
```

> **💡 Consejo Magic Pairing**: Si ya tienes encendido el panel web de CPAMC (`/management.html`), ve a la pestaña *Auto Switcher Pro* y haz clic en **"Generar comando de enlace"** para obtener tu línea de conexión personalizada en 1 clic.

---

## ✅ Verificación en 3 Pasos

Una vez concluida la instalación, realiza esta comprobación en tu terminal:

1. **Abre una nueva ventana de terminal** (para cargar las nuevas variables de entorno):
   ```bash
   gentle-shell    # o ejecuta: pi
   ```
2. **Ejecuta el diagnóstico de salud**:
   ```bash
   /cpamc doctor
   ```
   *Debe confirmar los 4 componentes en verde: Servidor CPAMC, Motor CGO, SQLite WAL y Tarjeta Quota Card.*
3. **Explora tus modelos balanceados**:
   ```bash
   /model
   ```
   *Verás tus fachadas soberanas (`cpamc/Pool-01-gemini`, etc.) listas para trabajar sin riesgo de cortes por 429.*

---

## 🖥️ La Experiencia en Terminal: `cpamc-quota-card`

En **Gentle-Shell**, la tarjeta se ancla de forma nativa en el riel lateral derecho (debajo del bloque de *Status*), ofreciendo telemetría visual continua sin saturar la conversación:

```text
╭─ ⚡ POOL: Gemini ─ [● Activo LIVE] ──────────╮
│ Gemini 2.5 Flash   ● 2 cuentas · listas      │
├──────────────────────────────────────────────┤
│ ╭─ 5 HORAS ───────────── Quedan 4h 50m ────╮ │
│ │ ⏱  ▰▱▱▱▱▱▱▱▱▱▱   3%      ▲ Ritmo holgado │ │
│ │ Uso ▰▱▱▱▱▱▱▱▱▱▱   2%            98% libre │ │
│ ╰──────────────────────────────────────────╯ │
│ ╭─ SEMANAL ───────────── Quedan 6d 23h ────╮ │
│ │ ⏱  0%  Uso 1% · 99% libre  ▲ Ritmo holg. │ │
│ ╰──────────────────────────────────────────╯ │
│ Estado actual      wil...io7 (agy) ○ 98% ok  │
│ Candidato a Líder  mar...tro (agy_1) ○ 100%  │
├──────────────────────────────────────────────┤
│ 🛡 [CUIDANDO EL CHAT] ──────── [○ VIGILANDO] │
│ Subagentes             0/3 llamadas          │
│ Comandos cíclicos      0 detectados          │
│ Terminal Bash          0/5 llamadas          │
├──────────────────────────────────────────────┤
│ ▶ [Ver más: Contexto, Historial y Líderes]   │
╰──────────────────────────────────────────────╯
```

### 🪗 Acordeón Interactivo Tri-Modal
Interactúa pulsando **`Ctrl+Alt+X`** o haciendo **clic directo con el ratón**:
- 🟢 **Colapsado (`COLLAPSED`)**: Vista ultra-compacta de 19 líneas exactas, ideal para sesiones continuas de codificación sin scroll vertical.
- 🟡 **Peek 20s (`PEEK`)**: Se despliega automáticamente ante rescates 429 o rotaciones, con inmunidad de foco (se auto-oculta en cuanto el modelo comienza a responder).
- 🔴 **Fijo (`PINNED`)**: Al expandir completamente la tarjeta (`Ctrl+Alt+X`), revela la telemetría forense en tiempo real aislada por cada pool:

```text
├──────────────────────────────────────────────┤
│ 📦 CONTEXTO & COMPRESIÓN                     │
│ Ventana activa     14.2k / 200k (7%)         │
│ Compresiones       0 en esta sesión          │
├──────────────────────────────────────────────┤
│ 🔄 ROTACIONES & LIDERAZGO: Pool-01-gemini    │
│ Rotaciones hoy: 2    │ Líder actual: 3h 15m  │
│ Rescates 429: 0      │ Tokens: 185k          │
│ Turnos sostenidos:   24 turnos sin corte     │
├──────────────────────────────────────────────┤
│ ⚠️ CAUSAS DE ROTACIÓN (ÚLTIMAS 24H)          │
│ 15:32  mar...tro ➔ wil...io7  [Histéresis Δ] │
│ 12:42  wil...io7 ➔ mar...tro    [Fatiga 80%] │
│ 09:15  mar...tro ➔ wil...io7  [Prompt Cache] │
╰──────────────────────────────────────────────╯
```

> **Política de Telemetría Honesta (Zero Mock)**: Si el pool activo no tiene rotaciones en las últimas 24h, la tarjeta muestra con total transparencia:  
> `│ ● Líder firme · Sin rotaciones recientes      │`  
> Erradicando cualquier dato inventado o duplicado entre pools.

---

## 🎮 Comandos Esenciales

| Comando / Atajo | Función |
|---|---|
| `/model` | Selector de modelos con **Pools Soberanos** publicados limpiamente (`cpamc/Pool-XX-...`) |
| `/cpamc doctor` | Diagnóstico de salud integral del ecosistema |
| `/cpamc doctor fix` | Autoreparación y sincronización en caliente si hubo cambios de red |
| `/incident` o `/autopsia` | Abre la autopsia web si el disyuntor frenó un bucle descontrolado de tokens |
| `Ctrl+Alt+X` | Alterna entre los modos del acordeón de la tarjeta lateral |

---

## 🛡️ Transparencia de Sistema y Seguridad (Zero-Disk Mutation)

Auto Switcher Pro está concebido bajo estándares de ingeniería de mínima intervención y máxima auditabilidad:

- **100% en Memoria RAM**: El balanceo de cuentas, la detección predictiva (>80% de fatiga) y los rescates por 429 se ejecutan en RAM (`ActiveLeader`). **Tus archivos de credenciales OAuth físicos en disco (`~/.cli-proxy-api/*.json`) nunca son modificados, renombrados ni borrados.**
- **Archivos gestionados por el instalador**:
  - `~/cliproxyapi/plugins/auto-switcher-pro-linux-amd64.so` (Plugin CGO en el servidor).
  - `~/.pi/gentle-shell/agent/extensions/cpamc-auto-switcher` (Extensión del cliente).
  - Respaldo automático `.bak` antes de cualquier modificación en `config.yaml` o `settings.json`.
- **Desinstalación limpia**:
  Si deseas desinstalar la extensión de tu cliente, basta con eliminar la carpeta de la extensión:
  ```bash
  rm -rf ~/.pi/gentle-shell/agent/extensions/cpamc-auto-switcher
  ```

---

## 👥 Compatibilidad de Arneses y Entornos

| Entorno | Soporte Visual | Balanceo y Pools | Sensor Anti-Sobrediseño |
|---|:---:|:---:|:---:|
| **Gentle-Shell** | ✅ Tarjeta 48 col en riel derecho | ✅ Nativo | ✅ Activo (`~/.gentle-shell/agent/skills`) |
| **Wilox-Pi** | ✅ Telemetría en Footer / Status | ✅ Nativo | ✅ Activo (`~/.pi/agent-wilox/skills`) |
| **Pi Vanilla** | ✅ Telemetría en Footer | ✅ Nativo | ✅ Activo (`~/.pi/agent/skills`) |
| **CLIProxyAPI v8.0.13+** | ✅ Consola de Administración Web | ✅ Motor CGO | — |

---

<details>
<summary>🤖 <b>Protocolo para Asistentes AI y Subagentes Autónomos</b> (Clic para expandir)</summary>

Si estás actuando como asistente de IA (Gentle-Shell, Pi, Claude Code, Cursor, Copilot) guiando al usuario en este repositorio:

1. **Objetivo de Ciclo Completo**: Tu labor es dejar el entorno 100% operativo, no devolver tablas de comandos pasivas para que el usuario las copie.
2. **Pregunta Resolutiva (Si CPAMC no está corriendo)**:
   > *"Veo que tu terminal está lista, pero aún no tienes un servidor CPAMC activo.*
   > * * **[1] Local:** Descargo e inicio automáticamente CPAMC oficial con Auto Switcher Pro.*
   > * * **[2] Remoto/LAN:** Conecto tu extensión a la IP de un servidor existente.*
   > *¿Deseas la opción 1 o 2? Responde el número y yo me encargo de todo."*
3. **Regla de Plataforma Estricta**:
   - En Windows: Invoca **exclusivamente PowerShell** (`install-windows.ps1`), jamás sugieras comandos `bash`.
   - En Linux / macOS: Ejecuta `./install.sh`.
4. **Cierre de Ciclo**:
   - Valida la salud con `/cpamc doctor`.
   - Recuerda al usuario abrir `http://localhost:8317/management.html` para vincular sus primeras cuentas OAuth si aún no lo ha hecho.

</details>

---

<details>
<summary>🧪 <b>Arquitectura Interna y Validación TDD</b> (Clic para expandir)</summary>

### Los 4 Pilares de Rotación
1. **Pertenencia & Sanidad**: Exclusión estricta de cuentas `[INVALID]`, `[EXPIRED]` o sin pool asignado (`[OTHER]`).
2. **Predictivo (>80% volumen)**: Rota preventivamente a una cuenta fresca solo si existe reserva sana con cuota disponible (`hasHealthyReserve`).
3. **Histéresis en `/new`**: Evita el flapping de cuentas protegiendo el Prompt Caching (KV Cache) del proveedor con afinidad >90%.
4. **Reactivo Inmediato**: Rescate instantáneo ante `HTTP 429`, caídas `5xx` o `ECONNRESET` en <5ms (`force = true`).

### Ejecución de Pruebas
```bash
# Validar extensión TypeScript (TUI, Acordeón, Guards)
cd extensions/cpamc-auto-switcher && npm test

# Validar motor CGO en Go
go test ./...
cd plugins/auto-switcher-pro && go test ./...
```
*Suite con 89/89 pruebas unitarias TypeScript y suite completa de Go pasando en verde.*

</details>

---

## 📄 Licencia

Este software está protegido por acuerdos de licencia comercial y uso autorizado bajo el ecosistema WiloxDev / CPAMC.
Para más información, consulta `plugins/auto-switcher-pro/internal/license/`.
