@echo off
title Cotizador PRO V9 - IA Serper + OpenRouter
color 1F
cls
echo.
echo  =============================================
echo       Cotizador PRO V9 - Iniciando...
echo  =============================================
echo.

:: Ir a la carpeta donde esta este .bat
cd /d "%~dp0"
echo  Carpeta: %CD%
echo.

:: Verificar archivos necesarios
if not exist "servidor.js" (
    echo  [ERROR] No se encontro servidor.js en esta carpeta.
    echo  Carpeta actual: %CD%
    pause
    exit /b 1
)
echo  OK - servidor.js encontrado

if not exist "Cotizador_Pro_V9.html" (
    echo  [ERROR] No se encontro Cotizador_Pro_V9.html
    pause
    exit /b 1
)
echo  OK - Cotizador_Pro_V9.html encontrado

:: Verificar Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js no instalado.
    echo  Descargalo en: https://nodejs.org ^(version LTS^)
    pause
    exit /b 1
)
echo  OK - Node.js detectado

:: Instalar pdf-parse si no existe
if not exist "node_modules\pdf-parse\dist" (
    echo.
    echo  Instalando modulo PDF ^(solo primera vez, espera 1 minuto^)...
    npm install pdf-parse
    echo  Modulo PDF instalado.
)
echo  OK - Modulos listos
echo.
echo  Iniciando servidor...
echo.

:: Abrir HTML despues de 3 segundos
start /b cmd /c "timeout /t 3 /nobreak >nul && start "" Cotizador_Pro_V9.html"

:: Minimizar despues de 2 segundos
start /b cmd /c "timeout /t 2 /nobreak >nul && powershell -WindowStyle Hidden -Command (New-Object -ComObject Shell.Application).MinimizeAll()"

:: Arrancar servidor (ventana queda abierta con logs)
node servidor.js

echo.
echo  =============================================
echo       Servidor detenido.
echo  =============================================
echo.
pause
