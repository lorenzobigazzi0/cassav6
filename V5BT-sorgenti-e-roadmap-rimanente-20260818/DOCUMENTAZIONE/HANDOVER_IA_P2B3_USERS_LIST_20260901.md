# Handover IA — P2b.3 `users.list`

Data: 2026-09-01  
Root di lavoro: `D:\sistemacassav6\V5BT-sorgenti-e-roadmap-rimanente-20260818`

## Da dove ripartire

MIG-006 è già applicata e verificata sul Raspberry DEV `192.168.0.67`: non ripeterla. `audit.events` è partizionata e vuota; Cassa e PostgreSQL erano attivi con health HTTP 200 su 5380/5381. MIG-026 resta `IN_PROGRESS` soltanto per RET-01.

Il prossimo passo è esclusivamente **P2b.3, primo reader `users.list`**. Non iniziare P3 e non migrare ancora identity a PostgreSQL.

## Primo slice

Intervenire su `backend/users/users.handlers.js`, funzione `handlePosSettingsUsers` (route `users.list`), eliminando il suo accesso diretto a `readDb()` tramite un reader identity circoscritto e iniettato dal composition root.

Il reader deve esporre un read model esplicito con i soli dati necessari a:

- validare sessione e utente senza indebolire autorizzazioni;
- produrre la vista completa per `manage_users`;
- produrre la vista personale `readOnly` per gli altri utenti;
- mantenere invariati `permissions`, `lastWriteAt` e `version`.

Non modificare `handleSavePosSettingsUsers`, writer, schema DB o contratti HTTP. Conservare esattamente status, forma delle risposte e sanitizzazione attuali.

## File da leggere, in ordine

1. `DOCUMENTAZIONE/P2B_IDENTITY_PILOT_20260901.md`
2. `SORGENTE_SISTEMA/cassa-frontend/backend/users/users.handlers.js`
3. `SORGENTE_SISTEMA/cassa-frontend/backend/users/users.service.js`
4. `SORGENTE_SISTEMA/cassa-frontend/backend/server.js` — wiring `createUsersHandlers`
5. `SORGENTE_SISTEMA/cassa-frontend/backend/db/app-state/app-state.repository.js`
6. `SORGENTE_SISTEMA/cassa-frontend/backend/modules/scoped-reads/` e `backend/db/relational/users.repo.js` — riusare i pattern esistenti senza forzare un nuovo layer
7. `SORGENTE_SISTEMA/cassa-frontend/backend/tests/user-app-users-handler.test.mjs`
8. `SORGENTE_SISTEMA/cassa-frontend/scripts/postgresql-migration/p2b-identity-boundaries.mjs`
9. `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/p2b/identity-route-boundaries.csv`
10. `DOCUMENTAZIONE/MIGRATION_STATUS.md`

Evidenza MIG-006 di riferimento: `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig026/raspberry-dev-sd-partitioned-20260901.json`.

## Criteri di accettazione

- `users.list` non chiama più direttamente `readDb()`; `users.save` resta invariato.
- Il handler resta sottile e riceve un reader tramite dependency injection.
- I casi manager, non-manager, sessione non valida e sanitizzazione sono coperti.
- Nessuna nuova dipendenza e nessuna nuova failure rispetto alla baseline congelata.
- Non dichiarare completata P2b.3 finché il gate identity non registra il nuovo confine; non dichiarare iniziata P3.

Comandi minimi dalla directory `SORGENTE_SISTEMA/cassa-frontend`:

```powershell
node --test --test-concurrency=1 backend/tests/user-app-users-handler.test.mjs
npm run test:migration:pg:p2b-identity
npm run migration:pg:p2b-identity
npm run test:migration:pg:p2b-baseline
npm run gate:migration:pg:p2b-baseline
```

Il workspace non è gestito con Git: preservare le evidenze esistenti e creare checkpoint/ZIP soltanto dopo avere concluso e verificato il slice.
