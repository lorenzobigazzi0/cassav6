# V5BT shared discovery core v1

Questa directory contiene il solo core deterministico e indipendente dal
trasporto della discovery B2. Non avvia Bluetooth, non accede a BlueZ o Android
e non modifica servizi V4/V5BT.

## Peer directory

`peer-directory-v1.mjs` riceve i 10 byte di Service Data attraverso
`observeServiceData({ payload, rssiDbm })`. Il payload viene sempre decodificato
con `shared/protocol/advertisement-v1.mjs`; non devono essere passati i 31 byte
dell'intero AdvData.

La chiave dello stream e esclusivamente:

```text
rotatingAlias + bootId
```

L'advertisement non stabilisce mai NodeId, identita stabile, autenticazione o
autorizzazione. Stream con alias o boot diversi convivono fino alla normale
scadenza soft-state.

Regole:

- RSSI minimo accettato: `-88 dBm`;
- `age < 5000 ms`: `fresh`;
- `5000 <= age <= 15000 ms`: `aging`;
- `age > 15000 ms`: `expired`;
- duplicato semanticamente identico: rinnova `lastSeen` e RSSI;
- stessa sequenza con semantica diversa: conflitto, senza rinnovo;
- sequenza `newer`: sostituzione dello stato semantico;
- sequenza `older` o `ambiguous`: scarto senza rinnovo;
- massimo `1024` stream; gli stream scaduti vengono rimossi prima di valutare
  la capacita;
- pruning automatico al massimo una volta ogni `1000 ms`, oltre al controllo
  O(1) dello stream osservato;
- massimo `2048` tentativi di nuovi stream anonimi ogni `10000 ms`, inclusi
  quelli rifiutati;
- a capacita piena, sostituzione solo dello stream meno recente quando e
  gia `aging` oppure il nuovo segnale e almeno `6 dB` piu forte.

Il clock e iniettato e deve essere monotono. Le metriche distinguono ogni esito,
le rimozioni per scadenza, le regressioni del clock e pressione, limite,
high-watermark e utilizzo della capacita. Questi limiti contengono consumo di
CPU e churn prima dell'autenticazione. La directory mantiene l'ordine LRU
spostando uno stream solo dopo un refresh accettato, quindi scadenza e candidato
sotto pressione non richiedono una scansione completa per pacchetto. Un
advertisement B2 resta anonimo e non puo eliminare da solo il rischio di
interferenza o saturazione radio locale.

## Scan-window policy

`scan-window-policy-v1.mjs` produce decisioni pure per uno scheduler esterno:

| Modalita | Finestra | Periodo | Duty cycle |
| --- | ---: | ---: | ---: |
| stable | 3000 ms | 30000 ms | 10% |
| failover | 8000 ms | 10000 ms | 80% |

Ogni finestra deve essere strettamente piu corta del periodo, quindi lo scan
continuo e rifiutato. Un cambio a `failover` apre subito una nuova finestra. Il
clock e iniettato; `evaluate()` restituisce stato, comando
`start`/`stop`/`restart`, prossima transizione e attesa fino alla prossima
finestra. `restart` e il recupero fail-safe quando una callback ritardata salta
un confine di stop: l'adapter deve eseguire stop seguito da start.

## Esecuzione offline

```text
node --test shared/discovery/peer-directory-v1.test.mjs
node --test shared/discovery/scan-window-policy-v1.test.mjs
node scripts/simulate-discovery-soft-state.mjs --root .
```

Le feature Bluetooth restano disabilitate. Il simulatore e prova locale
deterministica, non sostituisce il gate p95 su dispositivi fisici.
