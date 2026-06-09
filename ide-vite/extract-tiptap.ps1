$srcFile = Join-Path $PSScriptRoot "..\ide\MIyzamchy Legal IDE.html"
$dstFile = Join-Path $PSScriptRoot "src\tiptap-setup.js"

$lines = [System.IO.File]::ReadAllLines($srcFile, [System.Text.Encoding]::UTF8)
# Lines 52-232 (0-indexed: 51..231) are the tiptap module script
$tiptap = $lines[51..231]
[System.IO.File]::WriteAllLines($dstFile, $tiptap, (New-Object System.Text.UTF8Encoding $false))
Write-Output "Extracted $($tiptap.Length) lines to tiptap-setup.js"
