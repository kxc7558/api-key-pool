@echo off
chcp 936 >nul
title 停止 API Key 代理池
cd /d "%~dp0"

set PORT=8787
echo.
echo   正在停止占用 %PORT% 端口的服务...
echo.

set KILLED=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT%" ^| findstr /i LISTENING') do (
  echo   结束进程 PID %%p
  taskkill /F /PID %%p >nul 2>nul
  set KILLED=1
)

if "%KILLED%"=="0" (
  echo   端口 %PORT% 上没有正在运行的服务。
) else (
  echo   已停止。
)

echo.
timeout /t 2 >nul
