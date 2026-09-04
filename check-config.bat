@echo off
chcp 936 >nul
title ≈‰÷√ÃÂºÏ
cd /d "%~dp0"

echo.
node check-config.js %1
echo.
pause
