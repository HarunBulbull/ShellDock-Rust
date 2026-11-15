$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$toolsDirectory = Join-Path $projectDirectory '.tools'
$perlExecutable = Join-Path $toolsDirectory 'perl/bin/perl.exe'
if ((Test-Path -LiteralPath $perlExecutable) -or (Test-Path -LiteralPath 'C:/Strawberry/perl/bin/perl.exe')) {
    Write-Output 'Native Perl is already available.'
    exit 0
}
New-Item -ItemType Directory -Force -Path $toolsDirectory | Out-Null
$archive = Join-Path $toolsDirectory 'perl.zip'
$expectedHash = '6a081a811781c30aca51dbc036afd93092af91e3297901f02c17043795a10690'
$url = 'https://github.com/StrawberryPerl/Perl-Dist-Strawberry/releases/download/SP_54231_64bit/strawberry-perl-5.42.3.1-64bit-portable.zip'
Write-Output 'Downloading native Perl for the OpenSSL build (project-local, no administrator permission required).'
& curl.exe -fL --silent --show-error $url -o $archive
if ($LASTEXITCODE -ne 0) { throw 'Perl download failed.' }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash -ne $expectedHash) { throw 'Perl checksum mismatch; refusing to extract.' }
& tar.exe -xf $archive -C $toolsDirectory perl
if ($LASTEXITCODE -ne 0) { throw 'Perl extraction failed.' }
if (!(Test-Path -LiteralPath $perlExecutable)) { throw 'Perl executable was not extracted.' }
Write-Output 'Native Perl is ready. npm desktop/build/test commands find it automatically.'
