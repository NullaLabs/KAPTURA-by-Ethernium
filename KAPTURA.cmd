@echo off
title KAPTURA v2.0 :: Ethernium Sovereign Studio + GPU Daemon (:3370)
cd /d "%~dp0"

echo ========================================================================
echo    KAPTURA v2.0 :: Sovereign Capture Studio + GPU Daemon (:3370)
echo ========================================================================
echo.

where node >nul 2>nul
if %errorlevel% equ 0 (
    echo Iniciando Daemon GPU Unificado en http://127.0.0.1:3370 ...
    start "" "http://127.0.0.1:3370"
    node daemon/server.mjs
    goto :eof
)

where python >nul 2>nul
if %errorlevel% equ 0 (
    echo Node.js no detectado; iniciando Studio web estatico en http://127.0.0.1:8740 ...
    start "" "http://127.0.0.1:8740"
    python -m http.server 8740
    goto :eof
)

echo Abriendo directamente en el navegador...
start "" "%~dp0index.html"
