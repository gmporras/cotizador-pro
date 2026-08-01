@echo off
title Cotizador PRO V10 - Servidor
color 1F
cls
echo.
echo  =============================================
echo       Cotizador PRO V10 - Iniciando...
echo  =============================================
echo.

cd /d "%~dp0"

if not exist "servidor.js" (
    echo  [ERROR] No se encontro servidor.js
    pause & exit /b 1
)
if not exist "Cotizador_Pro_V10.html" (
    echo  [ERROR] No se encontro Cotizador_Pro_V10.html
    pause & exit /b 1
)

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js no instalado. Descarga en: https://nodejs.org
    pause & exit /b 1
)

if not exist "node_modules\pdf-parse\dist" (
    echo  Instalando modulo PDF ^(solo primera vez^)...
    npm install pdf-parse
)

echo  Iniciando servidor...
echo.

start /b cmd /c "timeout /t 3 /nobreak >nul && start Cotizador_Pro_V10.html"

echo Set WshShell = CreateObject("WScript.Shell") > "%TEMP%\minimizar.vbs"
echo WScript.Sleep 1500 >> "%TEMP%\minimizar.vbs"
echo WshShell.SendKeys "% n" >> "%TEMP%\minimizar.vbs"
start /b wscript "%TEMP%\minimizar.vbs"

node servidor.js

echo.
echo  Servidor detenido.
echo.
pause
