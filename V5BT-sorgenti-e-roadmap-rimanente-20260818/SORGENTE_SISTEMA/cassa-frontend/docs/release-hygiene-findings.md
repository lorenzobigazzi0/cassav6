# Release hygiene findings — prima scansione

Questa scansione non blocca lo sviluppo, ma evidenzia elementi da non includere in una release finale.

Elementi runtime rilevati nel bundle analizzato:

- `./logs/backend-5281.log`
- diversi `backend/app-state.before-*.json`
- `backend/app-state-split.sqlite`
- `backend/backend-relational.sqlite`

Questi file possono essere utili in laboratorio, ma non devono essere parte di un pacchetto release pulito.

## Strumento aggiunto

Eseguire:

```bash
npm run hygiene:release:warn
```

oppure, per gate bloccante:

```bash
npm run hygiene:release
```

Lo script produce anche:

```text
reports/release-hygiene.json
```

## Regola release

Una release installabile deve contenere codice/config esempio, ma non:

- log;
- spool;
- database runtime;
- backup app-state;
- `.env` reali;
- APK debug;
- credenziali hardcoded.
