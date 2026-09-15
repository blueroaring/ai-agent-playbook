# publish.ps1 -- publish pipeline for the AI Agent Playbook repo.
#
# What it does, in order:
#   1. sync recipe sources from their working copies into recipes/
#   2. LEAK SCAN the whole publishable tree; a DENY hit blocks the push (exit 2)
#   3. note newly appended journal entries into .local/pending-distill.md so the
#      next agent session knows what still needs to be distilled into lessons/
#   4. commit + push
#
# ASCII ONLY ON PURPOSE: Windows PowerShell 5.1 decodes a BOM-less .ps1 as ANSI,
# which corrupts non-ASCII text and breaks parsing. Also, keep this file free of
# -- and run it only as -- a scheduled task so that publishing does not depend on
# an agent session being alive. See lessons/02-windows-powershell51.md section 1.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish.ps1 -DryRun
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish.ps1 -NoSync -NoPush
#
# Exit codes: 0 = ok / nothing to do | 1 = error | 2 = blocked by leak scan

param(
    [switch]$DryRun,      # scan + report only, never commit or push
    [switch]$NoSync,      # skip step 1
    [switch]$NoPush,      # commit locally but do not push
    [switch]$Quiet
)

$ErrorActionPreference = 'Continue'

# ------------------------------------------------------------------ locations

$ToolsDir = $PSScriptRoot
$RepoRoot = Split-Path -Parent $ToolsDir
$LocalDir = Join-Path $RepoRoot '.local'
$ConfigPath = Join-Path $ToolsDir 'publish-config.json'
$RulesPath = Join-Path $ToolsDir 'redact-rules.json'
$LogFile = Join-Path $LocalDir 'publish.log'
$ReportFile = Join-Path $LocalDir 'leak-report.txt'
$PendingFile = Join-Path $LocalDir 'pending-distill.md'
$TermFile = Join-Path $LocalDir 'sensitive-terms.txt'
$JournalLinesFile = Join-Path $LocalDir 'journal-lines.txt'

if (-not (Test-Path $LocalDir)) { New-Item -ItemType Directory -Path $LocalDir -Force | Out-Null > $null }

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $line = ('{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message)
    if (-not $Quiet) { Write-Host $line }
    try { [System.IO.File]::AppendAllText($LogFile, $line + "`r`n", $Utf8NoBom) } catch { }
}

function Write-TextFile {
    param([string]$Path, [string]$Text)
    [System.IO.File]::WriteAllText($Path, $Text, $Utf8NoBom)
}

function Invoke-Git {
    param([string[]]$Arguments, [switch]$Capture)
    $prev = Get-Location
    try {
        Set-Location -LiteralPath $RepoRoot
        if ($Capture) {
            $out = & git @Arguments 2>&1
            return @{ Code = $LASTEXITCODE; Output = @($out) }
        } else {
            & git @Arguments 2>&1 | ForEach-Object { if (-not $Quiet) { Write-Host ('    | ' + $_) } }
            return @{ Code = $LASTEXITCODE; Output = @() }
        }
    } finally {
        Set-Location -LiteralPath $prev
    }
}

Write-Log ('publish start (repo={0})' -f $RepoRoot)

foreach ($required in @($ConfigPath, $RulesPath)) {
    if (-not (Test-Path -LiteralPath $required)) {
        Write-Log ('missing required file: {0}' -f $required) 'ERROR'
        exit 1
    }
}

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$rules = Get-Content -LiteralPath $RulesPath -Raw | ConvertFrom-Json

$remote = if ($config.remote) { $config.remote } else { 'origin' }
$branch = if ($config.branch) { $config.branch } else { 'main' }
$authorName = if ($config.gitAuthorName) { $config.gitAuthorName } else { 'agent-playbook-bot' }
$authorEmail = if ($config.gitAuthorEmail) { $config.gitAuthorEmail } else { 'agent-playbook-bot@users.noreply.github.com' }
$commitPrefix = if ($config.commitPrefix) { $config.commitPrefix } else { 'chore(publish)' }

# The workspace that holds the original working copies. Defaults to the parent of
# the repo (the repo is normally a subdirectory of the workspace).
$Workspace = if ($env:PLAYBOOK_WORKSPACE) { $env:PLAYBOOK_WORKSPACE } else { Split-Path -Parent $RepoRoot }

# Credentials: never read from the repo, never from a published config file.
$TokenFile = if ($env:PLAYBOOK_TOKEN_FILE) { $env:PLAYBOOK_TOKEN_FILE }
             elseif ($env:DSH_HOME) { Join-Path $env:DSH_HOME 'github-token' }
             else { Join-Path $env:USERPROFILE '.dsh\github-token' }

if (-not (Test-Path (Join-Path $RepoRoot '.git'))) {
    Write-Log 'not a git repository (.git missing); run git init first' 'ERROR'
    exit 1
}

# ------------------------------------------------------- 1. sync recipe sources

if (-not $NoSync) {
    $synced = 0
    $skipped = 0
    foreach ($m in $config.recipeSync) {
        $from = Join-Path $Workspace $m.from
        $to = Join-Path $RepoRoot $m.to
        if (-not (Test-Path -LiteralPath $from)) { $skipped++; continue }
        $toDir = Split-Path -Parent $to
        if (-not (Test-Path -LiteralPath $toDir)) { New-Item -ItemType Directory -Path $toDir -Force | Out-Null }
        Copy-Item -LiteralPath $from -Destination $to -Force
        $synced++
    }
    Write-Log ('recipe sync: {0} copied, {1} source(s) not found (skipped)' -f $synced, $skipped)
} else {
    Write-Log 'recipe sync skipped (-NoSync)'
}

# ------------------------------------------------------------- 2. the leak scan

function Get-PublishableFiles {
    param([string]$Repo)
    $found = @()
    $r = $null
    $prev = Get-Location
    try {
        Set-Location -LiteralPath $Repo
        $out = @(& git ls-files -co --exclude-standard 2>$null)
        if ($LASTEXITCODE -eq 0) { $r = $out }
    } catch { $r = $null } finally { Set-Location -LiteralPath $prev }

    if ($r -and $r.Count -gt 0) {
        foreach ($rel in $r) {
            if (-not $rel) { continue }
            $abs = Join-Path $Repo ($rel -replace '/', '\')
            if (Test-Path -LiteralPath $abs -PathType Leaf) { $found += $abs }
        }
    }

    if ($found.Count -eq 0) {
        # Fallback: enumerate by hand, mirroring .gitignore's two big rules.
        Write-Log 'git ls-files unavailable; falling back to directory enumeration' 'WARN'
        $found = @(Get-ChildItem -LiteralPath $Repo -Recurse -File -Force -ErrorAction SilentlyContinue |
            Where-Object {
                $_.FullName -notmatch '\\\.git\\' -and
                $_.FullName -notmatch '\\\.local\\' -and
                $_.FullName -notmatch '\\node_modules\\'
            } | ForEach-Object { $_.FullName })
    }
    return $found
}

$allowRegexes = @()
foreach ($a in $rules.allowMatch) { $allowRegexes += [regex]$a }

$denyRules = @()
foreach ($d in $rules.deny) {
    $denyRules += [pscustomobject]@{ Id = $d.id; Regex = [regex]$d.regex; Hint = $d.hint }
}
$warnRules = @()
foreach ($w in $rules.warn) {
    $warnRules += [pscustomobject]@{ Id = $w.id; Regex = [regex]$w.regex; Hint = $w.hint }
}

$sensitiveTerms = @()
if (Test-Path -LiteralPath $TermFile) {
    $sensitiveTerms = @(Get-Content -LiteralPath $TermFile -Encoding UTF8 |
        Where-Object { $_ -and -not $_.TrimStart().StartsWith('#') } |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ })
} else {
    Write-Log ('sensitive-terms.txt not found at {0}; relying on generic rules only' -f $TermFile) 'WARN'
}

function Test-Allowed {
    param([string]$Matched)
    foreach ($re in $allowRegexes) { if ($re.IsMatch($Matched)) { return $true } }
    return $false
}

$skipExt = @{}
foreach ($e in $rules.skipExtensions) { $skipExt[$e.ToLower()] = $true }

$denies = New-Object System.Collections.ArrayList
$warns = New-Object System.Collections.ArrayList
$scanned = 0
$skippedBinary = 0

$files = Get-PublishableFiles -Repo $RepoRoot
Write-Log ('leak scan: {0} candidate file(s)' -f $files.Count)

foreach ($file in $files) {
    $ext = [System.IO.Path]::GetExtension($file).ToLower()
    if ($skipExt.ContainsKey($ext)) { $skippedBinary++; continue }

    $bytes = $null
    try { $bytes = [System.IO.File]::ReadAllBytes($file) } catch { continue }
    if ($bytes.Length -eq 0) { continue }
    if ($bytes.Length -gt 4MB) { $skippedBinary++; continue }
    if ([Array]::IndexOf($bytes, [byte]0) -ge 0) { $skippedBinary++; continue }

    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    $rel = $file.Substring($RepoRoot.Length).TrimStart('\')
    $lines = $text -split "`r?`n"
    $scanned++

    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        if (-not $line) { continue }

        foreach ($rule in $denyRules) {
            foreach ($m in $rule.Regex.Matches($line)) {
                if (Test-Allowed $m.Value) { continue }
                [void]$denies.Add([pscustomobject]@{
                    File = $rel; Line = ($i + 1); Rule = $rule.Id; Text = $line.Trim(); Hint = $rule.Hint
                })
            }
        }
        foreach ($rule in $warnRules) {
            foreach ($m in $rule.Regex.Matches($line)) {
                if (Test-Allowed $m.Value) { continue }
                [void]$warns.Add([pscustomobject]@{
                    File = $rel; Line = ($i + 1); Rule = $rule.Id; Text = $line.Trim(); Hint = $rule.Hint
                })
            }
        }
        foreach ($term in $sensitiveTerms) {
            $idx = $line.IndexOf($term, [System.StringComparison]::OrdinalIgnoreCase)
            if ($idx -ge 0) {
                [void]$denies.Add([pscustomobject]@{
                    File = $rel; Line = ($i + 1); Rule = 'sensitive-term'
                    Text = $line.Trim(); Hint = ('contains a locally blacklisted term (length {0})' -f $term.Length)
                })
            }
        }
    }
}

# Never publish the report content itself; it quotes the offending lines.
$report = New-Object System.Text.StringBuilder
[void]$report.AppendLine('AI Agent Playbook -- leak scan report')
[void]$report.AppendLine(('generated: {0}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')))
[void]$report.AppendLine(('files scanned: {0} | skipped (binary/large/extension): {1}' -f $scanned, $skippedBinary))
[void]$report.AppendLine('')
[void]$report.AppendLine(('DENY hits: {0}   (a non-zero count blocks the push)' -f $denies.Count))
foreach ($h in $denies) {
    [void]$report.AppendLine(('  {0}:{1}  [{2}]' -f $h.File, $h.Line, $h.Rule))
    [void]$report.AppendLine(('      {0}' -f $h.Text))
    [void]$report.AppendLine(('      -> {0}' -f $h.Hint))
}
[void]$report.AppendLine('')
[void]$report.AppendLine(('WARN hits: {0}   (review only, does not block)' -f $warns.Count))
foreach ($h in $warns) {
    [void]$report.AppendLine(('  {0}:{1}  [{2}]' -f $h.File, $h.Line, $h.Rule))
    [void]$report.AppendLine(('      {0}' -f $h.Text))
}
Write-TextFile -Path $ReportFile -Text $report.ToString()

Write-Log ('leak scan result: deny={0} warn={1} (report: {2})' -f $denies.Count, $warns.Count, $ReportFile)

if ($denies.Count -gt 0) {
    Write-Log 'BLOCKED: deny hits found. Nothing was committed or pushed.' 'ERROR'
    Write-Log ('  review {0}, fix the source, then re-run.' -f $ReportFile) 'ERROR'
    Write-Log ('  rule definitions: {0}' -f $RulesPath) 'ERROR'
    exit 2
}

# ------------------------------------------- 3. note new journal entries

$journalRel = $config.journalWatch
if ($journalRel) {
    $journalPath = Join-Path $Workspace $journalRel
    if (Test-Path -LiteralPath $journalPath) {
        $journalLines = @(Get-Content -LiteralPath $journalPath -Encoding UTF8)
        $seen = 0
        if (Test-Path -LiteralPath $JournalLinesFile) {
            $raw = (Get-Content -LiteralPath $JournalLinesFile -Raw).Trim()
            if ($raw -match '^\d+$') { $seen = [int]$raw }
        }
        if ($journalLines.Count -gt $seen) {
            $newLines = @($journalLines[$seen..($journalLines.Count - 1)])
            $block = New-Object System.Text.StringBuilder
            [void]$block.AppendLine('')
            [void]$block.AppendLine(('## {0}  -- {1} new journal line(s) awaiting distillation' -f (Get-Date -Format 'yyyy-MM-dd HH:mm'), $newLines.Count))
            [void]$block.AppendLine('')
            [void]$block.AppendLine('These lines are RAW working notes and may contain personal context.')
            [void]$block.AppendLine('They are LOCAL ONLY (gitignored). Distil them into lessons/ + recipes/')
            [void]$block.AppendLine('in four parts (symptom -> root cause -> fix -> verification), then delete this section.')
            [void]$block.AppendLine('')
            foreach ($l in $newLines) { [void]$block.AppendLine($l) }
            try {
                [System.IO.File]::AppendAllText($PendingFile, $block.ToString(), $Utf8NoBom)
                Write-TextFile -Path $JournalLinesFile -Text ([string]$journalLines.Count)
                Write-Log ('journal grew by {0} line(s); queued in {1}' -f $newLines.Count, $PendingFile)
            } catch {
                Write-Log ('could not write pending-distill queue: {0}' -f $_.Exception.Message) 'WARN'
            }
        } else {
            Write-Log 'journal unchanged; nothing new to distil'
        }
    } else {
        Write-Log ('journal not found at {0}; skipping distill queue' -f $journalPath) 'WARN'
    }
}

# ------------------------------------------------------------ 4. commit + push

$st = Invoke-Git -Arguments @('status', '--porcelain') -Capture
if ($st.Code -ne 0) {
    Write-Log 'git status failed' 'ERROR'
    exit 1
}
$changes = @($st.Output | Where-Object { $_ -and $_.ToString().Trim() })
if ($changes.Count -gt 0) {
    Write-Log ('{0} change(s) detected' -f $changes.Count)

    if ($DryRun) {
        Write-Log 'DryRun: would commit and push the following:'
        foreach ($c in $changes) { Write-Log ('    ' + $c) }
        Write-Log 'publish done (dry run)'
        exit 0
    }

    $add = Invoke-Git -Arguments @('add', '-A') -Capture
    if ($add.Code -ne 0) { Write-Log 'git add failed' 'ERROR'; exit 1 }

    $msg = ('{0}: scheduled sync {1}' -f $commitPrefix, (Get-Date -Format 'yyyy-MM-dd'))
    $commit = Invoke-Git -Arguments @('-c', ('user.name=' + $authorName), '-c', ('user.email=' + $authorEmail), 'commit', '-q', '-m', $msg) -Capture
    if ($commit.Code -ne 0) {
        Write-Log 'git commit failed' 'ERROR'
        foreach ($l in $commit.Output) { Write-Log ('    ' + $l) 'ERROR' }
        exit 1
    }
    Write-Log ('committed: {0}' -f $msg)
} else {
    Write-Log 'working tree clean; no new changes to commit'
}

# A clean working tree does NOT mean there is nothing to publish: a commit made by
# hand (or by an earlier run that could not push) is still sitting locally. Without
# this check the scheduled task would silently never push those commits.
$upstream = Invoke-Git -Arguments @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}') -Capture
$hasUpstream = ($upstream.Code -eq 0)

if ($hasUpstream) {
    $countResult = Invoke-Git -Arguments @('rev-list', '--count', '@{u}..HEAD') -Capture
} else {
    Write-Log 'no upstream configured for this branch yet (first push)' 'WARN'
    $countResult = Invoke-Git -Arguments @('rev-list', '--count', 'HEAD') -Capture
}

$unpushed = 0
if ($countResult.Code -eq 0 -and $countResult.Output.Count -gt 0) {
    $raw = ($countResult.Output | Select-Object -First 1).ToString().Trim()
    if ($raw -match '^\d+$') { $unpushed = [int]$raw }
}

if ($unpushed -eq 0) {
    Write-Log 'nothing to publish (working tree clean and no local commits ahead)'
    Write-Log 'publish done (no-op)'
    exit 0
}
Write-Log ('{0} local commit(s) not yet on {1}/{2}' -f $unpushed, $remote, $branch)

if ($DryRun) {
    Write-Log 'DryRun: would push the commits above'
    Write-Log 'publish done (dry run)'
    exit 0
}

if ($NoPush) {
    Write-Log 'NoPush: skipping push'
    Write-Log 'publish done (local commit only)'
    exit 0
}

if (-not (Test-Path -LiteralPath $TokenFile)) {
    Write-Log ('credential file not found: {0} -- commit is local, push skipped' -f $TokenFile) 'ERROR'
    Write-Log 'set PLAYBOOK_TOKEN_FILE, or place a PAT at <DSH_HOME>\github-token' 'ERROR'
    exit 1
}

$token = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
if (-not $token) { Write-Log 'credential file is empty' 'ERROR'; exit 1 }

# Pass the credential through git CONFIG ENV VARS, never through argv: command
# lines are readable by other processes on the same machine.
$b64 = [Convert]::ToBase64String([System.Text.Encoding]::ASCII.GetBytes('x-access-token:' + $token))
$env:GIT_CONFIG_COUNT = '1'
$env:GIT_CONFIG_KEY_0 = 'http.extraheader'
$env:GIT_CONFIG_VALUE_0 = 'Authorization: Basic ' + $b64

try {
    # git global options must precede the subcommand; -u belongs to the subcommand.
    $pushVerb = @('push')
    if (-not $hasUpstream) { $pushVerb += '-u' }     # first push: set the upstream
    $pushTail = @($remote, $branch)

    $push = Invoke-Git -Arguments ($pushVerb + $pushTail) -Capture

    # Local proxy software (http.proxy pointing at e.g. 127.0.0.1:7890) is common on
    # developer machines and it can break the push transport while leaving read
    # operations working, producing connection resets or "unexpected eof" instead of
    # a real error. Fall back progressively before giving up.
    if ($push.Code -ne 0) {
        Write-Log 'push failed; retrying with http.version=HTTP/1.1 (some proxies break HTTP/2 push)' 'WARN'
        $push = Invoke-Git -Arguments (@('-c', 'http.version=HTTP/1.1') + $pushVerb + $pushTail) -Capture
    }
    if ($push.Code -ne 0) {
        Write-Log 'push failed again; retrying with the proxy bypassed for github.com' 'WARN'
        $push = Invoke-Git -Arguments (@('-c', 'http.version=HTTP/1.1', '-c', 'http.https://github.com.proxy=') + $pushVerb + $pushTail) -Capture
    }
    if ($push.Code -ne 0) {
        Write-Log 'git push failed' 'ERROR'
        foreach ($l in $push.Output) { Write-Log ('    ' + $l) 'ERROR' }
        Write-Log 'hint: a 403 "Permission to ... denied" means the credential lacks Contents:write.' 'ERROR'
        Write-Log 'hint: verify with  POST /repos/<owner>/<repo>/git/blobs  (201 = can write, 403 = cannot).' 'ERROR'
        exit 1
    }
    Write-Log ('pushed to {0}/{1}' -f $remote, $branch)
} finally {
    Remove-Item Env:\GIT_CONFIG_COUNT -ErrorAction SilentlyContinue
    Remove-Item Env:\GIT_CONFIG_KEY_0 -ErrorAction SilentlyContinue
    Remove-Item Env:\GIT_CONFIG_VALUE_0 -ErrorAction SilentlyContinue
}

Write-Log 'publish done'
exit 0
