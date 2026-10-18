@echo off
title Stop Auto Course Script (browser kept)
echo.
echo Stopping the auto-course script ...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*chaoxing_course*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 2 >nul
powershell -NoProfile -Command "$n = @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*chaoxing_course*' }).Count; if ($n -eq 0) { Write-Host '   Script stopped. Your Edge window is untouched.' } else { Write-Host '   Still running, please retry.' }"
echo.
echo Browser stays open - close it yourself when done.
echo.
pause
