@echo off
title 学习通 - 考试一条龙
cd /d "%~dp0..\写作业"
chcp 65001 >nul

set "PY="
for /d %%d in ("%~dp0..\..\*") do if exist "%%d\python\python.exe" set "PY=%%d\python\python.exe"
if not defined PY where py >nul 2>nul && set "PY=py -3"
if not defined PY if exist "C:/Python311/python.exe" set "PY=C:/Python311/python.exe"
if not defined PY if exist "%USERPROFILE%/.workbuddy/binaries/python/versions/3.13.12/python.exe" set "PY=%USERPROFILE%/.workbuddy/binaries/python/versions/3.13.12/python.exe"
if not defined PY set "PY=python"

echo ============================================================
echo  EXAM MODE: dump - AI answer - fill - archive
echo  1) enter the exam page yourself (captcha must be done by you)
echo  2) script walks all questions, AI answers, fills in
echo  3) files archived to  [archive dir]\课程名\第N次作业
echo  NOTE: final "submit exam" must be clicked by YOU.
echo ============================================================
echo.
%PY% chx.py exam %*
echo.
pause
