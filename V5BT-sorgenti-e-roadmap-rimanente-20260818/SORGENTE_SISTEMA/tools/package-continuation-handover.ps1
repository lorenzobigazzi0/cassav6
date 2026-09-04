param(
  [string]$WorkspaceRoot = "D:\cassav2",
  [string]$OutputDirectory = "$env:USERPROFILE\Desktop",
  [string]$Timestamp = (Get-Date -Format "yyyyMMdd-HHmmss")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$activeSourceName = "sistema-cassa-refactor-p4-p7-20260713-source"
$packageName = "CASSAV4_HANDOVER_COMPLETO_$Timestamp"
$workspaceFull = [System.IO.Path]::GetFullPath($WorkspaceRoot).TrimEnd("\")
$activeSource = Join-Path $workspaceFull $activeSourceName
$stagingBase = Join-Path $workspaceFull "_package_staging"
$stageRoot = Join-Path $stagingBase $packageName
$packageRoot = Join-Path $stageRoot $packageName
$zipPath = Join-Path ([System.IO.Path]::GetFullPath($OutputDirectory)) "$packageName.zip"
$zipChecksumPath = "$zipPath.sha256"

function Assert-ChildPath {
  param([string]$Parent, [string]$Child)
  $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd("\") + "\"
  $childFull = [System.IO.Path]::GetFullPath($Child)
  if (-not $childFull.StartsWith($parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Percorso non sicuro fuori dalla radice prevista: $childFull"
  }
}

function Copy-FilteredTree {
  param([string]$Source, [string]$Destination)
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    throw "Sorgente mancante: $Source"
  }
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  $excludedDirs = @(
    "node_modules", ".git", ".gradle", ".idea", ".cxx", "build",
    "logs", "backups", "screenshots", "test-results", "playwright-report",
    ".print-spool", ".tmp-refactor", ".runtime", ".codex-run", "coverage"
  )
  $excludedFiles = @(
    "*.log", "*.pid", "*.exit", "*.sqlite", "*.sqlite-wal", "*.sqlite-shm",
    "*.db", "*.db-wal", "*.db-shm", "*.pem", "*.key", "*.crt", "*.csr",
    "*.p12", "*.pfx", "*.jks", "*.keystore", "*.bak", "*.bak-*", "*.apk",
    "*.aab", "local.properties", "tsconfig.tsbuildinfo", "app-state.json",
    "mock-db.json", "app-state.before-*.json", "app-state.partial-*.json",
    "palmare-*.png", "current.png"
  )
  $arguments = @(
    $Source, $Destination, "/E", "/COPY:DAT", "/DCOPY:DAT", "/R:1", "/W:1",
    "/XJ", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/XD"
  ) + $excludedDirs + @("/XF") + $excludedFiles
  & robocopy @arguments | Out-Null
  $robocopyExit = $LASTEXITCODE
  if ($robocopyExit -ge 8) {
    throw "Robocopy fallito per $Source con exit code $robocopyExit"
  }
}

function Get-RelativePathUnix {
  param([string]$Root, [string]$Path)
  $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd("\") + "\"
  $pathFull = [System.IO.Path]::GetFullPath($Path)
  $rootUri = New-Object System.Uri($rootFull)
  $pathUri = New-Object System.Uri($pathFull)
  return [System.Uri]::UnescapeDataString($rootUri.MakeRelativeUri($pathUri).ToString()).Replace("\", "/")
}

if (-not (Test-Path -LiteralPath $activeSource -PathType Container)) {
  throw "Workspace attiva non trovata: $activeSource"
}
if (-not (Test-Path -LiteralPath (Join-Path $activeSource "cassa-frontend\backend\server.js"))) {
  throw "Backend corrente non trovato nella workspace attiva."
}

New-Item -ItemType Directory -Path $stagingBase -Force | Out-Null
Assert-ChildPath -Parent $stagingBase -Child $stageRoot
if (Test-Path -LiteralPath $stageRoot) {
  Remove-Item -LiteralPath $stageRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

try {
  Copy-FilteredTree `
    -Source $activeSource `
    -Destination (Join-Path $packageRoot "source\$activeSourceName")

  Copy-FilteredTree `
    -Source (Join-Path $workspaceFull "android-webview-app-source") `
    -Destination (Join-Path $packageRoot "companion\android-webview-app-source")

  Copy-FilteredTree `
    -Source (Join-Path $workspaceFull "Palmare") `
    -Destination (Join-Path $packageRoot "companion\Palmare")

  $workspaceDocs = Join-Path $packageRoot "workspace"
  New-Item -ItemType Directory -Path $workspaceDocs -Force | Out-Null
  foreach ($name in @("WORKSPACE_ATTIVA.md", "IMPORT_VALIDATION_20260713.md")) {
    $sourceFile = Join-Path $workspaceFull $name
    if (Test-Path -LiteralPath $sourceFile -PathType Leaf) {
      Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $workspaceDocs $name)
    }
  }

  $apkDestination = Join-Path $packageRoot "apk"
  New-Item -ItemType Directory -Path $apkDestination -Force | Out-Null
  $apkSources = @(
    (Join-Path $workspaceFull "Palmare\Palmare-1.0.0-debug.apk"),
    (Join-Path $workspaceFull "apk\app-debug.apk"),
    (Join-Path $workspaceFull "apk\app-debug-networkfix-20260706.apk")
  )
  foreach ($apkSource in $apkSources) {
    if (Test-Path -LiteralPath $apkSource -PathType Leaf) {
      Copy-Item -LiteralPath $apkSource -Destination $apkDestination
    }
  }

  $handoverSource = Join-Path $activeSource "CODEX_HANDOVER_CONTINUAZIONE_20260713.md"
  Copy-Item -LiteralPath $handoverSource -Destination (Join-Path $packageRoot "LEGGIMI_PRIMA.md")

  $packageInfo = [ordered]@{
    schemaVersion = 1
    packageName = $packageName
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    authoritativeSource = "source/$activeSourceName"
    roadmap = "source/$activeSourceName/cassa-frontend/ROADMAP_COMPLETAMENTO_P4_P7_20260713.md"
    nextTask = "P4.3 waiter pause/start/stop measurement and architecture audit"
    included = @(
      "web and backend source trees",
      "P4-P7 roadmap, reports and technical documentation",
      "Android WebView source",
      "Palmare Android and offline web frontend source",
      "available debug APK files"
    )
    excluded = @(
      "installed dependencies and build caches",
      "runtime databases, logs and screenshots",
      "certificates, private keys, CA material and local.properties",
      "old versions and backups"
    )
  }
  $packageInfo | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $packageRoot "PACKAGE_INFO.json") -Encoding utf8

  $excludedMetadata = @("PACKAGE_MANIFEST.tsv", "CHECKSUMS_SHA256.txt")
  $payloadFiles = Get-ChildItem -LiteralPath $packageRoot -File -Recurse -Force |
    Where-Object { $excludedMetadata -notcontains $_.Name } |
    Sort-Object FullName
  $manifestLines = @("BYTES`tPATH")
  $checksumLines = @()
  foreach ($file in $payloadFiles) {
    $relativePath = Get-RelativePathUnix -Root $packageRoot -Path $file.FullName
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifestLines += "$($file.Length)`t$relativePath"
    $checksumLines += "$hash  $relativePath"
  }
  $manifestLines | Set-Content -LiteralPath (Join-Path $packageRoot "PACKAGE_MANIFEST.tsv") -Encoding utf8
  $checksumLines | Set-Content -LiteralPath (Join-Path $packageRoot "CHECKSUMS_SHA256.txt") -Encoding ascii

  $forbidden = @(Get-ChildItem -LiteralPath $packageRoot -File -Recurse -Force | Where-Object {
    $relative = Get-RelativePathUnix -Root $packageRoot -Path $_.FullName
    $relative -match '(^|/)(node_modules|logs|backups|screenshots|\.git|\.gradle|build|test-results|playwright-report)(/|$)' -or
      $_.Name -eq "local.properties" -or
      $_.Extension -match '^\.(log|pid|sqlite|db|pem|key|crt|csr|p12|pfx|jks|keystore)$'
  })
  if ($forbidden.Count -gt 0) {
    $sample = ($forbidden | Select-Object -First 10 -ExpandProperty FullName) -join "`n"
    throw "Lo staging contiene file vietati:`n$sample"
  }

  if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
  }
  if (Test-Path -LiteralPath $zipChecksumPath) {
    Remove-Item -LiteralPath $zipChecksumPath -Force
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stageRoot,
    $zipPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )

  $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $entryNames = @($archive.Entries | ForEach-Object { $_.FullName.Replace("\", "/") })
    $requiredPrefixes = @(
      "$packageName/source/$activeSourceName/cassa-frontend/backend/server.js",
      "$packageName/source/$activeSourceName/cassa-frontend/ROADMAP_COMPLETAMENTO_P4_P7_20260713.md",
      "$packageName/source/$activeSourceName/mobile-frontend/src/",
      "$packageName/source/$activeSourceName/postazione/src/",
      "$packageName/source/$activeSourceName/battery-dashboard/src/",
      "$packageName/companion/android-webview-app-source/app/src/",
      "$packageName/companion/Palmare/android-app/app/src/",
      "$packageName/companion/Palmare/web-frontend/src/",
      "$packageName/apk/",
      "$packageName/LEGGIMI_PRIMA.md",
      "$packageName/CHECKSUMS_SHA256.txt"
    )
    foreach ($requiredPrefix in $requiredPrefixes) {
      if (-not ($entryNames | Where-Object { $_.StartsWith($requiredPrefix, [System.StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1)) {
        throw "Percorso obbligatorio assente dallo ZIP: $requiredPrefix"
      }
    }
    $forbiddenArchiveEntries = @($entryNames | Where-Object {
      $_ -match '(^|/)(node_modules|logs|backups|screenshots|\.git|\.gradle|build|test-results|playwright-report)(/|$)' -or
        $_ -match '/local\.properties$' -or
        $_ -match '\.(log|pid|sqlite|db|pem|key|crt|csr|p12|pfx|jks|keystore)$'
    })
    if ($forbiddenArchiveEntries.Count -gt 0) {
      throw "Lo ZIP contiene $($forbiddenArchiveEntries.Count) entry vietate."
    }
    $entryCount = $archive.Entries.Count
  } finally {
    $archive.Dispose()
  }

  $zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  "$zipHash  $([System.IO.Path]::GetFileName($zipPath))" | Set-Content -LiteralPath $zipChecksumPath -Encoding ascii
  $zipInfo = Get-Item -LiteralPath $zipPath
  [ordered]@{
    zipPath = $zipPath
    checksumPath = $zipChecksumPath
    sha256 = $zipHash
    bytes = $zipInfo.Length
    entries = $entryCount
    forbiddenEntries = 0
  } | ConvertTo-Json -Depth 3
} finally {
  Assert-ChildPath -Parent $stagingBase -Child $stageRoot
  if (Test-Path -LiteralPath $stageRoot) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
  }
}
