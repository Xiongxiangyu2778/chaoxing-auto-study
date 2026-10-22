@echo off
chcp 65001 >nul
title 学习通 - 一键全自动
cd /d "%~dp0"

set "PY="
for /d %%d in ("%~dp0..\*") do if exist "%%d\python\python.exe" set "PY=%%d\python\python.exe"
if not defined PY where py >nul 2>nul && set "PY=py -3"
if not defined PY if exist "C:/Python311/python.exe" set "PY=C:/Python311/python.exe"
if not defined PY if exist "%USERPROFILE%/.workbuddy/binaries/python/versions/3.13.12/python.exe" set "PY=%USERPROFILE%/.workbuddy/binaries/python/versions/3.13.12/python.exe"
if not defined PY set "PY=python"

echo ============================================================
echo  FULL AUTO: 导出题目 - AI答题 - 自动填答 - 归档
echo  1) browser opens by itself, click into the homework page
echo  2) script exports questions, AI answers, fills them in
echo  3) files archived to  [archive dir]\课程名\第N次作业
echo  NOTE: final "submit" must be clicked by YOU.
echo ============================================================
echo.
%PY% chx.py auto %*
echo.
pause
