@echo off
chcp 65001 >nul
title 自动听写 · 本地启动器
cd /d "%~dp0"

echo ================================================
echo    自动听写小程序 · 本地启动器
echo    程序在你自己这台电脑上运行，不经过任何服务器
echo ================================================
echo.

if not exist "node_modules" (
    echo [1/2] 首次运行:正在安装依赖，请稍候...
    call npm install
)

echo [2/2] 正在启动本地服务器，浏览器将自动打开...
start "本地听写【服务窗口-请勿关闭】" cmd /k "cd /d ""%~dp0"" && npm run preview"

timeout /t 6 /nobreak >nul
start "" "http://localhost:4173/"

echo.
echo 启动完成。浏览器会打开 http://localhost:4173/
echo 若没自动打开，请手动在浏览器输入这个网址。
echo 关闭时:关掉"服务窗口"即可停止程序。
timeout /t 4 /nobreak >nul