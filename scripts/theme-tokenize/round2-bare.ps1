# Round 2: bare-color replacement (inside composite strings) + ${c}22 alpha fix
$ErrorActionPreference = 'Stop'

$map = [ordered]@{
  '#94a3b844' = 'var(--fem-neutral-border)'
  '#94a3b818' = 'var(--fem-neutral-faint)'
  '#eef1ff22' = 'var(--fem-primary-soft-faint)'
  '#47556918' = 'var(--fem-tag-bg-faint)'
  'rgba(239, 68, 68, 0.18)' = 'var(--fem-danger-soft-2)'
  'rgba(8,16,40,0.5)' = 'var(--fem-mask-blue)'
  'rgba(13,17,23,0.8)' = 'var(--fem-mobile-mask)'
  'rgba(61,92,245,0.92)' = 'var(--fem-primary-overlay)'
  'rgba(61,92,245,0.7)' = 'var(--fem-primary-glow-x)'
  'rgba(61,92,245,0.5)' = 'var(--fem-primary-glow-strong)'
  'rgba(61,92,245,0.4)' = 'var(--fem-primary-glow-strong)'
  'rgba(61,92,245,0.3)' = 'var(--fem-primary-glow)'
  'rgba(61,92,245,0.25)' = 'var(--fem-primary-glow)'
  'rgba(61,92,245,0.15)' = 'var(--fem-primary-glow-weak)'
  'rgba(61,92,245,0.12)' = 'var(--fem-primary-glow-weak)'
  'rgba(61,92,245,0.06)' = 'var(--fem-primary-glow-weak)'
  'rgba(239,68,68,0.7)' = 'var(--fem-danger-glow-strong)'
  'rgba(239,68,68,0.5)' = 'var(--fem-danger-glow)'
  'rgba(239,68,68,0.35)' = 'var(--fem-danger-glow)'
  'rgba(239,68,68,0.25)' = 'var(--fem-danger-glow-weak)'
  'rgba(20,40,90,0.08)' = 'var(--fem-shadow-blue)'
  'rgba(20,40,90,0.07)' = 'var(--fem-shadow-blue)'
  'rgba(20,40,90,0.06)' = 'var(--fem-shadow-blue)'
  'rgba(0,0,0,0.55)' = 'var(--fem-mask-heavy)'
  'rgba(0,0,0,0.5)' = 'var(--fem-mask)'
  'rgba(0,0,0,0.45)' = 'var(--fem-mask)'
  'rgba(0,0,0,0.4)' = 'var(--fem-mask)'
  'rgba(0,0,0,0.35)' = 'var(--fem-mask-soft)'
  'rgba(0,0,0,0.3)' = 'var(--fem-mask-soft)'
  'rgba(0,0,0,0.25)' = 'var(--fem-shadow-lg)'
  'rgba(0,0,0,0.18)' = 'var(--fem-shadow-md)'
  'rgba(0,0,0,0.15)' = 'var(--fem-shadow-md)'
  'rgba(0,0,0,0.12)' = 'var(--fem-shadow-sm)'
  'rgba(0,0,0,0.1)' = 'var(--fem-shadow-sm)'
  'rgba(0,0,0,0.08)' = 'var(--fem-shadow-sm)'
  '#bfcde2' = 'var(--fem-canvas-dot)'
  '#e8edf8' = 'var(--fem-mobile-text-1)'
  '#1e2535' = 'var(--fem-mobile-surface-hover)'
  '#161b27' = 'var(--fem-mobile-surface)'
  '#0d1117' = 'var(--fem-mobile-bg)'
  '#0c1428' = 'var(--fem-mobile-bg-2)'
  '#1e2d45' = 'var(--fem-mobile-border-strong)'
  '#1a2236' = 'var(--fem-mobile-bg-3)'
  '#2a3347' = 'var(--fem-mobile-border)'
  '#3a4560' = 'var(--fem-mobile-border-light)'
  '#8fa8c8' = 'var(--fem-mobile-text-2-alt)'
  '#4a5568' = 'var(--fem-mobile-text-3)'
  '#2d3748' = 'var(--fem-preview-border)'
  '#0a0f1e' = 'var(--fem-preview-bg-2)'
  '#e2e8f0' = 'var(--fem-bg-hover)'
  '#d1d9e6' = 'var(--fem-scrollbar)'
  '#fde68a' = 'var(--fem-warning-border)'
  '#b45309' = 'var(--fem-warning-strong)'
  '#fef3c7' = 'var(--fem-warning-soft)'
  '#fffbeb' = 'var(--fem-warning-soft)'
  '#f59e0b' = 'var(--fem-warning)'
  '#fecaca' = 'var(--fem-danger-border)'
  '#fff0f0' = 'var(--fem-danger-soft)'
  '#fff5f5' = 'var(--fem-danger-soft)'
  '#fef2f2' = 'var(--fem-danger-soft)'
  '#f87171' = 'var(--fem-danger-weak)'
  '#ef4444' = 'var(--fem-danger)'
  '#dc2626' = 'var(--fem-danger-strong)'
  '#991b1b' = 'var(--fem-danger-strong)'
  '#f0fdf4' = 'var(--fem-success-soft)'
  '#edfaf4' = 'var(--fem-success-soft)'
  '#ecfdf5' = 'var(--fem-success-soft)'
  '#22c55e' = 'var(--fem-success)'
  '#16a34a' = 'var(--fem-success-text)'
  '#10b981' = 'var(--fem-success-strong)'
  '#0ea577' = 'var(--fem-type-human)'
  '#f5f3ff' = 'var(--fem-type-assign-bg)'
  '#fff1f2' = 'var(--fem-type-mind-bg)'
  '#f3e8ff' = 'var(--fem-special-par-bg)'
  '#8b5cf6' = 'var(--fem-type-assign)'
  '#e11d48' = 'var(--fem-type-mind)'
  '#d97706' = 'var(--fem-type-func)'
  '#7e22ce' = 'var(--fem-special-par)'
  '#eef1ff' = 'var(--fem-primary-soft)'
  '#eff2ff' = 'var(--fem-primary-soft-2)'
  '#f0f4ff' = 'var(--fem-primary-soft-2)'
  '#4f6ef7' = 'var(--fem-primary-strong)'
  '#3d5cf5' = 'var(--fem-primary)'
  '#edf1f8' = 'var(--fem-app-bg)'
  '#e4ecf7' = 'var(--fem-border)'
  '#edf0f8' = 'var(--fem-border)'
  '#dde4ef' = 'var(--fem-border-strong)'
  '#f8fafc' = 'var(--fem-bg)'
  '#f1f5f9' = 'var(--fem-bg-2)'
  '#1b2540' = 'var(--fem-text-1)'
  '#5a6a8a' = 'var(--fem-text-2)'
  '#64748b' = 'var(--fem-text-2-alt)'
  '#7a8aaa' = 'var(--fem-text-3)'
  '#94a3b8' = 'var(--fem-neutral)'
  '#9aaccb' = 'var(--fem-neutral)'
  '#b0bad0' = 'var(--fem-text-4)'
  '#a0aec0' = 'var(--fem-text-4)'
  '#c4d0e0' = 'var(--fem-text-4-weak)'
  '#475569' = 'var(--fem-tag-bg)'
  '#300' = 'var(--fem-mobile-danger-soft)'
  '#622' = 'var(--fem-mobile-danger-border)'
  '#fff' = 'var(--fem-surface)'
}

# ${c}22 / ${sc.c}22 alpha-suffix trick -> color-mix
$alphaSuffix = @(
  @('${c}22', 'color-mix(in srgb, ${c} 13%, transparent)'),
  @('${sc.c}22', 'color-mix(in srgb, ${sc.c} 13%, transparent)')
)

$dir = 'D:\myFiles\dsh\dsh-femwa\femGen\src'
$files = Get-ChildItem $dir -Filter *.jsx

foreach ($f in $files) {
  $c = [System.IO.File]::ReadAllText($f.FullName)
  $orig = $c
  $count = 0
  foreach ($k in $map.Keys) {
    $v = $map[$k]
    $n = ([regex]::Matches($c, [regex]::Escape($k))).Count
    if ($n -gt 0) { $c = $c.Replace($k, $v); $count += $n }
  }
  foreach ($s in $alphaSuffix) {
    $n = ([regex]::Matches($c, [regex]::Escape($s[0]))).Count
    if ($n -gt 0) { $c = $c.Replace($s[0], $s[1]); $count += $n }
  }
  if ($c -ne $orig) {
    [System.IO.File]::WriteAllText($f.FullName, $c, (New-Object System.Text.UTF8Encoding($false)))
    Write-Output "$($f.Name): replaced $count"
  } else {
    Write-Output "$($f.Name): no change"
  }
}
Write-Output 'DONE'
