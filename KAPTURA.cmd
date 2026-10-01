@echo off
title KAPTURA :: Ethernium Sovereign Video & Screen Studio
cd /d "%~dp0"

echo ========================================================================
echo    KAPTURA :: Local-First 4K Screen & Canvas Studio by Ethernium
echo ========================================================================
echo.

where python >nul 2>nul
if %errorlevel% equ 0 (
    echo Iniciando servidor local en http://127.0.0.1:8740 ...
    echo Abriendo Kaptura en tu navegador...
    start "" "http://127.0.0.1:8740"
    python -m http.server 8740
) else (
    echo Abriendo directamente en el navegador...
    start "" "%~dp0index.html"
)
