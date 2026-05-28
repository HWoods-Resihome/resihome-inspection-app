<#
.SYNOPSIS
    Full deploy loop: wipe repo, extract latest zip, validate, commit, push.

.DESCRIPTION
    Run this AFTER downloading a fresh inspection_app.zip from Claude.
    It will:
      1. Find the latest inspection_app.zip in your Downloads folder
      2. Wipe everything in the current repo folder EXCEPT .git, .gitignore, deploy.ps1, refresh.ps1
      3. Extract the zip contents into this folder
      4. Validate JSON files (and strip BOM if present)
      5. Show what changed
      6. Commit + push to GitHub
    
    Run from inside your git-cloned repo folder.

.PARAMETER Message
    The git commit message. If omitted, prompts for one.

.PARAMETER ZipPath
    Optional. Full path to the zip. Defaults to the newest inspection_app*.zip in ~/Downloads.

.EXAMPLE
    .\refresh.ps1 "v0.19.18 - save status in header"

.EXAMPLE
    .\refresh.ps1
    # Prompts for commit message
#>

param(
    [Parameter(Position=0)]
    [string]$Message,

    [string]$ZipPath
)

$ErrorActionPreference = "Stop"

function Write-Step($text) {
    Write-Host ""
    Write-Host "==> $text" -ForegroundColor Cyan
}

function Write-Ok($text) {
    Write-Host "    OK: $text" -ForegroundColor Green
}

function Write-Fail($text) {
    Write-Host "    FAIL: $text" -ForegroundColor Red
}

# --- Verify repo ---
Write-Step "Checking repo state"
if (-not (Test-Path ".git")) {
    Write-Fail "No .git directory here. cd into your cloned repo folder first."
    exit 1
}
Write-Ok "Git repo detected"

# --- Find the zip ---
Write-Step "Locating zip file"
if (-not $ZipPath) {
    $downloads = "$HOME\Downloads"
    $zip = Get-ChildItem -Path $downloads -Filter "inspection_app*.zip" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $zip) {
        Write-Fail "No inspection_app*.zip in $downloads. Pass -ZipPath explicitly or download the zip first."
        exit 1
    }
    $ZipPath = $zip.FullName
}
if (-not (Test-Path $ZipPath)) {
    Write-Fail "Zip not found: $ZipPath"
    exit 1
}
Write-Ok "Using zip: $ZipPath"

# --- Prompt for message if missing ---
if (-not $Message) {
    $Message = Read-Host "Commit message"
    if (-not $Message) {
        Write-Fail "Commit message required."
        exit 1
    }
}

# --- Wipe the repo (keep git + scripts) ---
Write-Step "Wiping current repo contents"
$keep = @(".git", ".gitignore", "deploy.ps1", "refresh.ps1")
Get-ChildItem -Force | Where-Object { $keep -notcontains $_.Name } | Remove-Item -Recurse -Force
Write-Ok "Wiped"

# --- Extract the zip to a temp folder, then move contents in ---
Write-Step "Extracting zip"
$tempExtract = Join-Path $env:TEMP "inspection_app_extract_$(Get-Random)"
New-Item -ItemType Directory -Path $tempExtract -Force | Out-Null
try {
    Expand-Archive -Path $ZipPath -DestinationPath $tempExtract -Force
    # The zip contains an inspection_app/ folder at its root. Move its contents up.
    $inner = Join-Path $tempExtract "inspection_app"
    if (Test-Path $inner) {
        Get-ChildItem -Path $inner -Force | Move-Item -Destination . -Force
    } else {
        # Zip didn't have the wrapper folder. Move everything directly.
        Get-ChildItem -Path $tempExtract -Force | Move-Item -Destination . -Force
    }
    Write-Ok "Extracted"
} finally {
    if (Test-Path $tempExtract) {
        Remove-Item $tempExtract -Recurse -Force
    }
}

# --- Validate JSON files, strip BOM if present ---
Write-Step "Validating JSON files"
$jsonFiles = @("package.json", "vercel.json")
foreach ($file in $jsonFiles) {
    if (-not (Test-Path $file)) {
        Write-Fail "$file is missing after extraction"
        exit 1
    }
    try {
        $content = [System.IO.File]::ReadAllText((Resolve-Path $file))
        if ($content.Length -gt 0 -and $content[0] -eq [char]0xFEFF) {
            Write-Host "    Stripping BOM from $file..." -ForegroundColor Yellow
            $clean = $content.Substring(1)
            [System.IO.File]::WriteAllText((Resolve-Path $file), $clean, (New-Object System.Text.UTF8Encoding $false))
            $content = $clean
        }
        ConvertFrom-Json $content | Out-Null
        Write-Ok "$file is valid JSON"
    } catch {
        Write-Fail "$file is not valid JSON: $_"
        exit 1
    }
}

# --- Git status ---
Write-Step "Checking what changed"
$status = git status --porcelain
if (-not $status) {
    Write-Host "    No file changes detected after extraction. Nothing to deploy." -ForegroundColor Yellow
    exit 0
}
Write-Host "    Files changed:"
git status --short

# --- Stage, commit, push ---
Write-Step "Committing and pushing"
git add -A
git commit -m "$Message"
if ($LASTEXITCODE -ne 0) {
    Write-Fail "Commit failed."
    exit 1
}
git push
if ($LASTEXITCODE -ne 0) {
    Write-Fail "Push failed. Commit is local but not deployed."
    exit 1
}

Write-Host ""
Write-Host "Deploy triggered." -ForegroundColor Green
Write-Host "Watch the build at: https://vercel.com/dashboard"
Write-Host ""
