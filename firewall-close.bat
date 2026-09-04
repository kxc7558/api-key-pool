@echo off
chcp 936 >nul
title 关闭 API 代理池端口放行
echo 将删除防火墙规则 "API-Key-Pool 8787"
netsh advfirewall firewall delete rule name="API-Key-Pool 8787"
echo.
pause
