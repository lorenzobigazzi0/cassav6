# Backend modules

I moduli backend estraggono handler e route dal monolite senza importare `server.js`.

## Struttura consigliata

- `modules/<domain>/index.js` esporta factory handler e route.
- `modules/<domain>/<domain>.routes.js` esporta `build<Domain>Routes()`.
- `modules/<domain>/<domain>.handlers.js` esporta `create<Domain>Handlers(context)`.

## Route

Le route modulari devono mantenere invariati `method`, `path`, `handlerKey`, policy auth/permission e `mutation`.
`backend/routes/index.js` compone le route dei moduli con le route ancora monolitiche.

## Handler

Gli handler modulari ricevono le dipendenze dal `context`:

```js
const handlers = createExampleHandlers({
  readDb,
  writeDb,
  sendJson,
  readJsonBody,
});
```

Restituiscono una mappa `{ handlerKey: handler }` da comporre in `server.js`.

## Domain/utils

Un modulo puo esporre un file `modules/<domain>/<domain>.domain.js` o `.utils.js` per helper puri e condivisibili. Questi file non devono fare I/O, non devono importare `server.js` e non devono contenere handler o side effect operativi.

Esempi attuali:

- `modules/price-lists/price-lists.domain.js` contiene la normalizzazione e risoluzione dei listini temporizzati menu.
- `modules/menu/menu.domain.js` contiene normalizzazione/sanitizzazione degli item menu e riceve policy runtime tramite factory.

Il monolite usa questi domini tramite factory, mentre i test core verificano i domini senza avviare il backend.

## Evitare cicli

Un modulo non deve importare `server.js`. Helper condivisi ancora nel monolite vanno passati via context finche non vengono spostati in librerie dedicate.

## Shim temporanei

Se un dominio esisteva gia fuori dal monolite, si puo normalizzare sotto `backend/modules/<domain>/` lasciando un piccolo re-export nel vecchio percorso. Lo shim deve contenere solo export e va rimosso quando tutti gli import esterni sono stati aggiornati.

## Domini misti read/write

Un modulo puo contenere sia letture sia mutazioni leggere dello stesso dominio, per esempio audit list e audit delete. In questo caso ogni route deve dichiarare esplicitamente `mutation` e la permission richiesta nel file routes.

## Handler mutativi con side effect

Gli handler mutativi possono essere spostati in un modulo solo preservando ordine logico, `readDb`/`writeDb`, audit e response shape. Dipendenze operative ancora condivise, come lifecycle o audit builder, vanno passate via context senza importare `server.js`.

## Automatic cash gateway

Il modulo `automatic-cash` mantiene dominio e I/O separati:

- `automatic-cash.domain.js` contiene validazione configurazioni, riserva minima, preflight e macchina a stati.
- `automatic-cash.gateway.js` contiene solo l'adapter HTTP verso RealSngGateway.
- `automatic-cash.handlers.js` orchestra DB, sessione e chiamate gateway.

Per abilitare il gateway reale impostare l'ambiente backend:

```powershell
$env:AUTOMATIC_CASH_GATEWAY_ENABLED='1'
$env:AUTOMATIC_CASH_GATEWAY_BASE_URL='http://127.0.0.1:PORTA_REAL_GATEWAY'
$env:AUTOMATIC_CASH_GATEWAY_USERNAME='...'
$env:AUTOMATIC_CASH_GATEWAY_PASSWORD='...'
$env:AUTOMATIC_CASH_GATEWAY_TIMEOUT_MS='120000'
```

Se `AUTOMATIC_CASH_GATEWAY_ENABLED` non vale `1`, il modulo resta in modalita compatibile con inventario salvato nelle impostazioni. Il backend non deve salvare credenziali reali nel repository.

## Endpoint read/status su POST

Alcuni endpoint storici usano `POST` per letture o stato leggero. Se non hanno side effect, il modulo deve mantenere il metodo originale ma dichiarare esplicitamente `mutation: false` nella route.

Se una lettura storica su `POST` conserva side effect gia esistenti, come prune, creazione stato o `writeDb`, il modulo deve mantenere `mutation: true` e preservare integralmente quei side effect.
