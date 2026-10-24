.PHONY: all build build-amd64 build-arm64 test test-go test-web test-extension clean check-hygiene help

all: build

help:
	@echo "Comandos disponibles:"
	@echo "  make build          - Compila el plugin para Linux amd64 hacia bin/"
	@echo "  make build-arm64    - Compila el plugin para Linux arm64 hacia bin/"
	@echo "  make test           - Ejecuta todas las pruebas (Go, Web y Extensión Pi)"
	@echo "  make test-go        - Ejecuta las pruebas unitarias de Go"
	@echo "  make test-web       - Ejecuta la suite de pruebas de Vitest"
	@echo "  make test-extension - Ejecuta las pruebas de la extensión de Pi"
	@echo "  make check-hygiene  - Verifica que no existan artefactos de compilación fuera de bin/"
	@echo "  make clean          - Limpia el directorio bin/"

build:
	@./scripts/build-plugin.sh amd64

build-arm64:
	@./scripts/build-plugin.sh arm64

test: test-go test-web test-extension check-hygiene

test-go:
	@echo "==> Ejecutando pruebas de Go..."
	@go test ./...
	@go -C plugins/auto-switcher-pro test ./...

test-web:
	@echo "==> Ejecutando pruebas de Vitest..."
	@cd plugins/auto-switcher-pro/web && npx vitest run

test-extension:
	@echo "==> Ejecutando pruebas de la extensión Pi..."
	@cd extensions/cpamc-auto-switcher && npm test

check-hygiene:
	@echo "==> Verificando higiene de código fuente..."
	@STRAY=$$(find plugins/ -type f \( -name "*.h" -o -name "*.so" \) ! -path "*/bin/*" 2>/dev/null || true); \
	if [ -n "$$STRAY" ]; then \
		echo "ERROR: Se detectaron artefactos huérfanos de compilación fuera de bin/:"; \
		echo "$$STRAY"; \
		exit 1; \
	fi; \
	echo "OK: Código fuente limpio (0 residuos fuera de bin/)."

clean:
	@echo "==> Limpiando directorio bin/..."
	@rm -rf bin/auto-switcher-pro-linux-*
	@echo "Directorio bin/ limpio."
