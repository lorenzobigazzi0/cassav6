@echo off
cd /d "D:\sistemacassav6\V5BT-sorgenti-e-roadmap-rimanente-20260818\SORGENTE_SISTEMA"
set "MOCK_FISCAL_HOST=127.0.0.1"
set "MOCK_FISCAL_PORT=9390"
set "NODE_ENV=development"
echo [%date% %time%] avvio fiscal >> "D:\sistemacassav6\V5BT-sorgenti-e-roadmap-rimanente-20260818\.runtime\cassav5bt\logs\fiscal.out.log"
node tools/mock-fiscal-server.mjs >> "D:\sistemacassav6\V5BT-sorgenti-e-roadmap-rimanente-20260818\.runtime\cassav5bt\logs\fiscal.out.log" 2>> "D:\sistemacassav6\V5BT-sorgenti-e-roadmap-rimanente-20260818\.runtime\cassav5bt\logs\fiscal.err.log"
