@echo off
setlocal
pushd "%~dp0"
if defined PYTHON_EXECUTABLE (
  "%PYTHON_EXECUTABLE%" -u run.py %*
) else if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -u run.py %*
) else if exist "%USERPROFILE%\anaconda3\python.exe" (
  "%USERPROFILE%\anaconda3\python.exe" -u run.py %*
) else (
  where py.exe >nul 2>nul
  if errorlevel 1 (
    python.exe -u run.py %*
  ) else (
    py -3 -u run.py %*
  )
)
set "roadwatch_exit=%errorlevel%"
popd
if not "%roadwatch_exit%"=="0" if /i "%~1"=="" pause
exit /b %roadwatch_exit%
