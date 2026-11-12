@echo off
setlocal
pushd "%~dp0"
if defined PYTHON_EXECUTABLE (
  "%PYTHON_EXECUTABLE%" -u run.py %*
) else if exist "%USERPROFILE%\anaconda3\python.exe" (
  "%USERPROFILE%\anaconda3\python.exe" -u run.py %*
) else (
  py -3 -u run.py %*
)
set "roadwatch_exit=%errorlevel%"
popd
if not "%roadwatch_exit%"=="0" pause
exit /b %roadwatch_exit%
