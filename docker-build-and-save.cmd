@echo off
setlocal

cd /d "%~dp0"

where docker >nul 2>nul
if errorlevel 1 (
  echo Docker is not available. Please install Docker Desktop first.
  exit /b 1
)

if not exist ".env.docker" (
  copy ".env.docker.example" ".env.docker" >nul
  echo Created .env.docker. Please fill SUPABASE_SERVICE_ROLE_KEY, then run this file again.
  exit /b 1
)

docker compose build
if errorlevel 1 exit /b 1

docker save spc-project-management:latest -o spc-project-management.tar
if errorlevel 1 exit /b 1

echo Done: spc-project-management.tar
