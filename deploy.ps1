<#
.SYNOPSIS
    One-command deploy loop for the ResiHome Inspection App.

.DESCRIPTION
    Run this from the git-cloned repo folder (not from inside an extracted zip).
    It will:
      1. Verify the repo folder looks right (has a .git directory)
      2. Validate package.json and vercel.json are clean JSON
      3. Stage all changes
      4. Show what changed
      5. Commit with the message you pass in
      6. Push to GitHub (which triggers Vercel auto-deploy)

    The script does NOT extract zips. The intended workflow:
      a) Wipe the repo folder contents (keeping .git)
      b) Extract the new zip into the folder
      c) Run this script

.PARAMETER Message
    The git commit message. If omitted, defaults to "Update from Claude zip".

.EXAMPLE
    .\deploy.ps1 "v0.19.18 - save status in header, button reorg"

.EXAMPLE
    .\deploy.ps1
    # Uses default message "Update from Claude zip"
#>

param(
    [Parameter(Position=0)]
    [string]$Message = "Update from Claude zip"
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

# --- Step 1: verify we're in a git repo ---
Write-Step "Checking repo state"
if (-not (Test-Path ".git")) {
    Write-Fail "No .git directory found. You're not in the cloned repo folder."
    Write-Host "    Expected workflow:"
    Write-Host "      cd C:\Users\hwoods\Documents\resihome-inspection-app"
    Write-Host "      .\deploy.ps1 'your message'"
    exit 1
}
Write-Ok "Git repo detected"

# --- Step 2: validate JSON files ---
Write-Step "Validating JSON files"
$jsonFiles = @("package.json", "vercel.json")
foreach ($file in $jsonFiles) {
    if (-not (Test-Path $file)) {
        Write-Fail "$file is missing"
        exit 1
    }
    try {
        # ReadAllText skips BOM handling so we catch BOM-corrupted files too
        $content = [System.IO.File]::ReadAllText((Resolve-Path $file))
        # Strip a BOM if present so we report the real issue (or success)
        if ($content.Length -gt 0 -and $content[0] -eq [char]0xFEFF) {
            Write-Host "    Warning: $file has a UTF-8 BOM. Rewriting without BOM..." -ForegroundColor Yellow
            $clean = $content.Substring(1)
            [System.IO.File]::WriteAllText((Resolve-Path $file), $clean, (New-Object System.Text.UTF8Encoding $false))
            $content = $clean
            Write-Ok "$file BOM stripped"
        }
        ConvertFrom-Json $content | Out-Null
        Write-Ok "$file is valid JSON"
    } catch {
        Write-Fail "$file is not valid JSON: $_"
        exit 1
    }
}

# --- Step 3: check git status ---
Write-Step "Checking what changed"
$status = git status --porcelain
if (-not $status) {
    Write-Host "    No changes detected. Nothing to deploy." -ForegroundColor Yellow
    exit 0
}
Write-Host "    Files changed:"
git status --short

# --- Step 4: stage everything ---
Write-Step "Staging changes"
git add -A
Write-Ok "All changes staged"

# --- Step 5: commit ---
Write-Step "Committing"
git commit -m "$Message"
if ($LASTEXITCODE -ne 0) {
    Write-Fail "Commit failed. See output above."
    exit 1
}
Write-Ok "Committed: $Message"

# --- Step 6: push ---
Write-Step "Pushing to GitHub (triggers Vercel deploy)"
git push
if ($LASTEXITCODE -ne 0) {
    Write-Fail "Push failed. See output above. Your commit is local but not deployed."
    exit 1
}
Write-Ok "Pushed to GitHub"

Write-Host ""
Write-Host "Deploy triggered." -ForegroundColor Green
Write-Host "Watch the build at: https://vercel.com/dashboard"
Write-Host ""
