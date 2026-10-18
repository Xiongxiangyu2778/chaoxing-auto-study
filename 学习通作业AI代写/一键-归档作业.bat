@echo off
rem ASCII-only (portable). Archive homework: questions + answers + screenshot.
title Archive Homework
cd /d "%~dp0"
chcp 65001 >nul

set "PY="
where py >nul 2>nul
if not errorlevel 1 set "PY=py -3"
if not defined PY (
  where python >nul 2>nul
  if not errorlevel 1 set "PY=python"
)
if not defined PY if exist "%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe" set "PY=%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
if not defined PY (
  echo [ERROR] Python 3 not found. Install Python 3 first (python.org).
  echo         The other two scripts (dump / fill) do NOT need Python.
  pause
  exit /b 1
)

echo ============================================
echo   Archive homework (questions + answers + screenshot)
echo ============================================
echo.
set /p COURSE=Course name (type it as shown in the course list): 
set /p SEQ=Homework No. (leave blank = auto increment): 
echo.
%PY% archive_homework.py "%COURSE%" "%SEQ%"
echo.
pause
