$file = Join-Path $PSScriptRoot "src\App.jsx"
$lines = [System.IO.File]::ReadAllLines($file, [System.Text.Encoding]::UTF8)

$newLines = new-object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($i -ge 8303 -and $i -le 8307) {
        if ($lines[$i] -match "setLeftW|setNpaCollapsed|setLeftOpen|setActPanel") {
            continue
        }
    }
    $newLines.Add($lines[$i])
}
[System.IO.File]::WriteAllLines($file, $newLines, (New-Object System.Text.UTF8Encoding $false))
Write-Output "Lines removed."
