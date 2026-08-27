@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [錯誤] 尚未安裝 Node.js。
  echo 請先安裝 Node.js LTS：https://nodejs.org/
  pause
  exit /b 1
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo 正在安裝 pnpm...
  call npm install -g pnpm
  if errorlevel 1 (
    echo [錯誤] pnpm 安裝失敗，請確認公司網路或系統權限。
    pause
    exit /b 1
  )
)

if not exist node_modules (
  echo 正在安裝專案套件，第一次會需要幾分鐘...
  call pnpm install --frozen-lockfile
  if errorlevel 1 (
    echo [錯誤] 套件安裝失敗。
    pause
    exit /b 1
  )
)

echo 正在啟動 SPC 工程管理系統...
call pnpm dev
pause
