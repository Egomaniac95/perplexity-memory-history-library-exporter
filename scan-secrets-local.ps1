param(
  [string]$Path = ".",
  [switch]$Strict
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path $Path).Path

$excludeDirs = @(
  ".git", "node_modules", "browser-data", "browser-data-playwright", "dist", "build", "out",
  "playwright-report", "test-results", "perplexity-export-*", "perplexity-update-*",
  "clean_export", "exported-data", "memory_chunks", "md", "private", "_private", "tmp", "temp", "scratch"
)

$excludeFiles = @(
  "pnpm-lock.yaml", "package-lock.json", "yarn.lock",
  "*.map", "*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.ico",
  "*.pdf", "*.docx", "*.xlsx", "*.pptx", "*.zip", "*.7z", "*.rar", "*.exe", "*.dll"
)

$dangerousFileNames = @(
  ".env", ".env.*", "*.env", "*.local", "*.secret", "*.secrets", "*.token", "*.tokens",
  "*.pem", "*.key", "*.crt", "*.cer", "*.p12", "*.pfx",
  "cookies.json", "*.cookie", "*.cookies",
  "*credentials*.json", "*credential*.json", "*secret*.json", "*token*.json",
  "perplexity-memory.md", "perplexity-export-state.json", "last-thread-id.txt",
  "threads-index.json", "summary.json", "index.tsv",
  "failed-or-empty-threads.jsonl", "empty-or-failed-threads.jsonl",
  "perplexity-threads.json", "perplexity-threads.jsonl", "perplexity-threads.raw.jsonl",
  "perplexity-clean.json", "perplexity-clean.jsonl", "*.jsonl", "*.har", "*.log", "*.tgz"
)

$patterns = @(
  @{ Name = "AWS Access Key ID"; Regex = "A(?:KIA|SIA)[0-9A-Z]{16}" },
  @{ Name = "Google API Key"; Regex = "AIza[0-9A-Za-z\-_]{35}" },
  @{ Name = "Mapbox Secret Token"; Regex = "sk\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+" },
  @{ Name = "Mapbox Public Token (review)"; Regex = "pk\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+" },
  @{ Name = "GitHub Token"; Regex = "(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{22,}_[A-Za-z0-9_]{59,}" },
  @{ Name = "OpenAI API Key"; Regex = "sk-(proj-)?[A-Za-z0-9_\-]{32,}" },
  @{ Name = "Anthropic API Key"; Regex = "sk-ant-[A-Za-z0-9_\-]{20,}" },
  @{ Name = "Slack Token"; Regex = "xox[baprs]-[A-Za-z0-9\-]{10,}" },
  @{ Name = "Stripe Secret Key"; Regex = "sk_(live|test)_[A-Za-z0-9]{20,}" },
  @{ Name = "Private Key Block"; Regex = "-----BEGIN (RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----" },
  @{ Name = "URL with embedded credentials"; Regex = "[a-zA-Z][a-zA-Z0-9+\-.]*://[^/\s:@]+:[^/\s:@]+@" },
  @{ Name = "Likely hardcoded secret assignment"; Regex = "(?i)\b(password|passwd|pwd|secret|api[_-]?key|token|access[_-]?key|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*['""]?[A-Za-z0-9_\-./+=]{12,}" }
)

function Test-WildcardAny {
  param([string]$Value, [string[]]$Patterns)
  foreach ($p in $Patterns) {
    if ($Value -like $p) { return $true }
  }
  return $false
}

function Redact-Secret {
  param([string]$Value)
  $v = $Value.Trim()
  if ($v.Length -le 12) { return "***" }
  return $v.Substring(0, [Math]::Min(6, $v.Length)) + "..." + $v.Substring($v.Length - [Math]::Min(4, $v.Length))
}

Write-Host "Scanning: $root"
Write-Host "This is a local heuristic scan. Review all findings before publishing." -ForegroundColor Yellow
Write-Host ""

$findings = New-Object System.Collections.Generic.List[object]
$dangerousNames = New-Object System.Collections.Generic.List[object]

$files = Get-ChildItem -Path $root -Recurse -File -Force | Where-Object {
  $relative = $_.FullName.Substring($root.Length).TrimStart("\","/")
  $parts = $relative -split "[\\/]"
  foreach ($part in $parts) {
    if (Test-WildcardAny $part $excludeDirs) { return $false }
  }
  if (Test-WildcardAny $_.Name $excludeFiles) { return $false }
  return $true
}

foreach ($file in $files) {
  $relative = $file.FullName.Substring($root.Length).TrimStart("\","/")

  if (Test-WildcardAny $file.Name $dangerousFileNames) {
    $dangerousNames.Add([pscustomobject]@{
      Type = "Dangerous filename"
      File = $relative
      Reason = "Should not be published unless you are certain it is sanitized"
    }) | Out-Null
  }

  if ($file.Length -gt 2MB) { continue }

  try {
    $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
    if ($bytes[0..([Math]::Min($bytes.Length-1, 512))] -contains 0) { continue }
    $content = [System.Text.Encoding]::UTF8.GetString($bytes)
  } catch {
    continue
  }

  $lines = $content -split "`r?`n"
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    foreach ($p in $patterns) {
      $matches = [regex]::Matches($line, $p.Regex)
      foreach ($m in $matches) {
        $findings.Add([pscustomobject]@{
          Type = $p.Name
          File = $relative
          Line = $i + 1
          Match = (Redact-Secret $m.Value)
          Context = ($line.Trim() -replace [regex]::Escape($m.Value), (Redact-Secret $m.Value))
        }) | Out-Null
      }
    }
  }
}

if ($dangerousNames.Count -gt 0) {
  Write-Host "Potentially dangerous filenames found:" -ForegroundColor Yellow
  $dangerousNames | Format-Table -AutoSize
  Write-Host ""
}

if ($findings.Count -gt 0) {
  Write-Host "Possible secrets found:" -ForegroundColor Red
  $findings | Sort-Object File, Line, Type | Format-Table -AutoSize
  Write-Host ""
  Write-Host "Action: remove/sanitize the file or replace the value with a placeholder before git add." -ForegroundColor Yellow
  if ($Strict) { exit 2 } else { exit 1 }
}

Write-Host "No obvious secrets detected by this local heuristic scan." -ForegroundColor Green
Write-Host "Next: run git status --short, then commit, then let GitHub push protection scan the push."
exit 0
