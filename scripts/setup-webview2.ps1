$ErrorActionPreference = 'Stop'
function Get-WebViewRuntime {
    $roots = @('HKLM:/SOFTWARE/WOW6432Node/Microsoft/EdgeUpdate/Clients', 'HKLM:/SOFTWARE/Microsoft/EdgeUpdate/Clients', 'HKCU:/Software/Microsoft/EdgeUpdate/Clients')
    foreach ($root in $roots) {
        foreach ($key in (Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
            $value = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
            if ($value.name -match 'Microsoft Edge WebView2' -and $value.pv -and $value.pv -ne '0.0.0.0') { return $value.pv }
        }
    }
    return $null
}
$version = Get-WebViewRuntime
if ($version) { Write-Output "WebView2 Runtime already available: $version"; exit 0 }
$toolsDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) '.tools'
New-Item -ItemType Directory -Force -Path $toolsDirectory | Out-Null
$installer = Join-Path $toolsDirectory 'MicrosoftEdgeWebview2Setup.exe'
& curl.exe -fL --silent --show-error 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -o $installer
if ($LASTEXITCODE -ne 0) { throw 'WebView2 Runtime download failed.' }
$signature = Get-AuthenticodeSignature -LiteralPath $installer
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw 'WebView2 bootstrapper signature verification failed.' }
$process = Start-Process -FilePath $installer -ArgumentList '/silent', '/install' -WindowStyle Hidden -Wait -PassThru
$version = Get-WebViewRuntime
if (!$version) { throw "WebView2 Runtime was not registered; installer exit code: $($process.ExitCode)" }
Write-Output "WebView2 Runtime ready: $version"
