@echo off
cd /d %~dp0
echo ============================================
echo   Pip - Pulse Pet (Presage SmartSpectra)
echo ============================================
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js belum terinstall di PC ini.
  echo Install dulu dari https://nodejs.org  ^(pilih tombol LTS^),
  echo lalu jalankan file ini lagi.
  echo.
  pause
  exit /b 1
)
if not exist node_modules (
  echo.
  echo Menginstall bahan-bahan Pip dulu ^(sekali saja, bisa beberapa menit^)...
  call npm install
)
echo.
echo Menjalankan Pip...
start "Pip server - jangan ditutup" cmd /c "npm start"
timeout /t 5 >nul
start http://localhost:3000
echo.
echo Pip dibuka di Chrome. Jendela "Pip server" jangan ditutup selama memakai Pip.
echo Untuk berhenti: tutup jendela server itu.
pause
