# Phase -1/0 report template

## Sintesi

- Profilo testato:
- Commit/build:
- Data:
- Ambiente:

## Flag runtime

Allegare output di:

```bash
npm run profile:runtime
```

## Hygiene

Allegare output di:

```bash
npm run hygiene:release:warn
```

## Baseline

Allegare:

- `reports/baseline-summary.json`
- `reports/baseline-summary.md`

## Route calde

| Route | p50 | p95 | p99 | readDb p95 | writeDb p95 | note |
|---|---:|---:|---:|---:|---:|---|

## Fallback pesanti rilevati

- full-state fallback:
- global queue hot path:
- legacy print worker:
- wide refetch frontend:

## STOP/REVIEW

Passare alla fase successiva solo se:

- i profili sono chiari;
- il pacchetto release è pulibile;
- il baseline log viene generato;
- il parser produce report;
- non sono state cambiate semantiche business.
