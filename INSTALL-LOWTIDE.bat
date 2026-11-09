@echo off
title Lowtide installer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-lowtide.ps1"
pause
