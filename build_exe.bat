@echo off
setlocal enabledelayedexpansion
title Compilar Firmar.exe

rem ---------------------------------------------------------------
rem Genera un unico ejecutable portable (Firmar.exe) que se puede
rem copiar a una memoria USB y usar en cualquier PC con Windows.
rem Los archivos temporales de compilacion van a %%TEMP%% para no
rem ensuciar el proyecto ni sincronizarlos con OneDrive.
rem ---------------------------------------------------------------

cd /d "%~dp0"

rem Cierra la aplicacion si esta abierta: bloquea dist\Firmar.exe
tasklist /fi "imagename eq Firmar.exe" 2>nul | find /i "Firmar.exe" >nul
if not errorlevel 1 (
  echo Cerrando Firmar.exe que esta en uso...
  taskkill /f /im Firmar.exe >nul 2>&1
  ping -n 3 127.0.0.1 >nul
)

set "VENV=%TEMP%\firmar-build-venv"
set "WORK=%TEMP%\firmar-build-work"
set "OUT=%~dp0dist"

echo.
echo [1/4] Preparando entorno de compilacion...
if not exist "%VENV%\Scripts\python.exe" (
    python -m venv "%VENV%" || goto :error
)
set "PY=%VENV%\Scripts\python.exe"

echo [2/4] Instalando dependencias...
"%PY%" -m pip install --disable-pip-version-check -q --upgrade pip
"%PY%" -m pip install --disable-pip-version-check -q -r requirements.txt || goto :error
"%PY%" -m pip install --disable-pip-version-check -q pyinstaller || goto :error

echo [3/4] Limpiando compilaciones anteriores...
if exist "%WORK%" rd /s /q "%WORK%"
if exist "%OUT%" rd /s /q "%OUT%"

echo [4/4] Generando el ejecutable (tarda 1-3 minutos)...
"%PY%" -m PyInstaller ^
    --noconfirm ^
    --onefile ^
    --name "Firmar" ^
    --distpath "%OUT%" ^
    --workpath "%WORK%\build" ^
    --specpath "%WORK%" ^
    --add-data "%~dp0static;static" ^
    --collect-all pymupdf ^
    --collect-all uvicorn ^
    --exclude-module tkinter ^
    --exclude-module unittest ^
    --exclude-module test ^
    --exclude-module numpy ^
    --exclude-module IPython ^
    main.py || goto :error

echo.
echo Listo: "%OUT%\Firmar.exe"
for %%A in ("%OUT%\Firmar.exe") do echo Tamano: %%~zA bytes
echo.
echo Copia ese archivo a tu memoria USB y ejecutalo con doble clic.
echo Los datos (PDFs subidos y firmados) se guardan en la PC, no en la USB.
echo.
pause
exit /b 0

:error
echo.
echo ERROR: la compilacion fallo. Revisa el mensaje anterior.
pause
exit /b 1
