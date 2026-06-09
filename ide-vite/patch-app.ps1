$file = Join-Path $PSScriptRoot "src\LegacyApp.jsx"
$lines = [System.IO.File]::ReadAllLines($file, [System.Text.Encoding]::UTF8)

# Find first line
$firstLineIdx = 0
if ($lines[0] -match "const {useState,useEffect,useRef,useCallback,useMemo}=React;") {
    # Replace it with our imports
    $imports = @"
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import * as ReactDOM from 'react-dom/client';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { diff_match_patch } from 'diff-match-patch';
import './ide-styles.css';
import './tiptap-setup.js';

window.React = React;
window.DOMPurify = DOMPurify;
window.marked = marked;
window.diff_match_patch = diff_match_patch;
"@
    $lines[0] = $imports
}

$newLines = new-object System.Collections.Generic.List[string]
foreach ($line in $lines) {
    $newLines.Add($line)
}

$newLines.Add("export default App;")

[System.IO.File]::WriteAllLines($file, $newLines, (New-Object System.Text.UTF8Encoding $false))
Write-Output "LegacyApp.jsx modified with imports and export."
