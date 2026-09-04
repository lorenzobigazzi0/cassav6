# Command inbox pilot endpoints — Step 4

Questa fase collega la fondazione `command_inbox` (Step 3) a due endpoint reali a
**basso rischio**, rendendoli idempotenti contro retry / doppio-tap / reconnect
senza toccare pagamenti, fiscale o `order.create`.

Endpoint pilota:

1. `POST /api/integration/notifications/ack` — `notifications.ack`
2. `POST /api/integration/print` — `print.request` (solo comande/preconti **non fiscali**)

## Come partecipa una richiesta

Una richiesta entra nella command inbox **solo se** porta SIA un request id SIA
una idempotency key. Sorgenti accettate (header prioritari sul body):

```
X-Command-Request-Id: <id univoco della richiesta>
X-Idempotency-Key:    <chiave anti-doppione stabile per device+comando>
```

oppure nel body JSON:

```json
{ "requestId": "...", "idempotencyKey": "..." }
```

Senza questi campi il wrapper **delega direttamente all'handler legacy**: i client
attuali (mobile/postazione) restano invariati. Questo e' il rollback naturale:
finche' un client non viene aggiornato per inviare l'idempotenza, il suo path e'
identico a prima.

Il `payloadHash` (SHA-256 su JSON canonico) e' calcolato **lato backend** su un
sottoinsieme business stabile dell'endpoint:

- `notifications.ack`: `{ id, action, consumer }`
- `print.request`: `{ kind, orderId, copies, target }`

I campi volatili/auth (token, deviceUuid, heartbeat, ecc.) non entrano nell'hash.

## Feature flag

```env
COMMAND_INBOX_ENABLED=0|1
COMMAND_INBOX_MODE=off|shadow|write|enforce|enforce_pilot
COMMAND_INBOX_PILOT_TTL_MS=600000   # TTL record pilota (default 10 min)
```

Comportamento per modalita' (a flag abilitato):

| Modalita' | Comportamento |
|---|---|
| `off` / flag disabilitato | Bypass totale. Il repository non viene nemmeno interrogato. |
| `shadow` | Registra il ciclo `begin→commit/reject/fail` attorno all'handler ma esegue **sempre** l'handler e invia la risposta live. Replay/conflict sono solo **osservati** (metriche). Zero cambi comportamentali. |
| `enforce_pilot` / `enforce` / `write` | Idempotenza piena: `committed`/`rejected`/`failed` → replay del risultato salvato; `conflict` → 409; `processing` → 409. |

Rollback immediato: `COMMAND_INBOX_ENABLED=0` (o `COMMAND_INBOX_MODE=off`).

## Semantica delle risposte (in enforce)

| Stato `begin()` | Risposta |
|---|---|
| `created` | Esegue l'handler; se 2xx → memoizza e invia la risposta reale; se lancia → memoizza `rejected` (4xx) / `failed` (5xx) e rilancia (il dispatch formatta la risposta live, identica al memo). |
| `committed` / `rejected` / `failed` | Replay byte-per-byte del risultato salvato (`{ status, json }`). L'handler **non** viene rieseguito. |
| `conflict` | `409 { ok:false, code:"COMMAND_PAYLOAD_CONFLICT" }`. Stessa idempotency key con payload business diverso. |
| `processing` | `409 { ok:false, code:"COMMAND_IN_PROGRESS" }` + header `Retry-After: 1`. Duplicato mentre il primo comando e' ancora in corso. |

## Metriche

Contatori runtime (sezione `commandInbox` dello snapshot
`GET /api/monitor/runtime-metrics`):

`attempts`, `created`, `replays`, `replayRate`, `conflicts`, `inProgress`,
`committed`, `rejected`, `failed`. Per-endpoint viene inoltre registrato il tempo
di risposta via `recordOperation("commandInbox", "<commandType>", ms)`.

Analisi snapshot:

```bash
npm run command:inbox:analyze
```

## Limiti noti del pilota

- Gli endpoint scelti sono **owner-only** nella topologia multiprocesso (non fanno
  parte delle 13 route ordini instradate sui worker): la command inbox vive quindi
  sulla singola connessione relazionale dell'owner, senza contesa cross-processo.
  Estendere il pilota a route servite dai worker richiede una command inbox
  condivisa (relazionale su file condiviso o su MySQL) — fuori scope Step 4.
- La command inbox richiede il DB relazionale attivo (`BACKEND_RELATIONAL_ENABLED=1`,
  mode `shadow`/`primary`); se assente, il wrapper degrada a bypass legacy.
- Print: solo `kind` `order` e `preconto` transitano dal wrapper. Gli scontrini
  fiscali non passano da questo handler e restano intatti.

## Test

```bash
npm run test:phase4        # unit del wrapper contro repository reale (9 casi)
node --test backend/tests/command-inbox-pilots.e2e.test.mjs   # boot live isolato
npm run test:phase2        # foundation command inbox (4 casi)
npm run check:backend
```
