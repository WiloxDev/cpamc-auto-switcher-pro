<#
.SYNOPSIS
    Instalador Universal Dinámico de Auto Switcher Pro para Windows
    Compatible con Gentle-Shell, Pi Vanilla, Wilox-Pi y CLIProxyAPI (CPAMC).

.DESCRIPTION
    Realiza una instalación totalmente dinámica, segura y no destructiva:
    1. Detecta automáticamente todas las instancias y perfiles de agentes activos.
    2. Respalda con timestamp cualquier versión previa de la extensión antes de actualizar.
    3. Detecta dinámicamente la ubicación de CPAMC inspeccionando procesos activos en RAM
       (cli-proxy-api.exe / CLIProxyAPI.exe) y rutas habituales (incluyendo Applications).
    4. Suministra la biblioteca nativa auto-switcher-pro-windows-amd64.dll y activa su entrada
       en config.yaml con respaldo previo.
    5. Respeta variables de entorno existentes (CLIPROXYAPI_BASE_URL / CLIPROXYAPI_MANAGEMENT_KEY)
       sin sobrescritura destructiva.
#>

param(
    [string]$Url = "",
    [string]$Key = "",
    [switch]$ExtensionOnly = $false,
    [string]$CpamcDir = ""
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "⚡ AUTO SWITCHER PRO — Instalador Universal Dinámico" -ForegroundColor Cyan
Write-Host "   Windows: Gentle-Shell · Pi · CLIProxyAPI (CPAMC)" -ForegroundColor DarkCyan
Write-Host "==========================================================" -ForegroundColor Cyan

# ------------------------------------------------------------------------------
# 0. RESOLUCIÓN DINÁMICA DE FUENTES (LOCAL VS PIPE WEB)
# ------------------------------------------------------------------------------
$isLocalExecution = $false
$extSource = $null
$binSource = $null
$subagentsSource = $null
$agentsSource = $null
$skillsSource = $null

if ($MyInvocation.MyCommand.Path -and (Test-Path $MyInvocation.MyCommand.Path)) {
    $scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
    $repoRoot = Split-Path -Parent $scriptRoot
    
    # 1. ¿Estamos en el repositorio completo?
    $candidateRepoExt = Join-Path $repoRoot "extensions\cpamc-auto-switcher"
    $candidateRepoBin = Join-Path $repoRoot "bin\auto-switcher-pro-windows-amd64.dll"
    $candidateRepoSubagents = Join-Path $repoRoot "subagents"
    $candidateRepoAgents = Join-Path $repoRoot "agents"
    $candidateRepoSkills = Join-Path $repoRoot "skills"
    
    # 2. ¿Estamos dentro de un release package distribuido?
    $candidatePkgExt = Join-Path $scriptRoot "extensions\cpamc-auto-switcher"
    $candidatePkgBin = Join-Path $scriptRoot "bin\auto-switcher-pro-windows-amd64.dll"
    $candidatePkgSubagents = Join-Path $scriptRoot "subagents"
    $candidatePkgAgents = Join-Path $scriptRoot "agents"
    $candidatePkgSkills = Join-Path $scriptRoot "skills"

    if (Test-Path $candidateRepoExt) {
        $isLocalExecution = $true
        $extSource = $candidateRepoExt
        if (Test-Path $candidateRepoBin) { $binSource = $candidateRepoBin }
        if (Test-Path $candidateRepoSubagents) { $subagentsSource = $candidateRepoSubagents }
        if (Test-Path $candidateRepoAgents) { $agentsSource = $candidateRepoAgents }
        if (Test-Path $candidateRepoSkills) { $skillsSource = $candidateRepoSkills }
    } elseif (Test-Path $candidatePkgExt) {
        $isLocalExecution = $true
        $extSource = $candidatePkgExt
        if (Test-Path $candidatePkgBin) { $binSource = $candidatePkgBin }
        if (Test-Path $candidatePkgSubagents) { $subagentsSource = $candidatePkgSubagents }
        if (Test-Path $candidatePkgAgents) { $agentsSource = $candidatePkgAgents }
        if (Test-Path $candidatePkgSkills) { $skillsSource = $candidatePkgSkills }
    }
}

$tempWorkDir = $null
if (-not $isLocalExecution) {
    Write-Host "`n[Descarga] Obteniendo fuentes oficiales desde GitHub..." -ForegroundColor Gray
    $tempWorkDir = Join-Path $env:TEMP "cpamc-install-$([guid]::NewGuid().ToString('N').Substring(0,8))"
    New-Item -ItemType Directory -Force -Path $tempWorkDir | Out-Null
    $tempZip = Join-Path $tempWorkDir "bundle.zip"
    
    try {
        Invoke-WebRequest -Uri "https://github.com/WiloxDev/cpamc-auto-switcher-pro/archive/refs/heads/main.zip" -OutFile $tempZip
        Expand-Archive -Path $tempZip -DestinationPath $tempWorkDir -Force
        $extSource = Join-Path $tempWorkDir "cpamc-auto-switcher-pro-main\extensions\cpamc-auto-switcher"
        $binSource = Join-Path $tempWorkDir "cpamc-auto-switcher-pro-main\bin\auto-switcher-pro-windows-amd64.dll"
        $subagentsSource = Join-Path $tempWorkDir "cpamc-auto-switcher-pro-main\subagents"
        $agentsSource = Join-Path $tempWorkDir "cpamc-auto-switcher-pro-main\agents"
        $skillsSource = Join-Path $tempWorkDir "cpamc-auto-switcher-pro-main\skills"
    } catch {
        Write-Error "No se pudo descargar el paquete desde GitHub: $_"
        exit 1
    }
}

# ------------------------------------------------------------------------------
# 1. INSTALACIÓN DE LA EXTENSIÓN (DETECCIÓN DINÁMICA & BACKUP SEGURO)
# ------------------------------------------------------------------------------
Write-Host "`n[Paso 1/2] Detectando perfiles de agentes e instalando extensión..." -ForegroundColor Yellow

$agentTargets = @()

# Inspeccionar variables de entorno si existen
if ($env:GENTLE_AGENT_DIR -and (Test-Path $env:GENTLE_AGENT_DIR)) {
    $agentTargets += (Join-Path $env:GENTLE_AGENT_DIR "extensions")
}
if ($env:PI_CODING_AGENT_DIR -and (Test-Path $env:PI_CODING_AGENT_DIR)) {
    $agentTargets += (Join-Path $env:PI_CODING_AGENT_DIR "extensions")
}

$gentleRoot = Join-Path $env:USERPROFILE ".gentle-shell"
if (Test-Path $gentleRoot) {
    Get-ChildItem -Path $gentleRoot -Directory -Filter "agent*" -ErrorAction SilentlyContinue | ForEach-Object {
        $extDir = Join-Path $_.FullName "extensions"
        if ($agentTargets -notcontains $extDir) {
            $agentTargets += $extDir
        }
    }
}

# Si no se detectó ningún perfil aún, preparar Gentle-Shell predeterminado
if ($agentTargets.Count -eq 0) {
    $defaultExt = Join-Path $env:USERPROFILE ".gentle-shell\agent\extensions"
    $agentTargets += $defaultExt
}

$extInstalledCount = 0
$timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")

# Directorio seguro de respaldos FUERA de extensions/ para evitar colisiones de atajos (Ctrl+Alt+X / Ctrl+Alt+P)
$backupRootDir = Join-Path $env:USERPROFILE ".gentle-shell\backups\extensions"
if (-not (Test-Path $backupRootDir)) {
    New-Item -ItemType Directory -Force -Path $backupRootDir | Out-Null
}

foreach ($extFolder in $agentTargets) {
    try {
        if (-not (Test-Path $extFolder)) {
            New-Item -ItemType Directory -Force -Path $extFolder | Out-Null
        }

        # Auto-limpieza proactiva: Evacuar cualquier carpeta .bak* o .old* residual que cause colisiones en Gentle-Shell
        Get-ChildItem -Path $extFolder -Directory -Filter "cpamc-auto-switcher.bak*" -ErrorAction SilentlyContinue | ForEach-Object {
            $evacDest = Join-Path $backupRootDir $_.Name
            Move-Item -Force -Path $_.FullName -Destination $evacDest -ErrorAction SilentlyContinue
            Write-Host "  🧹 Respaldo duplicado evacuado automáticamente a: $evacDest" -ForegroundColor DarkGray
        }

        $dest = Join-Path $extFolder "cpamc-auto-switcher"
        
        # Respaldo seguro si ya existía una versión anterior (SIEMPRE fuera de extensions/)
        if (Test-Path $dest) {
            $backupDest = Join-Path $backupRootDir "cpamc-auto-switcher.bak-$timestamp"
            Copy-Item -Recurse -Force -Path $dest -Destination $backupDest
            Write-Host "  📦 Versión previa respaldada de forma segura en: $backupDest" -ForegroundColor DarkGray
            Remove-Item -Recurse -Force -Path $dest
        }

        Copy-Item -Recurse -Force -Path $extSource -Destination $dest
        Write-Host "  ✓ Extensión instalada en: $dest" -ForegroundColor Green
        $extInstalledCount++

        # Sincronizar subagentes y agentes en el home del agente
        $agentHome = Split-Path -Parent $extFolder
        if ($subagentsSource -and (Test-Path $subagentsSource)) {
            $destSubagents = Join-Path $agentHome "subagents"
            if (-not (Test-Path $destSubagents)) {
                New-Item -ItemType Directory -Force -Path $destSubagents | Out-Null
            }
            Copy-Item -Recurse -Force -Path (Join-Path $subagentsSource "*") -Destination $destSubagents
            Write-Host "  ✓ Subagentes Planned Workflow sincronizados en: $destSubagents" -ForegroundColor Green
        }
        if ($agentsSource -and (Test-Path $agentsSource)) {
            $destAgents = Join-Path $agentHome "agents"
            if (-not (Test-Path $destAgents)) {
                New-Item -ItemType Directory -Force -Path $destAgents | Out-Null
            }
            Copy-Item -Recurse -Force -Path (Join-Path $agentsSource "*") -Destination $destAgents
            Write-Host "  ✓ Agentes Gentle AI sincronizados en: $destAgents" -ForegroundColor Green
        }
        if ($skillsSource -and (Test-Path $skillsSource)) {
            $destSkills = Join-Path $agentHome "skills"
            if (-not (Test-Path $destSkills)) {
                New-Item -ItemType Directory -Force -Path $destSkills | Out-Null
            }
            Copy-Item -Recurse -Force -Path (Join-Path $skillsSource "*") -Destination $destSkills
            Write-Host "  ✓ Skills transversales sincronizados en: $destSkills" -ForegroundColor Green
        }
    } catch {
        Write-Warning "No se pudo instalar en ${extFolder}: $_"
    }
}

# ------------------------------------------------------------------------------
# 2. DETECCIÓN DINÁMICA DE CPAMC (PROCESOS + RUTAS) Y CONFIGURACIÓN DEL PLUGIN
# ------------------------------------------------------------------------------
$pluginInstalled = $false

if (-not $ExtensionOnly) {
    Write-Host "`n[Paso 2/2] Detectando servidor CPAMC (CLIProxyAPI)..." -ForegroundColor Yellow

    $discoveredRoots = [System.Collections.Generic.List[string]]::new()

    # A. Ruta explícita pasada por parámetro
    if ($CpamcDir -and (Test-Path $CpamcDir)) {
        $discoveredRoots.Add((Resolve-Path $CpamcDir).Path)
    }

    # B. Detección por procesos activos en RAM (cli-proxy-api o CLIProxyAPI)
    try {
        Get-Process -ErrorAction SilentlyContinue | Where-Object { 
            $_.ProcessName -match "^(cli-proxy-api|CLIProxyAPI)$" 
        } | ForEach-Object {
            try {
                if ($_.MainModule.FileName) {
                    $procDir = Split-Path -Parent $_.MainModule.FileName
                    if ($procDir -and (Test-Path $procDir) -and -not $discoveredRoots.Contains($procDir)) {
                        Write-Host "  🔍 Detectado proceso activo de CPAMC: $($_.ProcessName) en $procDir" -ForegroundColor Cyan
                        $discoveredRoots.Add($procDir)
                    }
                }
            } catch {}
        }
    } catch {}

    # C. Exploración dinámica de rutas en el sistema
    $searchPaths = @(
        ".",
        (Join-Path $env:USERPROFILE "Applications\CLIProxyAPI"),
        (Join-Path $env:USERPROFILE "Applications\cli-proxy-api"),
        (Join-Path $env:USERPROFILE "services\cliproxy"),
        (Join-Path $env:USERPROFILE "cliproxy"),
        (Join-Path $env:LOCALAPPDATA "Programs\CLIProxyAPI"),
        "C:\cliproxy",
        "C:\CLIProxyAPI",
        "D:\cliproxy"
    )

    foreach ($path in $searchPaths) {
        if ($path -and (Test-Path $path)) {
            $resolved = (Resolve-Path $path).Path
            if (-not $discoveredRoots.Contains($resolved)) {
                $discoveredRoots.Add($resolved)
            }
        }
    }

    # Evaluar candidatos que posean el ejecutable o config.yaml
    $targetCpamc = $null
    foreach ($cand in $discoveredRoots) {
        $hasExe = (Test-Path (Join-Path $cand "cli-proxy-api.exe")) -or (Test-Path (Join-Path $cand "CLIProxyAPI.exe"))
        $hasCfg = Test-Path (Join-Path $cand "config.yaml")
        if ($hasExe -or $hasCfg) {
            $targetCpamc = $cand
            break
        }
    }

    if ($targetCpamc) {
        Write-Host "  ✓ Servidor CPAMC localizado en: $targetCpamc" -ForegroundColor Green
        
        $pluginsDir = Join-Path $targetCpamc "plugins"
        if (-not (Test-Path $pluginsDir)) {
            New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null
        }

        $targetDll = Join-Path $pluginsDir "auto-switcher-pro-windows-amd64.dll"
        $dllAcquired = $false

        # Verificar si la DLL existente está bloqueada por el proceso de CPAMC
        $canWriteDll = $true
        if (Test-Path $targetDll) {
            try {
                $testStream = [System.IO.File]::Open($targetDll, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
                $testStream.Close()
            } catch {
                $canWriteDll = $false
            }
        }

        if (-not $canWriteDll) {
            Write-Host "  ⚠️ La biblioteca DLL actual está bloqueada en memoria por CPAMC en ejecución." -ForegroundColor Yellow
            $resp = Read-Host "  ¿Deseas reiniciar grácilmente el proceso para actualizar el plugin? [S/n]"
            if ($resp -match "^[nN]") {
                Write-Host "  Reemplazo de DLL omitido por solicitud del usuario." -ForegroundColor DarkGray
            } else {
                Stop-Process -Name "cli-proxy-api", "CLIProxyAPI" -Force -ErrorAction SilentlyContinue
                Start-Sleep -Milliseconds 800
            }
        }

        # 1. Usar binario local si existe con sustitución temporal segura
        $tmpDll = "$targetDll.tmp-$timestamp"
        if ($binSource -and (Test-Path $binSource)) {
            Copy-Item -Force -Path $binSource -Destination $tmpDll
            if (Test-Path $targetDll) {
                $oldDll = "$targetDll.old"
                Remove-Item -Force -Path $oldDll -ErrorAction SilentlyContinue
                Move-Item -Force -Path $targetDll -Destination $oldDll -ErrorAction SilentlyContinue
            }
            Move-Item -Force -Path $tmpDll -Destination $targetDll
            Remove-Item -Force -Path "$targetDll.old" -ErrorAction SilentlyContinue
            $dllAcquired = $true
            Write-Host "  ✓ Plugin DLL instalado mediante sustitución atómica." -ForegroundColor Green
        } else {
            # 2. Descargar DLL desde Release oficial de GitHub
            Write-Host "  Descargando DLL oficial para Windows desde GitHub Releases..." -ForegroundColor Gray
            $releaseUrls = @(
                "https://github.com/WiloxDev/cpamc-auto-switcher-pro/releases/latest/download/auto-switcher-pro-windows-amd64.dll",
                "https://github.com/WiloxDev/cpamc-auto-switcher-pro/releases/download/v0.1.0/auto-switcher-pro-windows-amd64.dll"
            )
            foreach ($u in $releaseUrls) {
                try {
                    Invoke-WebRequest -Uri $u -OutFile $tmpDll -ErrorAction Stop
                    if ((Test-Path $tmpDll) -and ((Get-Item $tmpDll).Length -gt 1000000)) {
                        if (Test-Path $targetDll) {
                            $oldDll = "$targetDll.old"
                            Remove-Item -Force -Path $oldDll -ErrorAction SilentlyContinue
                            Move-Item -Force -Path $targetDll -Destination $oldDll -ErrorAction SilentlyContinue
                        }
                        Move-Item -Force -Path $tmpDll -Destination $targetDll
                        Remove-Item -Force -Path "$targetDll.old" -ErrorAction SilentlyContinue
                        $dllAcquired = $true
                        Write-Host "  ✓ Plugin DLL descargado e instalado exitosamente." -ForegroundColor Green
                        break
                    }
                } catch {
                    Remove-Item -Force -Path $tmpDll -ErrorAction SilentlyContinue
                }
            }
        }

        if ($dllAcquired) {
            $pluginInstalled = $true

            # Configuración dinámica y atómica en config.yaml
            $configFile = Join-Path $targetCpamc "config.yaml"
            if (Test-Path $configFile) {
                $cfgContent = Get-Content -Raw -Path $configFile -Encoding UTF8
                if ($cfgContent -notmatch "auto-switcher-pro-windows-amd64") {
                    Write-Host "  Actualizando configuración de plugins en config.yaml..." -ForegroundColor Cyan
                    
                    # Backup previo de config.yaml
                    $cfgBackup = "$configFile.bak-auto-switcher-$timestamp"
                    Copy-Item -Path $configFile -Destination $cfgBackup -Force
                    Write-Host "  📦 Copia de respaldo guardada en: $cfgBackup" -ForegroundColor DarkGray

                    if ($cfgContent -match "plugins:\s*\r?\n\s*enabled:\s*true") {
                        # Inyectar bajo configs:
                        if ($cfgContent -match "configs:") {
                            $cfgContent = $cfgContent -replace "(configs:\r?\n)", "`$1        auto-switcher-pro-windows-amd64:`r`n            enabled: true`r`n"
                        } else {
                            $cfgContent = $cfgContent -replace "(plugins:\s*\r?\n\s*enabled:\s*true\r?\n)", "`$1    dir: plugins`r`n    configs:`r`n        auto-switcher-pro-windows-amd64:`r`n            enabled: true`r`n"
                        }
                    } else {
                        # Añadir bloque completo de plugins al inicio
                        $pluginBlock = "plugins:`r`n    enabled: true`r`n    dir: plugins`r`n    configs:`r`n        auto-switcher-pro-windows-amd64:`r`n            enabled: true`r`n"
                        $cfgContent = $pluginBlock + $cfgContent
                    }
                    
                    Set-Content -Path $configFile -Value $cfgContent -Encoding UTF8
                    Write-Host "  ✓ Plugin activado correctamente en config.yaml" -ForegroundColor Green
                } else {
                    Write-Host "  ✓ Plugin ya se encontraba habilitado en config.yaml" -ForegroundColor DarkGreen
                }
            }
        } else {
            Write-Warning "No se pudo obtener la biblioteca DLL precompilada para Windows."
            Write-Warning "Si estás usando Docker Desktop en Windows, CPAMC usa el contenedor Linux oficial con .so."
        }
    } elseif (-not $ExtensionOnly) {
        # Fase 2: Comprobación inteligente de puerto :8317 antes de asumir ausencia o colisión
        $portInUse = $false
        $portResponding = $false
        try {
            $tcp = New-Object System.Net.Sockets.TcpClient
            $asyncResult = $tcp.BeginConnect("127.0.0.1", 8317, $null, $null)
            $wait = $asyncResult.AsyncWaitHandle.WaitOne(800, $false)
            if ($wait -and $tcp.Connected) {
                $portInUse = $true
                $tcp.EndConnect($asyncResult)
                $tcp.Close()
                try {
                    $probe = Invoke-RestMethod -Uri "http://localhost:8317" -TimeoutSec 1 -ErrorAction SilentlyContinue
                    $portResponding = $true
                } catch {
                    # Si respondió con cualquier código HTTP (200, 401, 404), el servidor está vivo
                    if ($_.Exception.Response) { $portResponding = $true }
                }
            }
        } catch {}

        if ($portResponding) {
            Write-Host "`n  🌐 ¡Detectada instancia activa respondiendo en http://localhost:8317!" -ForegroundColor Green
            Write-Host "     ↳ Se adopta automáticamente la instancia existente sin forzar un nuevo proceso." -ForegroundColor DarkGray
            $pluginInstalled = $true
            $Url = "http://localhost:8317"
        } else {
            Write-Host "`n  ⚠️ No se detectó CPAMC (CLIProxyAPI) en ejecución en este equipo." -ForegroundColor Yellow
            $installChoice = Read-Host "  ¿Deseas descargar e instalar automáticamente CLIProxyAPI oficial para Windows (router-for-me/CLIProxyAPI)? [S/n]"
            if ([string]::IsNullOrWhiteSpace($installChoice) -or $installChoice -match "^[sSyY]") {
                $cpamcHome = Join-Path $env:USERPROFILE "cliproxyapi"
                $pluginsDir = Join-Path $cpamcHome "plugins"
                if (-not (Test-Path $pluginsDir)) {
                    New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null
                }

                Write-Host "  ⚡ Descargando paquete oficial CLIProxyAPI para Windows..." -ForegroundColor Cyan
                $releaseApi = "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest"
                $dlUrl = $null
                try {
                    $releaseJson = Invoke-RestMethod -Uri $releaseApi -Headers @{ "User-Agent" = "AutoSwitcherPro-Installer" } -TimeoutSec 5
                    $asset = $releaseJson.assets | Where-Object { $_.name -match "CLIProxyAPI_.*_windows_amd64\.zip" } | Select-Object -First 1
                    if ($asset) { $dlUrl = $asset.browser_download_url }
                } catch {}

                if (-not $dlUrl) {
                    $dlUrl = "https://github.com/router-for-me/CLIProxyAPI/releases/latest/download/CLIProxyAPI_8.0.46_windows_amd64.zip"
                }

                $zipPath = Join-Path $env:TEMP "cliproxyapi-windows.zip"
                try {
                    Invoke-WebRequest -Uri $dlUrl -OutFile $zipPath -ErrorAction Stop
                    Expand-Archive -Path $zipPath -DestinationPath $cpamcHome -Force
                    Remove-Item -Force -Path $zipPath -ErrorAction SilentlyContinue
                    Write-Host "  ✓ Servidor oficial CLIProxyAPI extraído en: $cpamcHome" -ForegroundColor Green

                    # Instalar DLL del plugin
                    $targetDll = Join-Path $pluginsDir "auto-switcher-pro-windows-amd64.dll"
                    if ($binSource -and (Test-Path $binSource)) {
                        Copy-Item -Force -Path $binSource -Destination $targetDll
                        Write-Host "  ✓ auto-switcher-pro-windows-amd64.dll copiada desde paquete local." -ForegroundColor Green
                    } else {
                        $dlDll = "https://github.com/WiloxDev/cpamc-auto-switcher-pro/releases/latest/download/auto-switcher-pro-windows-amd64.dll"
                        try {
                            Invoke-WebRequest -Uri $dlDll -OutFile $targetDll -ErrorAction Stop
                            Write-Host "  ✓ auto-switcher-pro-windows-amd64.dll descargada exitosamente." -ForegroundColor Green
                        } catch {}
                    }

                    # Generar Claves Criptográficas Seguras (Dual: Admin + Consumo API)
                    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
                    
                    # 1. Management Secret Key (para /management.html y /v8/management/*)
                    $mgmtBytes = New-Object byte[] 16
                    $rng.GetBytes($mgmtBytes)
                    $genMgmtKey = [System.BitConverter]::ToString($mgmtBytes).Replace("-", "").ToLower()

                    # 2. Client API Key (para consumo de modelos en /v1/models y Gentle-Shell)
                    $apiBytes = New-Object byte[] 16
                    $rng.GetBytes($apiBytes)
                    $genApiKey = "sk-" + [System.BitConverter]::ToString($apiBytes).Replace("-", "").ToLower()

                    $Key = $genMgmtKey
                    $Url = "http://localhost:8317"

                    # Guardar ambas claves en archivos canónicos locales seguros
                    try {
                        $mgmtKeyFile = Join-Path $env:USERPROFILE ".cliproxy_management_key"
                        Set-Content -Path $mgmtKeyFile -Value $genMgmtKey -Encoding UTF8 -Force
                        
                        $apiKeyFile = Join-Path $env:USERPROFILE ".cliproxy_api_key"
                        Set-Content -Path $apiKeyFile -Value $genApiKey -Encoding UTF8 -Force
                    } catch {}

                    # Generar config.yaml canónico compatible con CLIProxyAPI v8 oficial (router-for-me)
                    $configFile = Join-Path $cpamcHome "config.yaml"
                    $initialConfig = @"
server:
  port: 8317
management:
  secret-key: "$genMgmtKey"
api-keys:
  - "$genApiKey"
plugins:
  enabled: true
  dir: plugins
  configs:
    auto-switcher-pro-windows-amd64:
      enabled: true
"@
                    Set-Content -Path $configFile -Value $initialConfig -Encoding UTF8
                    Write-Host "  ✓ config.yaml inicial generado con claves de administración (v8) y API separadas." -ForegroundColor Green

                    # Iniciar servidor en segundo plano
                    $exePath = Join-Path $cpamcHome "cli-proxy-api.exe"
                    if (Test-Path $exePath) {
                        Start-Process -FilePath $exePath -ArgumentList "-config config.yaml" -WorkingDirectory $cpamcHome -WindowStyle Minimized
                        Write-Host "  ✓ CLIProxyAPI iniciado en segundo plano (puerto :8317)." -ForegroundColor Green
                        $pluginInstalled = $true

                        # Persistencia opcional y reversible en shell:startup (sin requerir admin)
                        try {
                            $startupFolder = [Environment]::GetFolderPath("Startup")
                            if ($startupFolder -and (Test-Path $startupFolder)) {
                                $shortcutPath = Join-Path $startupFolder "CLIProxyAPI.lnk"
                                $wsh = New-Object -ComObject WScript.Shell
                                $sc = $wsh.CreateShortcut($shortcutPath)
                                $sc.TargetPath = $exePath
                                $sc.Arguments = "-config config.yaml"
                                $sc.WorkingDirectory = $cpamcHome
                                $sc.WindowStyle = 7 # Minimized
                                $sc.Description = "CLIProxyAPI Server Background Startup"
                                $sc.Save()
                                Write-Host "  ✓ Acceso directo creado en Inicio para arranque automático al iniciar sesión." -ForegroundColor Green
                            }
                        } catch {
                            Write-Warning "No se pudo configurar persistencia en Startup: $_"
                        }
                    }
                } catch {
                    Write-Warning "Fallo al autodesplegar CPAMC en Windows: $_"
                }
            }
        }
    } else {
        Write-Host "  ℹ️  No se detectó un CLIProxyAPI nativo en ejecución ni en rutas habituales." -ForegroundColor Gray
        Write-Host "     Si tu CPAMC corre en Docker (recomendado) o en un servidor remoto," -ForegroundColor Gray
        Write-Host "     solo necesitas la extensión en Gentle-Shell ya instalada." -ForegroundColor Gray
    }
}

# ------------------------------------------------------------------------------
# 3. GOBERNANZA DE VARIABLES DE ENTORNO (NO DESTRUCTIVA)
# ------------------------------------------------------------------------------
$currentUrl = [Environment]::GetEnvironmentVariable("CLIPROXYAPI_BASE_URL", "User")
if ([string]::IsNullOrWhiteSpace($currentUrl)) {
    $currentUrl = $env:CLIPROXYAPI_BASE_URL
}

if (-not [string]::IsNullOrWhiteSpace($Url)) {
    # El usuario pasó un parámetro explícito -Url
    [Environment]::SetEnvironmentVariable("CLIPROXYAPI_BASE_URL", $Url.TrimEnd("/"), "User")
    $env:CLIPROXYAPI_BASE_URL = $Url.TrimEnd("/")
    try {
        $urlFile = Join-Path $env:USERPROFILE ".cliproxy_url"
        Set-Content -Path $urlFile -Value $Url.TrimEnd("/") -Encoding utf8 -Force
    } catch {}
    Write-Host "`n🌐 CLIPROXYAPI_BASE_URL configurada explícitamente como: $Url" -ForegroundColor Cyan
} elseif ([string]::IsNullOrWhiteSpace($currentUrl)) {
    # No existe configuración previa: sugerir o establecer localhost
    $defaultBase = "http://localhost:8317"
    [Environment]::SetEnvironmentVariable("CLIPROXYAPI_BASE_URL", $defaultBase, "User")
    $env:CLIPROXYAPI_BASE_URL = $defaultBase
    try {
        $urlFile = Join-Path $env:USERPROFILE ".cliproxy_url"
        Set-Content -Path $urlFile -Value $defaultBase -Encoding utf8 -Force
    } catch {}
    Write-Host "`n🌐 CLIPROXYAPI_BASE_URL inicializada en: $defaultBase" -ForegroundColor Cyan
} else {
    try {
        $urlFile = Join-Path $env:USERPROFILE ".cliproxy_url"
        Set-Content -Path $urlFile -Value $currentUrl.TrimEnd("/") -Encoding utf8 -Force
    } catch {}
    Write-Host "`n🌐 CLIPROXYAPI_BASE_URL preservada: $currentUrl" -ForegroundColor DarkCyan
}

if (-not [string]::IsNullOrWhiteSpace($Key)) {
    [Environment]::SetEnvironmentVariable("CLIPROXYAPI_MANAGEMENT_KEY", $Key.Trim(), "User")
    $env:CLIPROXYAPI_MANAGEMENT_KEY = $Key.Trim()
    Write-Host "🔑 CLIPROXYAPI_MANAGEMENT_KEY configurada con éxito." -ForegroundColor Cyan
}

# Configuración de CLIPROXYAPI_API_KEY para consumo de modelos en /v1/models
$currentApiKey = [Environment]::GetEnvironmentVariable("CLIPROXYAPI_API_KEY", "User")
if ([string]::IsNullOrWhiteSpace($currentApiKey) -and -not [string]::IsNullOrWhiteSpace($genApiKey)) {
    [Environment]::SetEnvironmentVariable("CLIPROXYAPI_API_KEY", $genApiKey, "User")
    $env:CLIPROXYAPI_API_KEY = $genApiKey
    Write-Host "🔑 CLIPROXYAPI_API_KEY configurada con éxito para consumo de modelos." -ForegroundColor Cyan
} elseif (-not [string]::IsNullOrWhiteSpace($currentApiKey)) {
    $env:CLIPROXYAPI_API_KEY = $currentApiKey
}

# ------------------------------------------------------------------------------
# 3.0. INYECCIÓN INMUNE EN SETTINGS.JSON (ANTI "TERMINAL FANTASMA")
# ------------------------------------------------------------------------------
# Escribir de inmediato en settings.json de cada perfil detectado para que Gentle-Shell
# herede las credenciales en la sesión actual sin obligar a reiniciar la ventana de terminal
foreach ($extFolder in $agentTargets) {
    try {
        $agentHome = Split-Path -Parent $extFolder
        $settingsFile = Join-Path $agentHome "settings.json"
        
        $effectiveUrl = if (-not [string]::IsNullOrWhiteSpace($Url)) { $Url.TrimEnd("/") } else { $defaultBase }
        $effectiveApiKey = if (-not [string]::IsNullOrWhiteSpace($env:CLIPROXYAPI_API_KEY)) { $env:CLIPROXYAPI_API_KEY } else { $genApiKey }
        $effectiveMgmtKey = if (-not [string]::IsNullOrWhiteSpace($env:CLIPROXYAPI_MANAGEMENT_KEY)) { $env:CLIPROXYAPI_MANAGEMENT_KEY } else { $Key }

        $jsonObj = @{}
        if (Test-Path $settingsFile) {
            try {
                $rawContent = Get-Content -Raw -Path $settingsFile -Encoding UTF8
                if (-not [string]::IsNullOrWhiteSpace($rawContent)) {
                    $jsonObj = $rawContent | ConvertFrom-Json -AsHashtable
                }
            } catch {}
        }

        if (-not $jsonObj.ContainsKey("cpamc")) {
            $jsonObj["cpamc"] = @{}
        }

        $jsonObj["cpamc"]["baseUrl"] = $effectiveUrl
        if (-not [string]::IsNullOrWhiteSpace($effectiveApiKey)) {
            $jsonObj["cpamc"]["apiKey"] = $effectiveApiKey
        }
        if (-not [string]::IsNullOrWhiteSpace($effectiveMgmtKey)) {
            $jsonObj["cpamc"]["managementKey"] = $effectiveMgmtKey
        }

        $updatedJson = $jsonObj | ConvertTo-Json -Depth 5
        Set-Content -Path $settingsFile -Value $updatedJson -Encoding UTF8 -Force
        Write-Host "  🛡️ Configuración permanente inyectada en: $settingsFile" -ForegroundColor DarkGray
    } catch {}
}

# ------------------------------------------------------------------------------
# 3.1. PARCHEO IDEMPOTENTE DE GENTLE-SHELL LAYOUT EN WINDOWS
# ------------------------------------------------------------------------------
try {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) {
        $patchScript = @"
const fs = require('fs');
try {
    const target = require.resolve('gentle-pi/lib/shell-sidebar-layout.ts');
    if (target && fs.existsSync(target)) {
        let content = fs.readFileSync(target, 'utf8');
        if (!content.includes('cpamc-quota-card')) {
            content = content.replace(/const sections = \[\"footer\",/, 'const sections = [\"footer\", \"cpamc-quota-card\",');
            fs.writeFileSync(target, content, 'utf8');
            console.log('PATCHED');
        } else {
            console.log('ALREADY');
        }
    }
} catch (e) {}
"@
        $res = node -e $patchScript 2>$null
        if ($res -like "*PATCHED*") {
            Write-Host "✓ Layout de Gentle-Shell parcheado exitosamente para cpamc-quota-card." -ForegroundColor Green
        } elseif ($res -like "*ALREADY*") {
            Write-Host "✓ Gentle-Shell layout ya contiene cpamc-quota-card." -ForegroundColor DarkGray
        }
    }
} catch {
    # Ignorar silenciosamente si no está instalado gentle-pi globalmente
}

# ------------------------------------------------------------------------------
# 4. LIMPIEZA Y REPORTE FINAL HONESTO CON TEST DE FUEGO INTERACTIVO
# ------------------------------------------------------------------------------
if ($tempWorkDir -and (Test-Path $tempWorkDir)) {
    Remove-Item -Recurse -Force -Path $tempWorkDir -ErrorAction SilentlyContinue
}

# Fase 3: TEST DE FUEGO INTERACTIVO (Validar GET /v1/models con Bearer API Key)
$testFuegoOk = $false
$modelsCount = 0
$targetEndpoint = if (-not [string]::IsNullOrWhiteSpace($Url)) { $Url.TrimEnd("/") } else { "http://localhost:8317" }
$testApiKey = if (-not [string]::IsNullOrWhiteSpace($env:CLIPROXYAPI_API_KEY)) { $env:CLIPROXYAPI_API_KEY } else { $genApiKey }

if (-not [string]::IsNullOrWhiteSpace($testApiKey)) {
    Write-Host "`n🔥 Ejecutando Test de Fuego sobre el catálogo de modelos (/v1/models)..." -ForegroundColor Yellow
    try {
        $headers = @{
            "Authorization" = "Bearer $testApiKey"
            "Accept" = "application/json"
        }
        $testRes = Invoke-RestMethod -Uri "$targetEndpoint/v1/models" -Headers $headers -TimeoutSec 3 -ErrorAction Stop
        if ($testRes -and $testRes.data) {
            $testFuegoOk = $true
            $modelsCount = $testRes.data.Count
            Write-Host "  ✅ [TEST DE FUEGO PASS] Catálogo autenticado con éxito ($modelsCount modelos detectados)." -ForegroundColor Green
        } else {
            Write-Host "  ✅ [TEST DE FUEGO PASS] Endpoint /v1/models respondió HTTP 200 con éxito." -ForegroundColor Green
            $testFuegoOk = $true
        }
    } catch {
        $status = $_.Exception.Response.StatusCode.value__
        if ($status -eq 401) {
            Write-Host "  ⚠️ [TEST DE FUEGO] Error de autenticación HTTP 401 en /v1/models. Revisa tu API key." -ForegroundColor Yellow
        } else {
            Write-Host "  ℹ️ [TEST DE FUEGO] Servidor en espera de vinculación de cuentas o en arranque (HTTP $status)." -ForegroundColor DarkGray
        }
    }
}

Write-Host "`n==========================================================" -ForegroundColor Green
if ($extInstalledCount -gt 0 -and ($pluginInstalled -or $ExtensionOnly)) {
    Write-Host "🎉 ¡Instalación Completada con Éxito!" -ForegroundColor Green
} elseif ($extInstalledCount -gt 0) {
    Write-Host "✓ Extensión instalada para Gentle-Shell/Pi." -ForegroundColor Green
    Write-Host "ℹ️  Nota: Servidor CPAMC en Windows no requirió DLL nativa (usa Docker o servidor remoto)." -ForegroundColor DarkGray
} else {
    Write-Host "⚠️  Instalación finalizada con advertencias (ver registros superiores)." -ForegroundColor Yellow
}
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "🌐 Endpoint CPAMC activo: $defaultBase" -ForegroundColor Cyan
$savedKeyFile = Join-Path $env:USERPROFILE ".cliproxy_management_key"
if (Test-Path $savedKeyFile) {
    Write-Host "🔑 Clave de Administración: Guardada en tu archivo local seguro:" -ForegroundColor Green
    Write-Host "   $savedKeyFile" -ForegroundColor Yellow
}
$savedApiKeyFile = Join-Path $env:USERPROFILE ".cliproxy_api_key"
if (Test-Path $savedApiKeyFile) {
    Write-Host "🔑 Clave de Consumo API (Modelos): Guardada en tu archivo local seguro:" -ForegroundColor Green
    Write-Host "   $savedApiKeyFile" -ForegroundColor Yellow
}

Write-Host "`n🚀 PASOS PARA EMPEZAR:" -ForegroundColor White
Write-Host "  1. Abre la consola web de CPAMC para vincular tu primera cuenta:" -ForegroundColor Gray
Write-Host "     http://localhost:8317/management.html" -ForegroundColor Cyan
Write-Host "     (Ingresa tu Management Key si la consola te la solicita)" -ForegroundColor DarkGray
Write-Host "  2. En esta misma terminal (o en una nueva), ejecuta tu agente:" -ForegroundColor Gray
Write-Host "     gentle-shell" -ForegroundColor Yellow
Write-Host "  3. Escribe /model para seleccionar tus modelos balanceados." -ForegroundColor Gray
