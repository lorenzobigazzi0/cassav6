# Handoff Codex - Gateway Cassa Automatica Reset/Riavvio

Data: 2026-06-30

Obiettivo: far funzionare i comandi **RIAVVIA CASSA** e **RESET CASSA** della
sezione Pagamenti/Funzioni cassa automatica. I comandi devono essere protetti da
modale di conferma lato frontend e devono chiamare il gateway reale della cassa
automatica.

## Stato Attuale App Cassa V4

Lato frontend mobile i pulsanti esistono gia':

- `RIAVVIA CASSA`
- `RESET CASSA`

File:

```text
mobile-frontend/src/pages/PaymentsPage.tsx
```

La modale di conferma esiste gia' nello stesso file:

- titolo `Conferma riavvio cassa automatica` oppure `Conferma reset cassa automatica`;
- testo diverso per riavvio e reset;
- pulsante annulla;
- pulsante conferma;
- X di chiusura.

La UI chiama:

```text
mobile-frontend/src/api/automaticCash.ts
```

Funzioni:

```ts
restartAutomaticCashGateway({ reason })
resetAutomaticCashGateway({ reason })
```

Endpoint backend Cassa V4 gia' presenti:

```text
POST /api/automatic-cash/gateway/restart
POST /api/automatic-cash/gateway/reset
GET  /api/automatic-cash/gateway/state
```

File backend:

```text
cassa-frontend/backend/modules/automatic-cash/automatic-cash.routes.js
cassa-frontend/backend/modules/automatic-cash/automatic-cash.handlers.js
cassa-frontend/backend/modules/automatic-cash/automatic-cash.gateway.js
```

## Contratto Atteso Dal Gateway Reale

Il backend Cassa V4 esegue login sul gateway con:

```http
POST /api/login
Content-Type: application/json

{
  "username": "...",
  "password": "..."
}
```

La risposta deve contenere un token:

```json
{
  "ok": true,
  "token": "SESSION_TOKEN"
}
```

Sono accettati anche `sessionToken` o `session_token`.

Le chiamate successive passano il token in header:

```http
X-Session-Token: SESSION_TOKEN
```

## Endpoint Da Implementare Nel Gateway

Implementare almeno questi endpoint preferiti.

### Riavvio Macchina

Endpoint preferito:

```http
POST /api/machine/restart
```

Body inviato da Cassa V4:

```json
{
  "reason": "restart_from_payments_page",
  "requestedBy": "Nome Operatore",
  "source": "cassa-v4"
}
```

Risposta attesa:

```json
{
  "ok": true,
  "command": "restart",
  "accepted": true,
  "message": "Riavvio macchina accettato"
}
```

Alias che Cassa V4 prova automaticamente se il precedente torna `404`:

```text
/api/machine/reboot
/api/system/restart
/api/restart
```

### Reset Macchina

Endpoint preferito:

```http
POST /api/machine/reset
```

Body inviato da Cassa V4:

```json
{
  "reason": "reset_from_payments_page",
  "requestedBy": "Nome Operatore",
  "source": "cassa-v4"
}
```

Risposta attesa:

```json
{
  "ok": true,
  "command": "reset",
  "accepted": true,
  "message": "Reset macchina accettato"
}
```

Alias che Cassa V4 prova automaticamente se il precedente torna `404`:

```text
/api/system/reset
/api/reset
```

## Regole Operative Gateway

Il gateway deve:

1. Richiedere token valido.
2. Rispondere JSON, non HTML.
3. Usare `2xx` solo se il comando e' stato accettato.
4. Usare `409` se la macchina e' occupata o c'e' operazione contanti in corso.
5. Usare `503` se la macchina non e' pronta o il servizio hardware non risponde.
6. Non eseguire reset/riavvio se e' attivo un deposito, un cambio, un pagamento
   o un prelievo reale.
7. Scrivere log gateway con:
   - comando;
   - operatore `requestedBy`;
   - `reason`;
   - timestamp;
   - esito;
   - eventuale errore hardware.

Esempio errore occupato:

```json
{
  "ok": false,
  "code": "MACHINE_BUSY",
  "message": "Operazione contanti in corso"
}
```

Esempio errore servizio:

```json
{
  "ok": false,
  "code": "MACHINE_UNAVAILABLE",
  "message": "Servizio macchina non disponibile"
}
```

## Regole Lato App Cassa V4

Da verificare, non rompere:

1. I pulsanti devono essere sotto `Funzioni cassa automatica`.
2. `RIAVVIA CASSA` e `RESET CASSA` devono avere colori diversi.
3. Entrambi devono aprire una modale di conferma prima della chiamata.
4. Nessun comando deve partire senza conferma.
5. I pulsanti devono essere disabilitati se:
   - gateway non configurato;
   - gateway non raggiungibile;
   - operazione cassa automatica in corso;
   - un comando e' gia' in corso.
6. Dopo successo mostrare messaggio:
   - `Comando riavvio inviato alla cassa automatica.`
   - `Comando reset inviato alla cassa automatica.`
7. Dopo errore mostrare messaggio user-friendly, non stack trace.

## Configurazione Ambiente Cassa V4

Il backend Cassa V4 usa queste variabili:

```bash
AUTOMATIC_CASH_GATEWAY_ENABLED=1
AUTOMATIC_CASH_GATEWAY_BASE_URL=http://192.168.1.200:9090
AUTOMATIC_CASH_GATEWAY_USERNAME=...
AUTOMATIC_CASH_GATEWAY_PASSWORD=...
AUTOMATIC_CASH_GATEWAY_TIMEOUT_MS=120000
```

Nota operativa:

- la cassa automatica e' sul gateway `192.168.1.200:9090`;
- la cassa fiscale e' un servizio diverso e non va confusa con il gateway
  cassa automatica.

## Test Manuale Rapido

Da macchina dove gira il backend Cassa V4:

```bash
curl -i http://192.168.1.200:9090/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"...","password":"..."}'
```

Prendere il token e provare:

```bash
curl -i http://192.168.1.200:9090/api/machine/restart \
  -H 'Content-Type: application/json' \
  -H 'X-Session-Token: TOKEN' \
  -d '{"reason":"manual_test","requestedBy":"Codex","source":"cassa-v4"}'
```

```bash
curl -i http://192.168.1.200:9090/api/machine/reset \
  -H 'Content-Type: application/json' \
  -H 'X-Session-Token: TOKEN' \
  -d '{"reason":"manual_test","requestedBy":"Codex","source":"cassa-v4"}'
```

## Test Da Fare Nell'App

1. Aprire mobile.
2. Login.
3. Pagamenti.
4. Funzioni cassa automatica.
5. Premere `RIAVVIA CASSA`.
6. Verificare modale di conferma.
7. Premere annulla: nessuna chiamata al gateway.
8. Ripetere e confermare: chiamata inviata e messaggio successo/errore.
9. Ripetere con `RESET CASSA`.
10. Simulare gateway occupato: app deve mostrare errore occupato.
11. Simulare gateway offline: app deve mostrare gateway non raggiungibile.

## File Da Controllare Se Non Funziona

Backend Cassa V4:

```text
cassa-frontend/backend/modules/automatic-cash/automatic-cash.gateway.js
cassa-frontend/backend/modules/automatic-cash/automatic-cash.handlers.js
cassa-frontend/backend/modules/automatic-cash/automatic-cash.routes.js
```

Frontend mobile:

```text
mobile-frontend/src/api/automaticCash.ts
mobile-frontend/src/pages/PaymentsPage.tsx
mobile-frontend/src/styles/glass.css
```

## Criterio Di Chiusura

Il lavoro e' chiuso solo quando:

- il gateway risponde a reset e riavvio con token valido;
- l'app mostra sempre la modale prima del comando;
- annulla non invia chiamate;
- conferma invia una sola chiamata;
- gateway occupato produce `409`;
- gateway non raggiungibile produce errore leggibile;
- non viene mai chiamato il servizio fiscale `:8765` per reset/riavvio cassa
  automatica.
