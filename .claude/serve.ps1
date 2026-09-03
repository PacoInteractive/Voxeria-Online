# Minimaler statischer Dateiserver fuer lokale Tests (kein Node/Python vorhanden).
param(
  [string]$Root = "C:\Users\Jaylen\Desktop\VoxeriaFinal",
  [int]$Port = 0
)

$ErrorActionPreference = 'Stop'

# Port-Reihenfolge: -Port schlaegt alles, sonst die Umgebungsvariable PORT,
# sonst 4173. Die Umgebungsvariable ist noetig, damit zwei Sitzungen den
# Server gleichzeitig starten koennen, ohne sich auf 4173 zu blockieren.
if ($Port -le 0) {
  if ($env:PORT) { $Port = [int]$env:PORT } else { $Port = 4173 }
}

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.gif'  = 'image/gif'
  '.svg'  = 'image/svg+xml'
  '.mp3'  = 'audio/mpeg'
  '.ogg'  = 'audio/ogg'
  '.wav'  = 'audio/wav'
  '.ico'  = 'image/x-icon'
  '.woff' = 'font/woff'
  '.woff2'= 'font/woff2'
  '.ttf'  = 'font/ttf'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "serving $Root on http://localhost:$Port/"

$rootFull = (Resolve-Path $Root).Path

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response

    $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart('/')
    if ([string]::IsNullOrWhiteSpace($rel)) { $rel = 'index.html' }
    $path = Join-Path $rootFull $rel

    # Pfad-Ausbruch verhindern (../../)
    $resolved = $null
    try { $resolved = (Resolve-Path $path -ErrorAction Stop).Path } catch { }

    if (-not $resolved -or -not $resolved.StartsWith($rootFull) -or -not (Test-Path $resolved -PathType Leaf)) {
      $res.StatusCode = 404
      $bytes = [System.Text.Encoding]::UTF8.GetBytes("404 not found: $rel")
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
      $res.Close()
      continue
    }

    $ext = [System.IO.Path]::GetExtension($resolved).ToLower()
    $ct = $mime[$ext]
    if (-not $ct) { $ct = 'application/octet-stream' }

    $bytes = [System.IO.File]::ReadAllBytes($resolved)
    $res.ContentType = $ct
    $res.ContentLength64 = $bytes.Length
    $res.Headers.Add('Cache-Control', 'no-store')
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
    $res.Close()
  } catch {
    Write-Host "err: $_"
  }
}
