[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ServiceUrl
)

$ErrorActionPreference = 'Stop'
$uri = [Uri]$ServiceUrl
if ($uri.Scheme -ne 'https') {
    throw 'ServiceUrl must use HTTPS.'
}
if ([string]::IsNullOrWhiteSpace($uri.Host)) {
    throw 'ServiceUrl must contain a hostname.'
}

$secureToken = Read-Host 'Device bearer token' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try {
    $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if ([string]::IsNullOrWhiteSpace($plainToken) -or $plainToken.Length -lt 16) {
        throw 'The device token is missing or unexpectedly short.'
    }

    $config = [ordered]@{
        url = $uri.AbsoluteUri
        expected_hostname = $uri.Host.ToLowerInvariant()
        token = $plainToken
    }
    $json = $config | ConvertTo-Json -Compress
    $protected = ConvertTo-SecureString -String $json -AsPlainText -Force | ConvertFrom-SecureString
    $destination = Join-Path $PSScriptRoot 'device-credential.dpapi'
    Set-Content -LiteralPath $destination -Value $protected -Encoding UTF8 -NoNewline
    Write-Host "Created DPAPI credential for $($uri.Host) at $destination"
    Write-Host 'The file is bound to the current Windows user. Do not share or commit it.'
}
finally {
    if ($pointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
    $plainToken = $null
}
