@echo off
chcp 936 >nul
title 放行 API 代理池端口（需要管理员权限）
echo ============================================
echo  放行防火墙端口 8787，允许局域网其他设备访问
echo  如果提示"请求的操作需要提升"，请右键本文件
echo  选择"以管理员身份运行"
echo ============================================
echo.
netsh advfirewall firewall add rule name="API-Key-Pool 8787" dir=in action=allow protocol=TCP localport=8787
echo.
if %errorlevel%==0 (
  echo [成功] 已放行 8787 端口
  echo 现在局域网内的设备可以用 http://本机IP:8787/v1 访问了
) else (
  echo [失败] 没有权限或已存在同名规则
  echo 请右键本文件 - 以管理员身份运行
)
echo.
pause
