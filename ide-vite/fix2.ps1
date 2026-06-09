$file = "c:\Users\Professional\Desktop\ИИ\ide-vite\src\App.jsx"
$lines = [System.IO.File]::ReadAllLines($file, [System.Text.Encoding]::UTF8)

# The goal is to move lines 8762, 8763 (indices 8761, 8762) to be right after line 8741 (index 8740).
$lineToMove1 = $lines[8761]
$lineToMove2 = $lines[8762]

# Blank them out where they were
$lines[8761] = "  // moved up"
$lines[8762] = "  //"

# Insert them after index 8740
$newLines = new-object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $lines.Length; $i++) {
    $newLines.Add($lines[$i])
    if ($i -eq 8740) {
        $newLines.Add($lineToMove1)
        $newLines.Add($lineToMove2)
    }
}

[System.IO.File]::WriteAllLines($file, $newLines, (New-Object System.Text.UTF8Encoding $false))
Write-Output "Lines moved."
