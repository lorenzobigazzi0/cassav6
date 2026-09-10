# Residuo condiviso di `backend/server.js`

Data decisione: 2026-09-10  
Fase: P2b / MIG-034

## Decisione dimensionale

La dimensione corrente del composition root e accettata esplicitamente dal
responsabile del prodotto. I limiti storici di 25.000 righe (MIG-031) e 10.000
righe (MIG-034) non sono piu gate bloccanti. La misura architetturale del
2026-09-10 riporta 31.666 righe; la differenza rispetto ai conteggi testuali
dipende dal criterio del gate, che resta la misura canonica.

Questa eccezione riguarda soltanto la dimensione. Non deroga ai confini di
responsabilita, ai test, al gate repository o al requisito di zero accessi
diretti `readDb`/`writeDb` negli handler di dominio.

## Responsabilita residue

`backend/server.js` resta il composition root condiviso e possiede:

- bootstrap del processo, configurazione e lifecycle delle dipendenze;
- registrazione middleware, routing e dispatch HTTP;
- composizione dei reader, writer, repository e servizi di dominio;
- coordinamento realtime, lane e componenti infrastrutturali condivisi;
- helper legacy trasversali ancora necessari a piu domini;
- adattamento e wiring dei workflow fiscali, outbox e command inbox.

Le regole di business delle route non devono rientrare nel composition root.
Ogni nuova estrazione resta ammessa quando riduce un rischio concreto, ma non e
piu prerequisito per avviare P3.

## Evidenze del gate P2b

- 199 route censite, 194 handler key e 13 domini;
- zero route non risolte dall'inventario;
- zero violazioni del confine SQL/repository su 396 file runtime;
- tutti i 13 domini a zero accessi diretti `readDb` e `writeDb` negli handler;
- gate architetturale senza finding bloccanti;
- warning sui grandi helper residui registrati e non occultati.

Comandi di verifica:

```text
npm run migration:pg:p2b-routes
npm run test:migration:pg:p2b-routes
npm run audit:architecture-security
```

## Regole per le fasi successive

1. I moduli di dominio sono il punto di sostituzione dell'app-state con
   PostgreSQL.
2. Il composition root inietta le dipendenze; non diventa una seconda source of
   truth.
3. Le migrazioni P3+ devono usare repository PostgreSQL con transazioni e
   fallback/cutover espliciti, senza introdurre dual-write permanente.
4. I warning dimensionali restano osservabili, ma non cambiano da soli lo stato
   di una fase.

