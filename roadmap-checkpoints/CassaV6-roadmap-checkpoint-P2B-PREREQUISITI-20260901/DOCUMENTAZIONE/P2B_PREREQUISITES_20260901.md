# Prerequisiti P2b verificabili

Data: 2026-09-01

## Golden dataset MIG-002

MIG-002 e stata riaperta perche la fixture precedente non rendeva falsificabili
i gate di identity, pricing e allergeni. La fixture schema v2 ora contiene:

- 189 articoli, inclusi articoli con allergeni e ingredienti distinti;
- 2 listini legacy con ereditarieta `base -> evening -> night`;
- 2 schedule sovrapposte, inclusa la finestra overnight lunedi 22:00-02:00;
- 5 casi prezzo con prima/durante/sovrapposizione/overnight/weekday miss;
- 2 utenti, 1 gruppo e sessioni attiva, revocata e scaduta;
- 1 ordine da 3 righe, variante, quantita 2 e sconto;
- split payment con 2 parti, 2 transazioni, 2 righe e due metodi;
- benefit da 500 centesimi riscattato per 300 con residuo 200;
- 1 prenotazione.

Il validatore compila il Commerciale V2 ed esegue tutti i casi prezzo contro
aspettative dichiarate. I test di regressione rimuovono singolarmente listini,
overnight, sessioni, allergeni e righe pagamento e verificano che la fixture
diventi invalida.

SHA-256 fixture: `ac184311c9c96bb8b2d02ff23f71f284afaebfca94437e6435fd501b24edfa01`.

MIG-002 resta `IN_PROGRESS` finche importer e gate di equivalenza non consumano
esplicitamente la fixture v2; non viene piu considerata chiusa dal solo fatto
che il JSON esista.

## audit.events e retention

La migration applicativa `006_audit_events_partitioned_retention`:

- rifiuta con SQLSTATE `55000` una tabella non vuota;
- ricrea `audit.events` partizionata per mese su `occurred_at`;
- precrea le partizioni e mantiene una partizione default;
- conserva l'unicita globale di `id` in `audit.event_ids`, append-only anche
  dopo il drop futuro di una partizione dati;
- lascia RET-01 e ogni cancellazione disabilitate;
- limita la manutenzione partizioni al proprietario DDL.

I test locali relativi a audit, retention, foundation e runner sono 28/28.
L'applicazione Raspberry resta sospesa finche `192.168.0.67` non torna
raggiungibile; il preflight remoto deve confermare zero righe prima della 006.

## Baseline P2b

La baseline non viene dichiarata verde. E congelata come insieme esatto:

- Cassa: 92 test, 72 verdi, 20 rossi noti;
- Mobile: 642 test, 639 verdi, 3 rossi noti.

Ogni rosso ha file, nome completo e motivazione in
`scripts/postgresql-migration/p2b-baseline-allowlist.json`. Il gate
`gate:migration:pg:p2b-baseline` fallisce per:

- un nuovo rosso;
- un rosso noto mancante senza aggiornamento dell'allowlist;
- duplicati;
- deriva dei conteggi totali/verdi/rossi.

Evidenza:
`SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/p2b/baseline-known-failures-20260901.json`.

## Pilot identity avviato

L'inventario e ora eseguibile e verificato: 7 route, 1.141 righe handler, 7
`readDb()` e 11 `writeDb()` diretti, con dipendenze cross-domain dichiarate per
ogni route. Le route erano gia estratte da `server.js`; P2b.2 e quindi gia
soddisfatta per questo solo slice.

Il dettaglio e in `DOCUMENTAZIONE/P2B_IDENTITY_PILOT_20260901.md`. P3 resta
bloccata: il passo successivo e introdurre reader/writer scoped nell'ordine
misurato dal pilot, iniziando dalla route read-only `users.list`.
