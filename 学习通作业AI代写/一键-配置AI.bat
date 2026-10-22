@echo off
chcp 65001 >nul
title 学习通 - 配置 AI（粘贴 key 即可）
cd /d "%~dp0"

set "PY="
for /d %%d in ("%~dp0..\*") do if exist "%%d\python\python.exe" set "PY=%%d\python\python.exe"
if not defined PY where py >nul 2>nul && set "PY=py -3"
if not defined PY if exist "C:/Python311/python.exe" set "PY=C:/Python311/python.exe"
if not defined PY set "PY=python"

echo ============================================================
echo   配置 AI 答题用的 API Key（只需做一次）
echo ------------------------------------------------------------
echo   1. 浏览器打开 https://open.bigmodel.cn/usercenter/apikeys
echo   2. 注册登录（手机号即可），点「新建 API Key」
echo   3. 复制那串 key，回到这里右键粘贴，回车
echo   （智谱 glm-4.5-flash 是免费模型，答题不花钱）
echo ============================================================
echo.
set /p THEKEY=请粘贴 API Key 后回车：
echo.

if "%THEKEY%"=="" (
  echo [x] 没输入内容，已取消。
  echo.
  pause
  exit /b 1
)

%PY% chx.py llm --key "%THEKEY%"
echo.
echo ------------------------------------------------------------
echo  上面显示 [OK] 表示配置成功，以后双击「一键-全自动.bat」就行。
echo ------------------------------------------------------------
pause
