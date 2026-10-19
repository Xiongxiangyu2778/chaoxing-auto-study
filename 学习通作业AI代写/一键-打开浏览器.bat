@echo off
title 学习通 - 打开浏览器
cd /d "%~dp0"
chcp 65001 >nul

set "PY="
for /d %%d in ("%~dp0..\*") do if exist "%%d\python\python.exe" set "PY=%%d\python\python.exe"
if not defined PY where py >nul 2>nul && set "PY=py -3"
if not defined PY if exist "C:\Python311\python.exe" set "PY=C:\Python311\python.exe"
if not defined PY if exist "%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe" set "PY=%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"
if not defined PY set "PY=python"

echo ============================================
echo  Step: open the standalone browser on the course list
echo  (browser opens automatically; login once if needed)
echo ============================================
echo.
%PY% chx.py browser
echo.
pause
