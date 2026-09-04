@echo off
chcp 936 >nul
title 设置开机自启
cd /d "%~dp0"

set "LINKNAME=API-Key-Pool.lnk"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "TARGET=%~dp0start-bg.vbs"

echo.
echo   把代理池加入开机自启（后台静默运行，不弹窗口）
echo.

if not exist "%TARGET%" (
  echo   [x] 找不到 start-bg.vbs
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut('%STARTUP%\%LINKNAME%'); $s.TargetPath='%TARGET%'; $s.WorkingDirectory='%~dp0'; $s.Description='API Key Pool'; $s.Save()"

if exist "%STARTUP%\%LINKNAME%" (
  echo   设置成功。以后开机后会自动在后台启动代理池。
  echo.
  echo   快捷方式位置：
  echo   %STARTUP%\%LINKNAME%
  echo.
  echo   想取消时，运行 uninstall-autostart.bat
) else (
  echo   [x] 设置失败，请右键以管理员身份重新运行本文件
)

echo.
pause
