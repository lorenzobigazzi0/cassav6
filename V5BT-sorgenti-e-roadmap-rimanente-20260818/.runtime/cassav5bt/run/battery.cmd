@echo off
cd /d "D:\sistemacassav6\V5BT-sorgenti-e-roadmap-rimanente-20260818\SORGENTE_SISTEMA\battery-dashboard"
set "HOST=0.0.0.0"
set "NODE_ENV=development"
set "PORT=8865"
echo [%date% %time%] avvio battery >> "D:\sistemacassav6\V5BT-sorgenti-e-roadmap-rimanente-20260818\.runtime\cassav5bt\logs\battery.out.log"
node server/index.js >> "D:\sistemacassav6\V5BT-sorgenti-e-roadmap-rimanente-20260818\.runtime\cassav5bt\logs\battery.out.log" 2>> "D:\sistemacassav6\V5BT-sorgenti-e-roadmap-rimanente-20260818\.runtime\cassav5bt\logs\battery.err.log"
