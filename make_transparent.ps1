Add-Type -AssemblyName System.Drawing
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$inputPath = "$scriptDir\logo\Logo.png"
$outputPath = "$scriptDir\logo\Logo_transparent.png"

Write-Host "Loading from: $inputPath"

$bmp = [System.Drawing.Image]::FromFile($inputPath)
$bitmap = New-Object System.Drawing.Bitmap($bmp)
$bmp.Dispose()

for ($x = 0; $x -lt $bitmap.Width; $x++) {
    for ($y = 0; $y -lt $bitmap.Height; $y++) {
        $pixel = $bitmap.GetPixel($x, $y)
        if ($pixel.R -gt 215 -and $pixel.G -gt 215 -and $pixel.B -gt 215) {
            $bitmap.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
        }
    }
}
$bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
Write-Host "Success! Transparent logo saved to $outputPath"
