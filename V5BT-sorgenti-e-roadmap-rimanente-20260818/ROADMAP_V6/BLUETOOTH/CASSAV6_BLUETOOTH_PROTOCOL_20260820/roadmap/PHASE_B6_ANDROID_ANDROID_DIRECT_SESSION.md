# B6 - Sessione Android-Android

## Stato

Verdetto `SOFTWARE PASS OFFLINE / NON-GATE`, senza blocker software residui.
Gate ufficiale `PENDING/BLOCKED`: richiede comunque la promozione dei
prerequisiti B0-B5 e una prova fisica monitorata fra due Android certificati.

## Elezione Dei Ruoli

Entrambi i device `FULL_NODE` possono essere central/peripheral. L'algoritmo
comune Node/Kotlin:

- richiede alias dello stesso epoch e capability coerenti;
- assegna un solo ruolo `CLIENT` e un solo ruolo `SERVER` usando l'ordine
  canonico degli alias;
- consente a un nodo `CLIENT_ONLY` soltanto il ruolo compatibile;
- rifiuta combinazioni ambigue, epoch differenti e capability insufficienti;
- arbitra connessioni duplicate sulla coppia ordinata delle identita.

I vettori golden condivisi coprono elezione e arbitraggio in entrambe le
direzioni: `7/7 PASS` nello snapshot del 18 agosto 2026.

## Fiducia E Autenticazione A2

La sessione Android-Android usa A2 e non riutilizza implicitamente il trust
Android-Raspberry:

- directory peer firmata da autorita P-256 con revision, expiry e stato
  `ACTIVE/REVOKED`;
- endpoint HTTPS canonico `/v1/peer-trust-directory`, TLS 1.3 e pin SPKI;
- cache Android atomica e privata in `noBackupFilesDir`;
- risoluzione dell'identita tramite alias corrente o successivo;
- firme reciproche legate a HELLO, advertisement, alias epoch, ruoli e
  transcript;
- consegna delle chiavi di sessione e del `peerTrustId` soltanto dopo conferma
  reciproca.

Directory scaduta, revisione regressiva, peer revocato, firma non canonica,
clock regressivo o alias non risolvibile lasciano la sessione non autenticata.
Non esiste fallback automatico ad A1. I casi A2 sono inclusi nella matrice
full `340/340 PASS` su entrambe le app.

## Data Plane

Il profilo GATT espone control, `DATA_RX`, `DATA_TX` e `ACK_TX`. Bridge,
operation queue, reliable data plane e multiplexer di sessione tengono
separate le direzioni DATA/ACK, correlano le callback e azzerano subscription,
code e materiale di sessione al teardown.

Il wiring software copre deadline DATA/ACK/CCCD, callback stale, runtime
fail-closed, arbiter e integrazione in-memory B7-B10. Palmare debug e
Postazione debug chiudono entrambi 59 classi e `340/340 PASS`, zero failure,
errori o skip; compile Kotlin, inventory e parita byte del core condiviso sono
positivi. Il watchdog advertiser Postazione `api31Compat` chiude `7/7 PASS`
come test mirato, non come suite full della variante.

La presenza di questo PASS non costituisce evidenza radio. La sessione fisica
deve ancora dimostrare A2, scambio bidirezionale, ACK, retry, reconnect e
cleanup su due device reali.

## Feature Gate

Il percorso e disabilitato per default. L'avvio richiede almeno build Lab,
master failover, peer link, A2 e configurazione trust completa. Un valore
mancante o invalido deve bloccare build o runtime, non abilitare un percorso
ridotto.

## Criterio Di PASS Formale

B6 puo diventare `PASS` soltanto dopo:

1. PASS e revisione di B0-B5;
2. due Android eleggibili con identita `READY` e monitor continui;
3. elezione complementare senza doppia connessione;
4. A2 reciproca valida e data plane DATA/ACK realmente osservato;
5. disconnect/reconnect senza cross-peer restore o perdita di cleanup;
6. report redatto e revisione indipendente.

Il risultato software resta non-gate e non sostituisce il criterio fisico.
L'avanzamento ufficiale resta 49%.
