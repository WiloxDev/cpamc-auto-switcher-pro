# ⚡ AI Installation & Integration Rules — CPAMC Auto Switcher Pro

> **Regla de Oro para Asistentes AI y Agentes de Automatización:**
> Este paquete es una suite de rotación de modelos y telemetría de cuotas para Gentle-Shell / Pi y CPAMC.
> Cumple la **Invariante Zero-Chat de WiloxDev**: **NUNCA DEBE PINTARSE NADA EN EL STREAM DE CHAT**.

## Directrices Estrictas de Renderizado:
1. **Ubicación de la QuotaCard Pro:** La tarjeta vive exclusivamente en el riel lateral derecho (Sidebar Dock).
2. **Hook de TUI:** Se acopla a través de `adapter.ts` en la ranura `"footer"` de `gentleState.parts` o vía `mountSidebarSlot`.
3. **Prohibido Renderizar en Chat:** La llamada a `ctx.ui.setWidget("cpamc-tui-hook", ...)` retorna `render: () => []`. Bajo ningún concepto devuelvas líneas al chat de Pi.
4. **Comandos de Terminal:** `/cpamc:accordion`, `/cpamc:period`, `/cpamc:reset`, `/cpamc:pool`.
