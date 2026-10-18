@echo off
title Auto Course - RESUME
cd /d "%~dp0"
"%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe" -c "import json,io; p='刷课配置.json'; c=json.load(io.open(p,encoding='utf-8')); c['paused']=False; json.dump(c, io.open(p,'w',encoding='utf-8'), ensure_ascii=False, indent=2)"
echo.
echo   [RESUMED] 已恢复自动刷课（4 秒内生效，无需重启）。
echo.
pause
