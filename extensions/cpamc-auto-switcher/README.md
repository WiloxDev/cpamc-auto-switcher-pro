# ⚡ CPAMC Auto-Switcher Unified Extension (Pi & Gentle-Shell)

Suite oficial todo-en-uno que proporciona integración nativa completa entre **CPAMC / Auto Switcher Pro** y el agente de codificación **Pi** (`jok3r-pi`, `gentle-shell`, `gentle-pi` o Pi Vanilla).

---

## 🎯 Capacidades Principales

1. **Dynamic Provider (`cpamc`)**:
   - Descubrimiento dinámico de modelos desde CLIProxyAPI (`/v1/models` y `/v0/management/auth-files`).
   - Sincronización continua de catálogo con persistencia dual de caché (`~/.gentle-shell/agent/cpamc-models-cache.json` y `~/.config/wiloxdev/cpamc-models-cache.json`).
   - Soporte nativo para prefijos estándar y especializados: `agy`, `agy2`, `agy3`, `agy_son`, `agy_opus`, `codex`, `codex2`, etc.
   - Filtrado automático de cuentas de reserva (`_1`, `_2`) para mantener el catálogo limpio.

2. **Auto-Failover Hook (Resiliencia en Caliente)**:
   - Intercepción inmediata de errores HTTP `429` (Rate Limit) y `quota/resource exhausted`.
   - Disparo automático de `cpamc-auto-switcher --force` con cola serializada y debounce de 3 segundos.
   - Notificación visual instantánea al usuario sin interrumpir el turno del agente.

3. **Runtime UI & QuotaCard Sidebar**:
   - **Modo Fullscreen**: QuotaCard reactiva calibrada a 36 columnas en el Sidebar derecho con barras espectrales TrueColor (`▰▰▰▰▱▱▱`).
   - **Modo Regular**: Telemetría compacta en el Footer superior derecho con estado de cuota y siguiente en la cola.

4. **Selector Interactivo `/cpamc-model`**:
   - Despliegue interactivo en TUI con clasificación por familias (`✨ Gemini`, `🧠 Claude/GPT`, `🧩 Codex`).
   - Iconografía de roles: `👑` Líderes de rotación activos, `⚡` Directos, `💤` Reservas pasivas.
   - **Refresco Proactivo**: Cada apertura de `/cpamc-model` sincroniza el catálogo vivo con CLIProxyAPI en tiempo real.

5. **Guardián Anti-Sobrediseño (`anti-overengineering`)**:
   - Skill transversal que frena el sobrediseño, dependencias superfluas y código huérfano.
   - Sincronización automática con la carpeta `skills/` del agente activo (Gentle-Shell, Gentle-Pi, Pi Vanilla).
   - Reflejo del estado de protección directamente en la tarjeta de cuotas del sidebar.

---

## 🔄 Pipeline de Sincronización Dinámica y Purga Atómica

Cualquier cambio realizado en la interfaz web de CPAMC (GroupManager / PrefixManager) se sincroniza y depura automáticamente según el siguiente contrato:

| Acción en CPAMC | Comportamiento en CLIProxyAPI | Comportamiento en Pi (`/model` y `/cpamc-model`) |
| :--- | :--- | :--- |
| **Crear Pool Nuevo** | Publica ruta `prefix/model` | Detectado inmediatamente al abrir `/cpamc-model` o en el tick de 75s en segundo plano. |
| **Borrar Pool** | Elimina ruta de `/v1/models` | **Purga Atómica**: Se elimina de la memoria de Pi (`models = refreshed`) y se sobrescribe la caché en disco. Cero zombis. |
| **Reasignar Cuentas** | Cambia prefijo y reservas | Refresca el rol de líder (`👑`) y telemetría de cuotas en caliente. |

---

## 📦 Instalación Rápida All-in-One (Recomendada)

Ejecuta el instalador universal interactivo compatible con **Localhost, LAN y VPS**:

```bash
# Modo interactivo guiado:
curl -sSL https://raw.githubusercontent.com/WiloxDev/cpamc-auto-switcher-pro/main/scripts/install-all.sh | bash

# O apuntando directamente a un VPS remoto:
curl -sSL https://raw.githubusercontent.com/WiloxDev/cpamc-auto-switcher-pro/main/scripts/install-all.sh | bash -s -- --url "https://ai.midominio.com:8317" --key "mi-clave"
```

---

## 📦 Instalación Manual / Homologación Canónica

Para enlazar la extensión canónica en Gentle-Shell:

### Instalación Canónica para Gentle-Shell
```bash
# Método 1: Enlace en Gentle-Shell
mkdir -p ~/.gentle-shell/agent/extensions
ln -sfn ~/projects/cpamc-auto-switcher-pro/extensions/cpamc-auto-switcher ~/.gentle-shell/agent/extensions/cpamc-auto-switcher

# Método 2: Instalador All-in-One oficial
./install.sh --ext-only
```

---

## 🛠️ Estructura del Módulo

```
extensions/cpamc-auto-switcher/
├── index.ts              # Entrypoint unificado, ciclo de telemetría de 25s y refresh de fondo (75s)
├── package.json          # Metadatos y definición de extensión de Pi
├── tsconfig.json         # Configuración del compilador TypeScript
├── README.md             # Documentación canónica de gobernanza y arquitectura
└── src/
    ├── provider.ts       # Dynamic Provider 'cpamc', caché dual y discovery de prefijos
    ├── failover.ts       # Hook reactivo de failover ante errores 429
    ├── adapter.ts        # Renderizador de QuotaCard Sidebar y Footer
    ├── picker.ts         # Comando interactivo /cpamc-model con formateo nativo string[]
    └── store.ts          # Estado del switcher, clasificación de modelos y telemetría
```

---

## 📋 Registro de Decisiones de Arquitectura (ADR)

- **ADR-001 (Unificación de Suite)**: Se deprecó `cpamc-runtime-ui` y `pi extensions/cpamc-auto-switcher` en favor de `extensions/cpamc-auto-switcher/` para eliminar duplicidad, fragmentación de enlaces y divergencia de estado.
- **ADR-002 (Contrato de TUI Select)**: Se corrigió la llamada a `ctx.ui.select` para pasar `string[]` en lugar de objetos `{ label, value }`, eliminando el renderizado defectuoso de `[object Object]`.
- **ADR-003 (Descubrimiento No-Bloqueante)**: Aumento de timeout a 10s en el descubrimiento de prefijos, pre-poblado directo desde atributos `note` y fallback extendido para `agy_opus` y `codex`.
- **ADR-004 (Contrato de composición del footer)**: `__originalRail` es contrato obligatorio para todo lo que envuelva `parts["footer"]`; la intercepción de `parts.set` es intencional y reactiva. Ver [docs/architecture/sidebar-footer-composition.md](../docs/architecture/sidebar-footer-composition.md).
