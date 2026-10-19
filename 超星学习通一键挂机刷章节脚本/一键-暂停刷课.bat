@echo off
chcp 65001 >nul
title Auto Course - PAUSE
cd /d "%~dp0"
"%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe" -c "import json,io; p='刷课配置.json'; c=json.load(io.open(p,encoding='utf-8')); c['paused']=True; json.dump(c, io.open(p,'w',encoding='utf-8'), ensure_ascii=False, indent=2)"
echo.
echo   [PAUSED] 脚本已停止操作页面，你现在可以自己补作业。补完双击「一键-继续刷课.bat」。
echo.
pause
