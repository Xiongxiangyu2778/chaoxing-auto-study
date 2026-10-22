@echo off
chcp 65001 >nul
title 学习通 - 只填答（考试页/作业页通用）
cd /d "%~dp0..\写作业"
if not exist "chx.py" (
  echo [错误] 没找到 写作业\chx.py，请确认目录结构完整
  pause
  exit /b 1
)

set "PY="
for /d %%d in ("%~dp0..\..\*") do if exist "%%d\python\python.exe" set "PY=%%d\python\python.exe"
if not defined PY where py >nul 2>nul && set "PY=py -3"
if not defined PY if exist "C:/Python311/python.exe" set "PY=C:/Python311/python.exe"
if not defined PY if exist "%USERPROFILE%/.workbuddy/binaries/python/versions/3.13.12/python.exe" set "PY=%USERPROFILE%/.workbuddy/binaries/python/versions/3.13.12/python.exe"
if not defined PY set "PY=python"

echo ============================================================
echo  FILL ONLY: use existing answers.json
echo  auto-detects homework page or exam page
echo  NOTE: final "submit" must be clicked by YOU.
echo ============================================================
echo.
%PY% chx.py fill %*
echo.
pause
