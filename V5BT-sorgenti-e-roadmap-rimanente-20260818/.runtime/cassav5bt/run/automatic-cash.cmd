@echo off
cd /d "D:\sistemacassav6\V5BT-sorgenti-e-roadmap-rimanente-20260818\SORGENTE_SISTEMA"
set "FAKE_AUTOMATIC_CASH_DEPOSIT_TOTAL_CENTS=2000"
set "FAKE_AUTOMATIC_CASH_HOST=127.0.0.1"
set "FAKE_AUTOMATIC_CASH_PORT=9391"
set "FAKE_AUTOMATIC_CASH_STOCK_PER_DENOMINATION=120"
set "NODE_ENV=development"
echo [%date% %time%] avvio automatic-cash >> "D:\sistemacassav6\V5BT-sorgenti-e-roadmap-rimanente-20260818\.runtime\cassav5bt\logs\automatic-cash.out.log"
node tools/fake-automatic-cash-gateway.mjs >> "D:\sistemacassav6\V5BT-sorgenti-e-roadmap-rimanente-20260818\.runtime\cassav5bt\logs\automatic-cash.out.log" 2>> "D:\sistemacassav6\V5BT-sorgenti-e-roadmap-rimanente-20260818\.runtime\cassav5bt\logs\automatic-cash.err.log"
