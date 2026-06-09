$file = Join-Path $PSScriptRoot "src\App.jsx"
$lines = [System.IO.File]::ReadAllLines($file, [System.Text.Encoding]::UTF8)
$newLines = new-object System.Collections.Generic.List[string]

for ($i = 0; $i -lt $lines.Length; $i++) {
    $lineNum = $i + 1
    # Skip lines 4400 to 5254 inclusive
    if ($lineNum -ge 4400 -and $lineNum -le 5254) {
        continue
    }
    $newLines.Add($lines[$i])
}

[System.IO.File]::WriteAllLines($file, $newLines, (New-Object System.Text.UTF8Encoding $false))
Write-Output "Successfully removed dead editor components."
