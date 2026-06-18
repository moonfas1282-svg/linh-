@echo off
setlocal
cd /d %~dp0
where node >nul 2>nul || (echo Chua cai Node.js & pause & exit /b 1)
call npm install || goto :error
call npx expo prebuild --platform android || goto :error
cd android
call gradlew.bat assembleRelease || goto :error
copy /Y app\build\outputs\apk\release\app-release.apk ..\RunPulse-release.apk
cd ..
echo.
echo DA BUILD XONG: %CD%\RunPulse-release.apk
pause
exit /b 0
:error
echo.
echo BUILD THAT BAI. Mo Android Studio va cai Android SDK neu may chua co.
pause
exit /b 1
