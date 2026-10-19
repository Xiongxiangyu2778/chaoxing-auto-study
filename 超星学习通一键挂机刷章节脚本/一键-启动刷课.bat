@echo off
chcp 65001 >nul
title Xue Xi Tong Auto Course - Standalone Mode
cd /d "%~dp0"

set "WORKDIR=%~dp0"
set "NODE_PATH=%WORKDIR%node_modules"

rem ── 自动寻找 Node.js：① 系统 PATH ② WorkBuddy 自带（开发者机器）──
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if defined NODE goto HAVE_NODE
if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if defined NODE goto HAVE_NODE

:NO_NODE
echo.
echo   [X] 没有找到 Node.js —— 这是脚本的运行环境。
echo   请先双击「一键-安装环境.bat」，按提示装好后再运行本文件。
echo.
pause
exit /b 1

:HAVE_NODE
rem 依赖检查：没装 playwright-core 就直接提示，别让它静默失败
if not exist "%WORKDIR%node_modules\playwright-core" goto NO_DEP

set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
set "PROFILE=%USERPROFILE%\edge-quiz-profile"

echo ============================================================
echo      Xue Xi Tong  -  Auto Course Runner  (v5)
echo ============================================================
echo   Node : %NODE%
echo.
echo [1/4] Checking standalone Edge (debug port 9222) ...

powershell -NoProfile -Command "try { $null = Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json/version' -UseBasicParsing -TimeoutSec 3; exit 0 } catch { exit 1 }"
if errorlevel 1 goto START_EDGE
echo       Already running - reusing it (your window stays open).
goto STEP2

:START_EDGE
echo       Not running - starting Edge ...
start "" "%EDGE%" --remote-debugging-port=9222 --user-data-dir="%PROFILE%" --no-first-run --window-size=1400,900 --autoplay-policy=no-user-gesture-required --disable-features=CalculateNativeWinOcclusion --mute-audio about:blank

:EDGE_WAIT
timeout /t 8 >nul

:STEP2
echo.
echo [2/4] Stopping old script process (browser is kept) ...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*chaoxing_course*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 3 >nul

echo.
echo [3/4] Starting the course script ...
start "ChaoxingNode" /min "%NODE%" "%WORKDIR%chaoxing_course.js"
timeout /t 12 >nul

echo.
echo [4/4] Status
powershell -NoProfile -Command "$n = @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*chaoxing_course*' }).Count; $e = @(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*edge-quiz-profile*' } | Measure-Object).Count; Write-Host ('   script process : ' + $n); Write-Host ('   edge  process  : ' + $e); if ($n -gt 0) { Write-Host '   STATUS: RUNNING - safe to leave it working.' } else { Write-Host '   STATUS: NOT RUNNING - check the log file.' }"

echo.
echo ------------------------------------------------------------
echo   HOW TO USE
echo    1. Edge 打开后，进你的课程，随便点开一个章节。
echo    2. 之后全自动。
echo    3. 可以最小化窗口，但别关它。
echo.
echo   调倍速     : 记事本打开 刷课配置.json 改 speed
echo   Pause      : 一键-暂停刷课.bat
echo   Resume     : 一键-继续刷课.bat
echo   Stop script: 一键-停止刷课.bat  (browser stays open)
echo   Homework   : 上一级目录，打开 写作业 文件夹
echo ------------------------------------------------------------
echo.
pause
exit /b 0

:NO_DEP
echo.
echo   [X] 缺少依赖 playwright-core（node_modules 里没找到）。
echo   请先双击「一键-安装环境.bat」自动安装，然后再运行本文件。
echo.
pause
exit /b 1
