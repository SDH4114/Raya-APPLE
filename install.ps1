# Raya Windows installer
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$RepoUrl = if ($env:RAYA_REPO_URL) { $env:RAYA_REPO_URL } else { "https://github.com/SDH4114/Raya-APPLE.git" }
$RepoRef = if ($env:RAYA_REPO_REF) { $env:RAYA_REPO_REF } else { "prime" }
$NodeMajor = if ($env:RAYA_NODE_MAJOR) { [int]$env:RAYA_NODE_MAJOR } else { 22 }
$RayaStateDir = if ($env:RAYA_HOME) { $env:RAYA_HOME } else { Join-Path $HOME ".raya" }

function Test-Command {
  param([Parameter(Mandatory = $true)][string]$Name)
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Refresh-ProcessPath {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = (@($machine, $user, $env:Path) | Where-Object { $_ }) -join ";"
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath exited with code $LASTEXITCODE."
  }
}

function Ensure-WingetPackage {
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [Parameter(Mandatory = $true)][string]$Description
  )
  if (-not (Test-Command "winget.exe")) {
    throw "$Description is required. Install it manually or install App Installer (winget), then run this command again."
  }
  Write-Host "Installing $Description..."
  Invoke-Checked "winget.exe" @(
    "install", "--id", $Id, "--exact", "--silent",
    "--accept-package-agreements", "--accept-source-agreements"
  )
  Refresh-ProcessPath
}

function Test-PathInside {
  param(
    [Parameter(Mandatory = $true)][string]$Parent,
    [Parameter(Mandatory = $true)][string]$Child
  )
  $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd([char[]]"\/")
  $childPath = [IO.Path]::GetFullPath($Child).TrimEnd([char[]]"\/")
  return $childPath.Equals($parentPath, [StringComparison]::OrdinalIgnoreCase) -or
    $childPath.StartsWith("$parentPath$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)
}

$RayaWasInstalled = (Test-Command "raya") -or (Test-Command "raya.cmd")
$LegacyUpdateCheckpoint = $RayaWasInstalled -and $env:RAYA_UPDATE_CHECKPOINT_CREATED -ne "1"
$PreserveRayaState = $env:RAYA_UPDATE_MODE -eq "1" -or (Test-Path -LiteralPath $RayaStateDir) -or $RayaWasInstalled

$NeedNode = -not (Test-Command "node.exe")
if (-not $NeedNode) {
  $CurrentMajor = [int]((& node.exe -p "process.versions.node.split('.')[0]").Trim())
  $NeedNode = $CurrentMajor -lt $NodeMajor
}
if ($NeedNode) {
  Ensure-WingetPackage "OpenJS.NodeJS.LTS" "Node.js $NodeMajor or newer"
}
if (-not (Test-Command "node.exe")) {
  throw "Node.js installation completed, but node.exe is not available in PATH. Open a new PowerShell window and run the installer again."
}
$InstalledNodeMajor = [int]((& node.exe -p "process.versions.node.split('.')[0]").Trim())
if ($InstalledNodeMajor -lt $NodeMajor) {
  throw "Raya requires Node.js $NodeMajor or newer; PATH still resolves Node.js $InstalledNodeMajor."
}
if (-not (Test-Command "npm.cmd")) {
  throw "npm.cmd was not found after Node.js setup."
}

if (-not (Test-Command "git.exe")) {
  Ensure-WingetPackage "Git.Git" "Git for Windows"
}
if (-not (Test-Command "git.exe")) {
  throw "Git installation completed, but git.exe is not available in PATH. Open a new PowerShell window and run the installer again."
}

$TemporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "raya-install-$([Guid]::NewGuid().ToString('N'))"
$Checkout = Join-Path $TemporaryRoot "raya"
New-Item -ItemType Directory -Path $TemporaryRoot | Out-Null

try {
  Write-Host "Downloading Raya from $RepoUrl#$RepoRef..."
  if ($RepoRef -match "^[0-9a-fA-F]{40}$") {
    Invoke-Checked "git.exe" @("init", $Checkout)
    Invoke-Checked "git.exe" @("-C", $Checkout, "remote", "add", "origin", $RepoUrl)
    Invoke-Checked "git.exe" @("-C", $Checkout, "fetch", "--depth", "1", "origin", $RepoRef)
    Invoke-Checked "git.exe" @("-C", $Checkout, "checkout", "--detach", "FETCH_HEAD")
  } else {
    Invoke-Checked "git.exe" @("clone", "--depth", "1", "--branch", $RepoRef, $RepoUrl, $Checkout)
  }

  Push-Location $Checkout
  try {
    Invoke-Checked "npm.cmd" @("ci", "--ignore-scripts")
    Invoke-Checked "npm.cmd" @("run", "build")
    $PackOutput = & npm.cmd pack --ignore-scripts --pack-destination $TemporaryRoot
    if ($LASTEXITCODE -ne 0) { throw "npm pack exited with code $LASTEXITCODE." }
    $PackageTarball = ($PackOutput | Select-Object -Last 1).ToString().Trim()
    $PackagePath = Join-Path $TemporaryRoot $PackageTarball
    if (-not (Test-Path -LiteralPath $PackagePath -PathType Leaf)) {
      throw "npm pack did not create the Raya package archive."
    }

    if ($LegacyUpdateCheckpoint) {
      $NpmRoot = (& npm.cmd root -g).Trim()
      if ($LASTEXITCODE -ne 0) { throw "Could not locate npm's global package directory." }
      $InstalledRoot = Join-Path $NpmRoot "@sdh4114\raya"
      if (-not (Test-Path -LiteralPath $InstalledRoot -PathType Container)) {
        throw "Could not locate the currently installed Raya package for the update checkpoint."
      }

      $CurrentVersion = (Get-Content -LiteralPath (Join-Path $InstalledRoot "package.json") -Raw | ConvertFrom-Json).version
      $TargetVersion = (Get-Content -LiteralPath (Join-Path $Checkout "package.json") -Raw | ConvertFrom-Json).version
      $BackupRoot = if ($env:RAYA_BACKUP_ROOT) { $env:RAYA_BACKUP_ROOT } else { Join-Path $HOME "raya-backups" }
      if (Test-PathInside $RayaStateDir $BackupRoot) {
        throw "RAYA_BACKUP_ROOT must be outside RAYA_HOME: $BackupRoot"
      }
      New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null

      $Timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ")
      $BaseName = "update-$CurrentVersion-to-$TargetVersion-$Timestamp"
      $Checkpoint = Join-Path $BackupRoot $BaseName
      $Number = 2
      while (Test-Path -LiteralPath $Checkpoint) {
        $Checkpoint = Join-Path $BackupRoot "$BaseName-$Number"
        $Number += 1
      }
      New-Item -ItemType Directory -Path $Checkpoint | Out-Null

      $OldPackOutput = & npm.cmd pack --ignore-scripts --pack-destination $Checkpoint $InstalledRoot
      if ($LASTEXITCODE -ne 0) { throw "Could not package the currently installed Raya." }
      $OldArchive = ($OldPackOutput | Select-Object -Last 1).ToString().Trim()
      Move-Item -LiteralPath (Join-Path $Checkpoint $OldArchive) -Destination (Join-Path $Checkpoint "raya-package.tgz")
      $CheckpointState = Join-Path $Checkpoint ".raya"
      if (Test-Path -LiteralPath $RayaStateDir) {
        Copy-Item -LiteralPath $RayaStateDir -Destination $CheckpointState -Recurse -Force
      } else {
        New-Item -ItemType Directory -Path $CheckpointState | Out-Null
      }
      $ManifestJson = @{
        id = $BaseName
        name = "Before update v$CurrentVersion to v$TargetVersion"
        createdAt = [DateTime]::UtcNow.ToString("o")
        rayaVersion = $CurrentVersion
        mode = "local"
        secretsIncluded = $true
        kind = "update-checkpoint"
        targetVersion = $TargetVersion
      } | ConvertTo-Json
      [IO.File]::WriteAllText(
        (Join-Path $Checkpoint "manifest.json"),
        "$ManifestJson$([Environment]::NewLine)",
        [Text.UTF8Encoding]::new($false)
      )
      Write-Host "Created compatibility checkpoint: $Checkpoint"
      $env:RAYA_UPDATE_CHECKPOINT_CREATED = "1"
    }

    Invoke-Checked "npm.cmd" @("install", "-g", "--ignore-scripts", $PackagePath)
    $NpmPrefix = (& npm.cmd prefix -g).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Could not read npm's global prefix." }
    $RayaCommand = Join-Path $NpmPrefix "raya.cmd"
    if (-not (Test-Path -LiteralPath $RayaCommand -PathType Leaf)) {
      throw "Raya was installed, but its launcher was not found at $RayaCommand."
    }

    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $UserEntries = @($UserPath -split ";" | Where-Object { $_ })
    if (-not ($UserEntries | Where-Object { $_.TrimEnd([char[]]"\") -ieq $NpmPrefix.TrimEnd([char[]]"\") })) {
      $NewUserPath = (@($UserEntries) + $NpmPrefix) -join ";"
      [Environment]::SetEnvironmentVariable("Path", $NewUserPath, "User")
      Write-Host "Added $NpmPrefix to your user PATH."
    }
    if (-not (($env:Path -split ";") | Where-Object { $_.TrimEnd([char[]]"\") -ieq $NpmPrefix.TrimEnd([char[]]"\") })) {
      $env:Path = "$NpmPrefix;$env:Path"
    }

    if ($PreserveRayaState) {
      Write-Host "Preserved existing Raya state at $RayaStateDir."
    } else {
      Invoke-Checked $RayaCommand @("skills", "sync")
      if (-not (Test-Path -LiteralPath (Join-Path $RayaStateDir "SOUL.md") -PathType Leaf)) {
        throw "Raya initialization did not create $(Join-Path $RayaStateDir 'SOUL.md')."
      }
    }
  } finally {
    Pop-Location
  }
} finally {
  Remove-Item -LiteralPath $TemporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Raya installed."
Write-Host "Next steps:"
Write-Host "  raya login"
Write-Host "  raya"
