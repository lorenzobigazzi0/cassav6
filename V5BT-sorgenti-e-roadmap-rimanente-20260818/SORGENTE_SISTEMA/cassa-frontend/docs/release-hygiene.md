# Release hygiene

## Comandi

Gate bloccante:

```bash
npm run hygiene:release
```

Modalità warning:

```bash
npm run hygiene:release:warn
```

## Cosa controlla

- `.print-spool` non vuota;
- `logs` non vuote;
- `app-state.before-*.json`;
- database runtime SQLite/DB;
- APK debug;
- `.env` reale;
- possibili credenziali hardcoded;
- file runtime/temporanei.

## Policy

In ambiente di sviluppo lo script può girare in `--warn-only`. In packaging/release deve girare come gate bloccante.
