@echo off
chcp 65001 >nul
title Xue Xi Tong Auto Course - Standalone Mode
cd /d "%~dp0"

set "NODE_PATH=%USERPROFILE%\.workbuddy\binaries\node\workspace\node_modules"
set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
set "PROFILE=%USERPROFILE%\edge-quiz-profile"
set "WORKDIR=%~dp0"

echo ============================================================
echo      Xue Xi Tong  -  Auto Course Runner  (v4 final)
echo ============================================================
echo.
echo [1/4] Checking standalone Edge (debug port 9222) ...

powershell -NoProfile -Command "try { $null = Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json/version' -UseBasicParsing -TimeoutSec 3; exit 0 } catch { exit 1 }"
if errorlevel 1 goto START_EDGE
echo       Already running - reusing it (your window stays open).
goto STEP2

:START_EDGE
echo       Not running - starting Edge ...
schtasks /run /tn "ChaoxingEdge" >nul 2>&1
if errorlevel 1 goto EDGE_DIRECT
goto EDGE_WAIT

:EDGE_DIRECT
echo       Fallback: launching Edge directly ...
start "" "%EDGE%" --remote-debugging-port=9222 --user-data-dir="%PROFILE%" --no-first-run --window-size=1400,900 --autoplay-policy=no-user-gesture-required --disable-features=CalculateNativeWinOcclusion --mute-audio about:blank
goto EDGE_WAIT

:EDGE_WAIT
timeout /t 8 >nul

:STEP2
echo.
echo [2/4] Stopping old script process (browser is kept) ...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*chaoxing_course*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 3 >nul

echo.
echo [3/4] Starting the course script (system-service level) ...
powershell -NoProfile -Command "$e='%NODE_EXE%'; $p='%WORKDIR%chaoxing_course.js'; $d='%WORKDIR%'; $a=New-ScheduledTaskAction -Execute $e -Argument ([char]34+$p+[char]34) -WorkingDirectory $d; if (Get-ScheduledTask -TaskName 'ChaoxingNode' -ErrorAction SilentlyContinue) { Start-ScheduledTask -TaskName 'ChaoxingNode' } else { Register-ScheduledTask -TaskName 'ChaoxingNode' -Action $a -Force | Out-Null; Start-ScheduledTask -TaskName 'ChaoxingNode' }" >nul 2>&1
timeout /t 12 >nul

echo.
echo [4/4] Status
powershell -NoProfile -Command "$n = @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*chaoxing_course*' }).Count; $e = @(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*edge-quiz-profile*' } | Measure-Object).Count; Write-Host ('   script process : ' + $n); Write-Host ('   edge  process  : ' + $e); if ($n -gt 0) { Write-Host '   STATUS: RUNNING - safe to leave it working.' } else { Write-Host '   STATUS: NOT RUNNING - check the log file.' }"

echo.
echo ------------------------------------------------------------
echo   HOW TO USE
echo    1. Edge opens. Go to your course, click any section.
echo    2. Everything after that is automatic.
echo    3. You may minimize. Close the window only yourself.
echo.
echo   Speed       : 选择倍速.bat
echo   Pause       : 一键-暂停刷课.bat
echo   Resume      : 一键-继续刷课.bat
echo   Stop script : 一键-停止刷课.bat  (browser stays open)
echo   Homework    : go up one level, open 写作业 folder
echo ------------------------------------------------------------
echo.
pause
