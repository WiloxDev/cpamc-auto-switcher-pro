# Security, Privacy & Audit Disclosure

Este documento describe la arquitectura de seguridad, gestión de datos sensibles y garantías de privacidad de **Auto Switcher Pro**. Está redactado para desarrolladores, equipos de DevSecOps y asistentes de auditoría automatizada.

---

## 1. Tratamiento de Credenciales y Secretos (Zero-Disk Mutation)

- **Aislamiento en RAM**: Todas las decisiones de balanceo, rotación por límite de tasa (HTTP 429) e histéresis de Prompt Cache se ejecutan **100% en memoria volátil**.
- **Inmutabilidad en Disco**: Los archivos de credenciales físicas OAuth (`~/.cli-proxy-api/*.json` o `/root/.cli-proxy-api/*.json`) **jamás son leídos, alterados ni sobrescritos por el plugin**. Las credenciales son gestionadas exclusivamente por el core oficial de CLIProxyAPI.
- **Sin Exfiltración de Tokens**: El plugin no contiene funciones ni dependencias para transmitir tokens de autenticación, claves de API o prompts de usuario hacia servidores externos.

---

## 2. Telemetría y Módulo de Licenciamiento (`internal/license`)

El repositorio incluye un sistema de validación criptográfica para despliegues comerciales. Sus características de privacidad son:

- **Machine ID Criptográfico Local**: La huella de máquina se genera a partir de identificadores de hardware locales (ej. `machine-id` o UUID de BIOS) mediante un hash unidireccional SHA-256 / Ed25519. No es reversible ni contiene información personal del usuario.
- **Soporte Airgap Nativo (Aislamiento Total de Red)**:
  Si operas en un entorno con restricciones estrictas de red o sin salida a Internet, define la variable de entorno:
  ```bash
  export CPAMC_AIRGAP_MODE=1
  ```
  Esto desactiva cualquier intento de sincronización externa con el servidor de licencias (`hub.wiloxdev.com`), operando de manera 100% autónoma.
- **Cero Telemetría Oculta**: No se recopilan logs de uso, historial de conversaciones, código fuente del usuario ni estadísticas de prompts.

---

## 3. Integridad en la Instalación y Binarios

- **Auditoría Local**: Se recomienda a los usuarios auditar los scripts (`install.sh`, `scripts/install-all.sh`) antes de su ejecución o clonar el repositorio localmente.
- **Verificación Criptográfica de Binarios**: Los releases oficiales proporcionan hashes SHA-256 (`.sha256`) para cada arquitectura (`linux-amd64`, `linux-arm64`, `windows-amd64`). El instalador verifica automáticamente la integridad cuando los hashes están disponibles.
- **Compilación 100% Reproducible**: Cualquier usuario puede prescindir de los binarios precompilados y compilar el archivo dinámico `.so` desde el código fuente mediante Go oficial:
  ```bash
  ./scripts/build-plugin.sh amd64   # o arm64
  ```

---

## 4. Uso Ético y Términos de Servicio de Proveedores (LLMs)

Auto Switcher Pro es una herramienta diseñada para mitigar fallos transitorios en entornos de desarrollo y equilibrar el consumo entre cuentas autorizadas de un mismo propietario. 

El uso de este software debe respetar en todo momento los Términos de Servicio (ToS) y políticas de uso aceptable de cada proveedor de modelos (OpenAI, Google, Anthropic, etc.). El software no proporciona métodos para eludir mecanismos de seguridad ni vulnerar controles de acceso de terceros.
