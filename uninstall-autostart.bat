@echo off
chcp 936 >nul
title 取消开机自启
cd /d "%~dp0"

set "LINKNAME=API-Key-Pool.lnk"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"

echo.
if exist "%STARTUP%\%LINKNAME%" (
  del "%STARTUP%\%LINKNAME%"
  echo   已取消开机自启。
) else (
  echo   当前没有设置开机自启，无需取消。
)
echo.
pause
