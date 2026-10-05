@echo off
title Firma masiva de documentos
cd /d "%~dp0"

rem Ejecuta el programa directamente con Python.
rem Uso: doble clic en este archivo para abrir la app.

where python >nul 2>nul
if not errorlevel 1 (
  python main.py
) else (
  py main.py
)

if errorlevel 1 (
  echo.
  echo No se pudo iniciar. Verifica que Python este instalado.
  pause
)
