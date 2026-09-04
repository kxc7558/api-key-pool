@echo off
chcp 936 >nul
title API Key 代理池
cd /d "%~dp0"
set "NODE=C:\Program Files\nodejs\node.exe"

echo.
echo   ============================================
echo      API Key 代理池  (OpenAI 兼容)
echo   ============================================
echo.

if not exist "%NODE%" (
  echo   [x] 没有检测到 Node.js
  echo.
  echo       请先安装 Node.js 18 或更高版本：
  echo       https://nodejs.org/zh-cn/download
  echo       下载后一路"下一步"即可，装完重新双击本文件。
  echo.
  pause
  exit /b 1
)

for /f "tokens=1" %%v in ('"%NODE%" -v') do set NODEV=%%v
echo    Node 版本: %NODEV%

if not exist "config.json" (
  echo   [x] 当前目录下没有 config.json
  pause
  exit /b 1
)

echo.
echo    接入地址   http://127.0.0.1:8787/v1
echo    状态面板   http://127.0.0.1:8787/
echo.
echo    改动 config.json 后保存即自动生效，不用重启。
echo    关闭本窗口 = 停止服务。
echo.
echo   ============================================
echo.

"%NODE%" server.js

echo.
echo   服务已停止。
pause
