# Contrato de composición del footer del sidebar

**Estado:** vigente · **Aplica a:** `extensions/cpamc-auto-switcher/src/adapter.ts` (`injectIntoSidebar`, `wrapFooter`)
**Origen del defecto que evita:** duplicación de `PomoReloj Bigote` y de la fila de contexto en Gentle Shell (2026-11-05).
**Reglas de referencia:** `docs/adr/0001-sidebar-composition.md` en `WiloxDev/Wellness-Reloj-pi`.

## Por qué existe este documento

CPAMC no solo registra su tarjeta: **decora el `footer` de Gentle-Shell e intercepta `parts.set`**.
Cualquier otra extensión que quiera saber si ya hay un compositor montado tiene que poder
recorrer la cadena que nosotros dejamos. Si una capa no se-enlaza a sí misma hacia abajo, esa
detección queda ciega y la extensión de al lado reinstala su compositor encima: dos pintadas de
todas las ranuras. Esto no es teórico — es exactamente como se producía el bug.

## Diccionario de marcadores

| Clave / marcador | Dueño | Significado |
|---|---|---|
| `Symbol.for("gentle-pi.experimental-sidebar.state")` | Gentle-Shell | estado del sidebar: `parts`, `active`, `ownsHost()` |
| `Symbol.for("gentle-pi.community.sidebar.order")` | Gentle-Shell | orden de secciones; si falta, CPAMC usa `["footer","sentinel","jobs","agents","todo"]` |
| `parts.get("sentinel")` | **CPAMC** | la Quota Card como ranura primaria |
| `__isCpamcDecorated` | **CPAMC** | esta capa es nuestro decorador de footer |
| `__originalRail` | quien envuelve `footer` | **contrato:** rail inmediatamente inferior |
| `__cpamcHooked` | **CPAMC** | el `Map` de partes ya tiene nuestro `set` instalado |
| `__isWiloxSlotsCompositor` | wellness-reloj / gentle-context-lens | compositor de ranuras comunitario |
| `Symbol.for("gentle-pi.community.wiloxdev.sidebar-slots")` | wellness-reloj / gentle-context-lens | registro global de ranuras |

## Reglas que cumple esta extensión

1. **Toda capa que envuelve `footer` expone `__originalRail`** — incluida la que produce el
   interceptor de `parts.set`. Sin esto, las extensiones de ranuras no pueden distinguir
   "hay compositor debajo" de "no hay", y reinstalan.
2. **Idempotencia por cadena, no por capa visible.** `wrapFooter` corta si la capa recibida ya
   está decorada. Al reencyclar (`/reload`, `turn_start`) se vuelve a llamar y no apila.
3. **Un solo canal de pintado por host.** La Quota Card vive en `parts["sentinel"]`. El footer
   solo la pinta cuando el riel no la tiene (`railOwnsQuotaCard`) y nunca si una capa más
   profunda ya la pintó (`containsQuotaCardLines`), porque la profundidad del encadenado no es
   fiable: otras extensiones re-envuelven con marcadores propios.
4. **No se toca lo que no es propio.** CPAMC no borra ni cachea `footer` ajeno.

## Esperar a que el sidebar esté "completo"

No hay señal de "sidebar terminado". Los tres mecanismos que usa esta extensión:

- **Presencia:** solo decora si `parts.has("footer")`; si aún no existe, queda pendiente el hook.
- **Intercepción:** el `set` envuelto captura el footer cuando Gentle-Shell lo monte, aunque
  sea después de nuestra inyección (orden de carga inverso).
- **Soberanía del riel:** `railOwnsQuotaCard()` decide si pinta `sentinel` o el footer, leyendo
  el orden global de secciones en cada pasada, no una vez en el arranque.

Consecuencia aceptada: el interceptor es **reactivo y permanente** sobre la instancia del `Map`
(`__cpamcHooked`), así que todo footer futuro —incluido el de otra extensión— pasará por `wrapFooter`.
Por eso la regla 1 es obligatoria y no opcional.

## Límite conocido (no resuelto aquí)

El decorador no implementa `dispose`: al descargar la extensión, la capa decorada queda
instalada y el rail original solo es alcanzable por `__originalRail`. Está trazado en el
issue #31. Cualquier implementación de `dispose` debe restaurar **solo si sigue siendo el
footer activo** (comprobar identidad, no borrar a ciegas).

## Cómo se comprueba

```bash
node --experimental-strip-types --test src/sidebar-composition.test.ts
```

Cuatro casos: compositor de ranuras alcanzable bajo el decorador, idempotencia al reinyectar,
compositor montado después a través del `set` interceptado, y pintado único de la Quota Card en
un host que recorre todas las partes. **Control de validez:** eliminando
`__originalRail: originalRail` de `wrapFooter` fallan 2 de los 4; un fixture que no detecta
esa mutación no prueba nada.
