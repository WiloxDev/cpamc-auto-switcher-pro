# Contrato Arquitectónico Canónico: Catálogo /model y Enrutamiento de Pools ($N \to \infty$)

## Estado Validado (2026-10-13)

**Formato canónico del identificador de pool**: `Pool-XX-<family>`  
Ejemplos en producción: `Pool-01-gemini`, `Pool-02-gemini`

**Ubicación única de generación**: `plugins/auto-switcher-pro/internal/plugin/registry.go:562`
```go
canonicalPoolID := fmt.Sprintf("Pool-%02d-%s", seq, famShort)
```

**Propagación automática verificada**:
`pool.ID` → `pool.DisplayName` → `poolPrefixedCatalog()` → catálogo `/model` → routing dinámico → `scheduler.pick`

**Cobertura de tests**: `modelprovider_test.go` valida catálogo estático, routing dinámico por líder activo, y `scheduler.pick` con 12+ asserts sobre `Pool-01-gemini`.

---

## 1. El Concepto Fundamental: Fachada Virtual ("Líder Ficticio")

En el selector `/model` de Pi, **el usuario nunca interactúa directamente con una cuenta física fija**.

1. Cada entrada en `/model` representa una **Fachada Virtual (un Pool Activo)** registrado en Auto Switcher Pro.
2. Pi invoca la ruta estable del pool: `cpamc/<pool_prefix>/<modelo>`.
3. En el backend, Auto Switcher Pro resuelve esa fachada hacia la credencial física que actualmente ejerce de Líder.
4. Cuando dicha credencial se agota (por ventana de 5h, límite semanal o código HTTP 429), Auto Switcher Pro **intercambia dinámicamente el Líder y su Reserva** (`_1`, `_2`, etc.) en caliente con **cero caídas (zero-downtime)**.
5. Para Pi, la llamada continúa de forma transparente e ininterrumpida a través de la misma fachada virtual.

---

## 2. Los Cuatro Mandamientos Arquitectónicos Inmutables

### Mandamiento I: 1 Entrada en `/model` = 1 Pool Activo ($N \to \infty$)
- Cada grupo / pool / perfil registrado en Auto Switcher Pro (`base_prefix`) tiene **su propia entrada independiente** en `/model`.
- Si existen $N$ pools ($1, 2, 5, 20 \dots \infty$), `/model` publica **los $N$ pools**.
- **PROHIBICIÓN ESTRICTA**: Ninguna regla de código ni agente de IA puede colapsar, fusionar o "sombrear" (`shadow`) pools hermanos bajo la premisa de "pertenecer a la misma familia". Cada pool es una unidad de enrutamiento autónoma.

### Mandamiento II: Independencia de Modelos por Pool (La Tuerca ⚙️)
- Cada pool administra sus propios modelos permitidos y excluidos según las exclusiones físicas (`excluded_models`) de su cuenta Líder.
- Si el pool `agy` es especialista en `gemini-3.8-flash-high`, expone únicamente ese modelo.
- Si el pool hermano `agy2` es multipropósito, expone todos los modelos de la familia.
- Los pools jamás se interfieren ni se imponen políticas entre sí.

### Mandamiento III: Diferenciación Estricta de Claude
Claude tiene dos orígenes técnicos totalmente distintos que **nunca deben mezclarse**:
1. **Google Antigravity Package (Cloud Code / Cuentas Google)**:
   - Prefijo obligatorio con `agy_`.
   - Estrictamente dividido en dos niveles:
     - `agy_son*` $\to$ Únicamente modelos **Sonnet** (`claude-sonnet-4-6`).
     - `agy_opus*` $\to$ Únicamente modelos **Opus** (`claude-opus-4-6`).
     - *Google Cloud Code no ofrece Claude genérico ni Haiku.*
2. **Claude Directo (Anthropic Oficial)**:
   - Prefijo obligatorio: `clau*` o `claude*` (NUNCA empieza con `agy_`).
   - Expone el catálogo oficial completo de Anthropic (`claude-3-5-haiku`, `claude-3-7-sonnet`, `claude-3-opus`).

### Mandamiento IV: Invisibilidad Absoluta de Reservas
- Todo prefijo que termine en un sufijo numérico de reserva (`_1`, `_2`, `_3`...) pertenece a la infraestructura interna del banquillo de rotación.
- **JAMÁS debe aparecer en `/model`**.

### Mandamiento V: Gobernanza Bimodal de Cuentas Libres / Standalone (Solo Lectura Asistida)
- Toda cuenta física o proveedor conectado a CPAMC que no forme parte de un Pool registrado goza de **Gobernanza Bimodal en Solo Lectura**:
  1. **Cero Mutación en Disco**: Sus credenciales físicas (`.json`) conservan `excluded_models: []` de fábrica sin alteraciones de prefijos forzadas.
  2. **Telemetría de Primera Clase**: Recibe monitoreo de cuotas en vivo en la Web UI (`AutoAuthFiles.jsx`) y en la tarjeta TUI de Pi (relojes duales concéntricos de 5H/Semanal, análisis de ritmo, tiempo de reinicio).
  3. **Blindaje de Sesión Transversal**: La protección de `CUIDANDO EL CHAT` (disyuntor anti-bucle, límite de evasión bash, anti-sobrediseño) opera de manera idéntica para resguardar la cuota finita de la cuenta fija.
  4. **Aviso de Resiliencia**: La tarjeta alerta explícitamente `[CUENTA FIJA · SIN FAILOVER]` para informar con total transparencia que un error 429 detendría la tarea al no disponer de banquillo de relevo.

---

## 3. Matriz Universal de Proyección en `/model`

```text
/model en Pi (Directorio Universal de Fachadas de Pools Activos)

📦 GOOGLE ANTIGRAVITY (Gemini & Claude del Paquete)
 ├── 💎 Pool-01-gemini       ➔ Fachada Pool 1 (Auto Switcher rota inf...tec ⇄ inf...vio)
 ├── 💎 Pool-02-gemini       ➔ Fachada Pool 2 (Auto Switcher rota mar...tro ⇄ wil...o11)
 ├── 💎 Pool-0N-...          ➔ Fachada Pool N (Escalabilidad infinita)
 ├── 🔶 agy_son/claude-sonnet-4-6   ➔ Especialista Sonnet (Rota cuentas Google autorizadas)
 └── 🟣 agy_opus/claude-opus-4-6    ➔ Especialista Opus (Rota cuentas Google autorizadas)

🏢 ANTHROPIC NATIVO (Claude Directo)
 ├── 🏷️ clau/claude-3-5-haiku       ➔ Fachada Pool Claude Directo #1 (Catálogo completo)
 ├── 🏷️ clau/claude-3-7-sonnet
 ├── 🏷️ clau/claude-3-opus
 └── 🏷️ clauN/...                    ➔ Fachada Pool Claude Directo #N (Escalabilidad infinita)

🧩 OPENAI (Codex Directo)
 ├── 🧩 codex/gpt-5.6-codex          ➔ Fachada Pool Codex #1 (Rota cuentas OpenAI)
 └── 🧩 codexN/...                   ➔ Fachada Pool Codex #N (Escalabilidad infinita)
```

---

## 4. Flujo Técnico Verificado

### Creación de Pool (`registry.go:540-570`)
1. `seq := len(r.pools) + 1`
2. `famShort := familyCanonicalShortName(pool.Family, trimmedPrefix)` → `gemini`, `claude`, `codex`
3. `canonicalPoolID := fmt.Sprintf("Pool-%02d-%s", seq, famShort)`
4. Se asigna a `pool.ID`, `pool.DisplayName`, `pool.Name` (si vacío)
5. Persistencia atómica via `Save()`

### Exposición en Catálogo (`modelprovider.go:325-360`)
```go
cleanPoolName := strings.TrimSpace(pool.DisplayName)
if cleanPoolName == "" {
    cleanPoolName = strings.TrimSpace(pool.ID)
}
addModel(cleanPoolName, cleanPoolName)  // ID y DisplayName idénticos
```

### Routing Dinámico (`modelprovider.go:370-420`)
- Entrada `Pool-XX-<family>` → busca pool por `DisplayName` o `ID` → resuelve `ActiveLeader` en RAM → reescribe a modelo configurado del líder actual
- Zero-downtime garantizado: el `ActiveLeader` cambia en memoria, la fachada `/model` no muta

---

## 5. Invariantes que Nunca Deben Romperse

| Invariante | Validación |
|------------|------------|
| `Pool-XX-<family>` formato fijo | Tests + persistencia en disco |
| 1 pool = 1 entrada `/model` | `poolPrefixedCatalog()` itera `ListPools()` |
| Reservas (`_1`, `_2`) invisibles | Filtrado en catálogo, solo líder activo expuesto |
| Claude Antigravity ≠ Claude Directo | Prefijos `agy_` vs `clau*` obligatorios |
| Identidad soberana por `pool.ID` | Inmutable tras creación, no depende de cuenta física |

---

## 7. Frontend Submenus & Real Runtime State Mapping Rules

### Regla de Mapeo sin Mocks para Submenús (Frentes 1 al 8)
1. **Fuentes de Verdad Coexistentes**:
   - Cuentas Físicas (`/root/.cli-proxy-api/*.json`): Solo la cuenta líder o cuentas libres llevan prefijos. Las reservas en disco intencionalmente llevan `prefix: ""` o `prefix: "<base>_N"` no expuesto a `/model`.
   - Estado Soberano (`auto-switcher-pro-state.json` / `PoolRegistry`): Define `id` (`Pool-XX-<family>`), `active_leader` (en RAM), `reserves` y la política especialista virtual (`policy.target_models`).
2. **Auto Auth Files (`/1`)**:
   - Tarjetas construidas mediante `buildManagedPoolCards(nodes, registeredPools)`.
   - La Tuerca ⚙️ (`SpecialistModal`) modifica el modelo especialista del pool vía `savePool()` de forma 100% virtual, garantizando que los archivos físicos en disco conserven `excluded_models: []` intacto.
3. **Control Switcher (`/2`)**:
   - Cuando existen `registeredPools`, cada tarjeta de pool mapea su líder directamente desde `rp.active_leader` y sus reservas en cola desde `rp.reserves`, calculando la Mejor Candidata y métricas TrueColor en tiempo real sin asumir prefijos estampados en disco.
4. **Visual Profile (`/3`)**:
   - `buildGraphFromAuthFiles(nodes, { registeredPools })` conecta automáticamente las reservas con el líder de su pool, asignando insignias `📦 Pool-XX-<family>` y `👑 RAM`.

---

## 8. TUI Telemetry & Dual-Surface Observability Contract (Footer + Sidebar)

### 1. Estándar Tabular Canónico de 8 Columnas en CLI (`cpamc-auto-switcher -list`)
- Para evitar colapsos de columnas en parsers JavaScript (`split(/\s+/)`), toda cuenta sin prefijo físico en disco (`prefix: ""`) DEBE emitirse con un guión explícito (`"-"`) en la columna `PREFIX`.
- El formato estricto de 8 columnas es:
  `STATUS | PROVIDER | PROFILE | ACCOUNT ID | PREFIX | 5H CONSUMED | WEEKLY CONSUMED | MIN AVAILABLE`
- Todos los consumidores en TypeScript (`store.ts`, `quota.ts`) normalizan simétricamente `"-"` a `""` para respetar el Contrato de Aislamiento Virtual Puro.

### 2. Eliminación de Clonación Fantasma en la Reserva (`nextAcc`)
- En piscinas o perfiles con 0 reservas disponibles (`reserves.length === 0`), el algoritmo de rotación DEBE asignar `nextAcc = null` en lugar de clonar la cuenta padre (`parent`).
- La ranura de reserva (`⏭`) solo se proyecta si existe una cuenta suplente real diferente del líder activo.

### 3. Coexistencia Unificada de Superficies (Sidebar + Footer)
- **Pantallas Grandes ($\ge 120$ columnas)**:
  - **Sidebar Lateral**: Tarjeta reactiva `⚡ CPAMC POOL` (sección `sentinel`, registrada una única vez) con barras segmentadas `▰▰▱▱▱▱` de 5 horas y ciclo semanal, identificando al `active_leader` de RAM y la siguiente reserva en cola.
  - **Barra Inferior (Footer TUI)**: Telemetría compacta con estado del bucle (`⏸` / `▶`), porcentaje disponible mínimo y cuentas regresivas de expiración cíclica (`↻ 4h/6d`).
- **Pantallas Estándar / Compactas ($< 120$ columnas)**:
  - El sidebar se contrae automáticamente y la barra inferior preserva la observabilidad completa de cuotas y rotación.
- **Sincronización Multi-Harness (`gentle-shell`, `gentle-pi`, `j0k3r-pi`)**:
  - `adapter.ts` inyecta la tarjeta en ambos symbols (`gentle-pi.experimental-sidebar.state` y `j0k3r-theme.sidebar.state`) y emite simultáneamente al footer, garantizando datos idénticos y en tiempo real sin desincronización ni duplicidades.
