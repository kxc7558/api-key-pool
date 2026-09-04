@echo off
chcp 936 >nul
title API Key 代理池 - 自检
cd /d "%~dp0"

echo.
echo   开始自检，会真实调用 API（消耗少量额度）
echo.
node test.js %1 %2
echo.
pause
