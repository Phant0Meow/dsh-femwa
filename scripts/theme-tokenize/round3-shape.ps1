# Round 3: shape tokenization — borderRadius / border width / fontFamily / canvas dots / scrollbar
$ErrorActionPreference = 'Stop'

$dir = 'D:\myFiles\dsh\dsh-femwa\femGen\src'
$files = Get-ChildItem $dir -Filter *.jsx | Where-Object { $_.Name -ne 'themes.js' }

# ── borderRadius: value -> token (numeric, longest first, lookahead guard) ──
$radiusNum = [ordered]@{
  '18' = 'var(--fem-radius-xl)'
  '16' = 'var(--fem-radius-xl)'
  '14' = 'var(--fem-radius-xl)'
  '10' = 'var(--fem-radius-lg)'
  '8'  = 'var(--fem-radius-md)'
  '7'  = 'var(--fem-radius-md)'
  '6'  = 'var(--fem-radius-sm)'
  '5'  = 'var(--fem-radius-sm)'
  '4'  = 'var(--fem-radius-sm)'
  '2'  = 'var(--fem-radius-xs)'
}
$radiusStr = [ordered]@{
  "'50%'" = "'var(--fem-radius-pill)'"
  "'8px 8px 0 0'" = "'var(--fem-radius-top)'"
  "'10px 10px 10px 2px'" = "'var(--fem-radius-bubble)'"
}

# ── border width substring replacements (longest first) ──
$borderW = [ordered]@{
  '2.5px solid' = 'var(--fem-border-w-selected) solid'
  '1.5px solid' = 'var(--fem-border-w-strong) solid'
  '4px solid'   = 'var(--fem-border-w-node) solid'
  '3px solid'   = 'var(--fem-border-w-accent) solid'
  '2px dashed'  = 'var(--fem-border-w-selected) dashed'
  '2px solid'   = 'var(--fem-border-w-selected) solid'
  '1px solid'   = 'var(--fem-border-w) solid'
}

# ── fontFamily replacements ──
$fontMap = [ordered]@{
  "fontFamily: 'DM Sans, sans-serif'" = "fontFamily: 'var(--fem-font-sans)'"
  "fontFamily: 'JetBrains Mono, monospace'" = "fontFamily: 'var(--fem-font-mono)'"
  "fontFamily: 'JetBrains Mono,monospace'" = "fontFamily: 'var(--fem-font-mono)'"
  'fontFamily="JetBrains Mono, monospace"' = 'fontFamily="var(--fem-font-mono)"'
  'fontFamily="JetBrains Mono,monospace"' = 'fontFamily="var(--fem-font-mono)"'
}

# ── canvas dot patterns (whole value) ──
$canvasDots = [ordered]@{
  "'radial-gradient(circle, var(--fem-canvas-dot) 1.2px, transparent 1.2px)'" = "'var(--fem-canvas-dots)'"
  "'radial-gradient(circle, var(--fem-mobile-border) 1px, transparent 1px)'" = "'var(--fem-mobile-canvas-dots)'"
}

foreach ($f in $files) {
  $c = [System.IO.File]::ReadAllText($f.FullName)
  $orig = $c
  $count = 0

  # borderRadius string forms
  foreach ($k in $radiusStr.Keys) {
    $n = ([regex]::Matches($c, [regex]::Escape("borderRadius: $k"))).Count
    if ($n -gt 0) { $c = $c.Replace("borderRadius: $k", "borderRadius: $($radiusStr[$k])"); $count += $n }
  }
  # borderRadius numeric forms
  foreach ($k in $radiusNum.Keys) {
    $pattern = "borderRadius:\s*$k(?=[,}\s])"
    $n = ([regex]::Matches($c, $pattern)).Count
    if ($n -gt 0) { $c = [regex]::Replace($c, $pattern, "borderRadius: '$($radiusNum[$k])'"); $count += $n }
  }
  # border widths
  foreach ($k in $borderW.Keys) {
    $n = ([regex]::Matches($c, [regex]::Escape($k))).Count
    if ($n -gt 0) { $c = $c.Replace($k, $borderW[$k]); $count += $n }
  }
  # fontFamily
  foreach ($k in $fontMap.Keys) {
    $n = ([regex]::Matches($c, [regex]::Escape($k))).Count
    if ($n -gt 0) { $c = $c.Replace($k, $fontMap[$k]); $count += $n }
  }
  # canvas dots
  foreach ($k in $canvasDots.Keys) {
    $n = ([regex]::Matches($c, [regex]::Escape($k))).Count
    if ($n -gt 0) { $c = $c.Replace($k, $canvasDots[$k]); $count += $n }
  }
  # scrollbar width (common.jsx CSS)
  $sb = '::-webkit-scrollbar { width: 5px; height: 5px; }'
  if ($c.Contains($sb)) {
    $c = $c.Replace($sb, '::-webkit-scrollbar { width: var(--fem-scrollbar-w); height: var(--fem-scrollbar-w); }')
    $count++
  }

  if ($c -ne $orig) {
    [System.IO.File]::WriteAllText($f.FullName, $c, (New-Object System.Text.UTF8Encoding($false)))
    Write-Output "$($f.Name): replaced $count"
  } else {
    Write-Output "$($f.Name): no change"
  }
}

# ── font.css: body font-family ──
$fontCss = 'D:\myFiles\dsh\dsh-femwa\femGen\src\styles\font.css'
$fc = [System.IO.File]::ReadAllText($fontCss)
$oldBody = "font-family: 'MyCustomFont', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;"
$newBody = 'font-family: var(--fem-font-body);'
if ($fc.Contains($oldBody)) {
  $fc = $fc.Replace($oldBody, $newBody)
  [System.IO.File]::WriteAllText($fontCss, $fc, (New-Object System.Text.UTF8Encoding($false)))
  Write-Output 'font.css: body font tokenized'
} else {
  Write-Output 'font.css: pattern not found!'
}
Write-Output 'DONE'
