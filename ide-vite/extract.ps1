$srcFile = Join-Path $PSScriptRoot "..\ide\MIyzamchy Legal IDE.html"
$dstFile = Join-Path $PSScriptRoot "src\LegacyApp.jsx"

$lines = [System.IO.File]::ReadAllLines($srcFile, [System.Text.Encoding]::UTF8)
# Lines 274-9541 (0-indexed: 273..9540) are the JSX code inside <script type="text/babel">
$jsx = $lines[273..9540]
[System.IO.File]::WriteAllLines($dstFile, $jsx, (New-Object System.Text.UTF8Encoding $false))
Write-Output "Extracted $($jsx.Length) lines to LegacyApp.jsx"
