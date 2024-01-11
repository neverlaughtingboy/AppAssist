@echo off
setlocal enabledelayedexpansion

rem 检查curl是否存在
where curl >nul 2>nul
if %errorlevel% neq 0 (
    echo curl is not available, please install it or add to your PATH.
    exit /b
)

rem 从urls.txt文件读取每个URL并下载它们
for /f "tokens=*" %%a in (remote_rules.txt) do (
    rem 使用curl下载文件
    echo Downloading %%a...
    curl -O %%a
    if !errorlevel! neq 0 (
        echo Failed to download %%a
    )
)

rem 下载完成，保持窗口打开
echo.
echo Download completed. Press any key to exit.
pause >nul
