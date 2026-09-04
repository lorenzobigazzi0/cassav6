# Phase 1 Gate Results v4.1.0

Data: 2026-06-30

## Artefatti Creati

- `docs/architecture/ADR-0001-modular-monolith.md`
- `docs/architecture/PHASE1_RELEASE_GUARDRAILS_v4.1.0.md`
- `docs/architecture/PHASE1_GATE_RESULTS_v4.1.0.md`
- `cassa-frontend/scripts/release-package.mjs`
- script npm:
  - `release:package`
  - `release:package:dry-run`

## Validazioni Sorgente

Runtime usata:

```text
/home/sentrapa/Desktop/sistemacassav4/.runtime/node-v22.23.1-linux-x64/bin
```

Comandi:

```bash
node --check cassa-frontend/scripts/release-package.mjs
node -e "JSON.parse(require('fs').readFileSync('cassa-frontend/package.json','utf8'))"
npm run release:package:dry-run
```

Risultato:

- OK.
- `release-package.mjs` valido.
- `package.json` valido.
- dry-run packaging OK.

## Pacchetto Generato

Comando:

```bash
npm run release:package -- --version v4.1.0 --clean
```

Output:

```text
/home/sentrapa/Desktop/sistemacassav4/release-packages/v4.1.0/
```

Contenuto:

```text
sistema-cassa-v4.1.0-source/
sistema-cassa-v4.1.0-source.zip
sistema-cassa-v4.1.0-source.zip.sha256
```

Dimensioni:

- cartella sorgente pulita: 39M;
- zip: 24M;
- file nel pacchetto: 1137.

SHA256:

```text
defcf11eed89f9158d3ffdf681847b09ed4771364d427b439919c8620a81cfcf
```

## Verifiche Pacchetto

Comandi:

```bash
unzip -t /home/sentrapa/Desktop/sistemacassav4/release-packages/v4.1.0/sistema-cassa-v4.1.0-source.zip
sha256sum -c /home/sentrapa/Desktop/sistemacassav4/release-packages/v4.1.0/sistema-cassa-v4.1.0-source.zip.sha256
node cassa-frontend/scripts/release-package.mjs --verify /home/sentrapa/Desktop/sistemacassav4/release-packages/v4.1.0/sistema-cassa-v4.1.0-source
```

Risultato:

- `unzip -t`: OK, nessun errore nei dati compressi.
- `sha256sum -c`: OK.
- `--verify`: OK, `findings: []`.
- controllo aggiuntivo su DB/log/cert/key/snapshot runtime: nessun file trovato.

## Stato Step 1

Step 1 completato.

La release v4.1.0 ora ha:

- decisione architetturale iniziale formalizzata;
- packaging source ripetibile;
- guardrail per non includere runtime o segreti;
- zip e checksum verificati.
