@echo off
cd /d "D:\sistemacassav6\V5BT-sorgenti-e-roadmap-rimanente-20260818\SORGENTE_SISTEMA"
set "MOCK_PRINTER_FARM_HOST=127.0.0.1"
set "MOCK_PRINTER_FARM_METRICS_PORT=9299"
set "MOCK_PRINTER_FARM_PORTS=9201,9202,9203,9204"
set "NODE_ENV=development"
echo [%date% %time%] avvio printer-farm >> "D:\sistemacassav6\V5BT-sorgenti-e-roadmap-rimanente-20260818\.runtime\cassav5bt\logs\printer-farm.out.log"
node tools/mock-tcp-printer-farm.mjs >> "D:\sistemacassav6\V5BT-sorgenti-e-roadmap-rimanente-20260818\.runtime\cassav5bt\logs\printer-farm.out.log" 2>> "D:\sistemacassav6\V5BT-sorgenti-e-roadmap-rimanente-20260818\.runtime\cassav5bt\logs\printer-farm.err.log"
