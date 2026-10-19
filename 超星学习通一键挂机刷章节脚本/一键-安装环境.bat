@echo off
chcp 65001 >nul
title 一键-安装运行环境（只需装一次）
cd /d "%~dp0"

echo ============================================================
echo    超星学习通挂机脚本 · 环境安装（第一次使用跑一次即可）
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 goto NO_NODE

echo [1/2] 检测到 Node.js，开始安装依赖 playwright-core（约 3 MB）...
call npm install playwright-core --no-fund --no-audit --loglevel=error
if exist "node_modules\playwright-core" goto DONE

echo.
echo       官方源失败，自动换国内镜像重试 ...
call npm install playwright-core --registry=https://registry.npmmirror.com --no-fund --no-audit --loglevel=error
if exist "node_modules\playwright-core" goto DONE

echo.
echo [X] 依赖安装失败，请把本窗口截图发给作者。
pause
exit /b 1

:NO_NODE
echo [X] 电脑上没有检测到 Node.js（本脚本的运行环境）。
echo.
echo 即将打开 Node.js 官网 —— 下载 LTS 版，一路「下一步」装完，
echo 然后回到本文件夹，重新双击「一键-安装环境.bat」。
echo.
start "" "https://nodejs.org/zh-cn"
pause
exit /b 1

:DONE
echo.
echo [2/2] 完成！以后不需要再运行本文件。
echo.
echo   下一步：双击「一键-启动刷课.bat」开始挂机。
echo.
pause
