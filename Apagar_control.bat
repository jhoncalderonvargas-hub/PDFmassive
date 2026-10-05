@echo off
title Apagar Control de aplicaciones inteligente
cd /d "%~dp0"

net session >nul 2>&1
if errorlevel 1 (
  echo Este cambio necesita permisos de administrador.
  echo Haz clic derecho sobre este archivo -^> Ejecutar como administrador.
  echo.
  pause
  exit /b 1
)

echo Estado actual del control:
reg query "HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy" /v VerifiedAndReputablePolicyState
echo   1 = activo (bloquea Firmar.exe)   3 = apagado
echo.
echo Esto APAGA el Control de aplicaciones inteligente de Windows.
echo Importante: es un cambio de un solo sentido; para volver a
echo activarlo despues necesitarias reinstalar Windows.
echo.
choice /c SN /m "Quieres continuar? (S=si / N=no)"
if errorlevel 2 (
  echo Cancelado. No se hizo ningun cambio.
  pause
  exit /b 0
)

reg add "HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy" /v VerifiedAndReputablePolicyState /t REG_DWORD /d 3 /f

echo.
echo Listo. Ahora REINICIA el PC y vuelve a abrir dist\Firmar.exe
echo (puede tardar unos minutos en reflejarse).
echo.
pause
