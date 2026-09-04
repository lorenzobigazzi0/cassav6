# Fase P4 - confronto paced100 post auto-print interrotto

Data: 2026-07-10

## Run

- ID: `p4_paced100_autoprint_postfix_20260710_1915`
- un solo tentativo, avviato alle 19:14:14 CEST
- 100 palmari, 10 postazioni, 100 SSE
- 20 ordini e 10 altre azioni per palmare
- intervallo nominale 10.000ms, timeout client 9.000ms
- durata attiva massima 300.000ms, drain massimo 30.000ms
- nessun retry del generatore
- stampante TCP e fiscale solo su loopback; cassa automatica disabilitata

## Checkpoint osservati

| Ordini persistiti | Device presenti | Min per device | Max per device |
|---:|---:|---:|---:|
| 600 | 100 | 6 | 6 |
| 930 | 100 | 9 | 10 |
| 1.193 | 100 | 11 | 12 |
| 1.634 | 100 | 16 | 17 |

Al checkpoint da 930 ordini risultavano 1.315 job stampa `confirmed`, un job
`sent` e due eventi outbox non pubblicati. Al checkpoint da 1.193 ordini erano
presenti 14 eventi outbox e 7 job stampa transitori: il drain finale non e'
stato osservabile.

Il progresso era nettamente superiore al baseline, che nella parte finale
della stessa finestra era rimasto a circa 12-13 ordini persistiti per device.
Il confronto prestazionale non puo' comunque essere chiuso senza il report
finale.

## Interruzione target

Prima della fine il Raspberry `192.168.1.79` e' scomparso dalla rete:

- SSH: `No route to host`
- ping: nessuna risposta
- ARP: stato `FAILED`
- la chiave SSH del target non e' comparsa su altri indirizzi della rete `/24`
- il target era ancora assente oltre il `RuntimeMaxSec` del run

Non e' stato effettuato alcun retry del test. La causa non e' attribuibile con
certezza finche' non sono disponibili il boot precedente e i log locali del
target.

## Prossima diagnosi alla riconnessione

1. Verificare uptime, `last -x`, motivo del reboot e stato dell'unita' transient.
2. Leggere `journalctl -b -1`, kernel log, OOM, watchdog e panic.
3. Controllare temperatura, throttling e undervoltage con `vcgencmd`.
4. Recuperare report o artefatti parziali in
   `/opt/cassav4/current/logs/loadtest-p4_paced100_autoprint_postfix_20260710_1915/`.
5. Verificare il ripristino automatico di tutti i servizi live.
6. Non rilanciare il carico prima di avere classificato la caduta.

## Correzione diagnostica precedente al run

Il checker del passo da 10 secondi tollera ora 5ms di granularita' timer, cosi'
un gap osservato di 9.999ms non produce un falso errore. Il carico generato non
e' cambiato. Sintassi e preflight: 11/11 verdi.
