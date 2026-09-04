# ADR-0001 - Modular Monolith Come Architettura v4.1.x

Data: 2026-06-30

Stato: accettata

Revisione successiva:

- `ADR-0002-modular-monolith-revision-20260703.md` registra la verifica dopo
  le fasi K/L/M/N di `ROADMAP_REALTIME_CASSAV4_v4.md`.
- La decisione di restare modular monolith rimane valida; alcuni criteri sono
  migliorati, ma il criterio `server.js` sotto 15.000 righe non e' ancora
  soddisfatto.

## Contesto

Sistema Cassa v4 contiene molti domini operativi strettamente collegati:

- ordini, tavoli, spostamenti, unioni e divisioni;
- pagamenti, fiscalita', POS e scarichi;
- cassa automatica, fondi cassa e cambi;
- stampa comande/preconti/report;
- radio, notifiche realtime e batteria palmari;
- impostazioni globali e preferenze utente/device;
- frontend mobile, cassa, postazione, impostazioni e app Android WebView.

La baseline Fase 0 ha misurato:

- `backend/server.js`: 38.359 righe;
- route registrate: 173;
- moduli backend: 27;
- test backend: 100;
- debiti principali: monolite ancora ampio, route critiche ancora nel registry
  root, assenza di `event_outbox`, assenza di `idempotency_keys`, IP operativi
  residui nel sorgente.

Il sistema e' gia' in forte uso operativo e integra dispositivi fisici o
simulati. Una separazione prematura in microservizi aumenterebbe il rischio di
latenza, inconsistenza e difficolta' di debug proprio nei flussi piu' delicati.

## Decisione

Per v4.1.x il sistema resta un **modular monolith**.

Il backend deve essere progressivamente separato in moduli interni con confini
forti, senza introdurre servizi di rete separati finche' i domini non saranno
stabilizzati.

I confini target sono:

```text
backend/
  core/
  db/
  modules/
    orders/
    payments/
    fiscal-pos/
    automatic-cash/
    print-spool/
    radio/
    notifications/
    stations/
    settings/
  adapters/
    fiscal/
    automatic-cash/
    printer/
    pos/
  realtime/
  observability/
```

Ogni dominio critico deve avere:

- state machine esplicita quando gestisce transizioni operative;
- repository o accesso dati dedicato;
- service per orchestrare DB, audit, gateway e stampa;
- handler HTTP sottili;
- route con policy e `mutation` dichiarate;
- test mirati e gate release.

## Conseguenze

Effetti positivi:

- riduzione progressiva del rischio senza riscrittura totale;
- test piu' mirati per pagamenti, fiscale, cassa automatica e ordini;
- possibilita' di introdurre `event_outbox` e idempotenza centralizzata;
- packaging piu' pulito e ripetibile;
- futura estrazione a servizio possibile solo per domini maturi.

Costi:

- il monolite rimane presente per alcune fasi;
- serve disciplina per non aggiungere nuove feature direttamente in
  `server.js`;
- i moduli devono ricevere dipendenze tramite context, evitando import ciclici;
- i test di integrazione restano importanti per verificare i flussi cross-domain.

## Regole operative

1. Non creare nuovi servizi separati per v4.1.x senza nuova ADR.
2. Non aggiungere nuove route critiche direttamente nel registry root se esiste
   gia' un modulo coerente.
3. Estrarre prima funzioni pure, poi repository/service, infine handler e route.
4. Nessun modulo importa `backend/server.js`.
5. Ogni mutazione critica deve dichiarare strategia di idempotenza o motivo di
   esclusione.
6. I gateway esterni devono passare da adapter reale e simulatore.
7. Le configurazioni operative devono stare in DB/config, non in costanti sparse.
8. Ogni release deve passare baseline/gate architetturali e packaging clean.

## Criteri Di Revisione

Questa decisione va rivista quando saranno veri almeno questi punti:

- `server.js` sotto 15.000 righe;
- `event_outbox` e `idempotency_keys` in produzione;
- state machine pagamenti/fiscale/ordini/cassa automatica consolidate;
- simulatori ufficiali per fiscal, cassa automatica, POS e stampanti;
- test endurance ripetibile con 100 device e 50 postazioni;
- nessun IP operativo hardcoded nel sorgente;
- backlog P0/P1 di concorrenza e pagamenti stabilizzato.

Solo allora sara' sensato valutare l'estrazione di singoli servizi, per esempio
stampa/fiscalita' o realtime radio/notifiche.

## Verifica 2026-07-03

La verifica di Fase O ha prodotto `ADR-0002`. Stato sintetico:

- `server.js`: 38.773 righe, sotto budget corrente 39.500 ma non sotto 15.000;
- `event_outbox` e `idempotency_keys`: introdotti dalla migrazione 010 e
  coperti da repository/test;
- state machine consolidate per pagamenti, ordini e stampa;
- cassa automatica, radio/postazione e simulatori completi restano criteri non
  chiusi;
- endurance finale 100 device/50 postazioni resta da eseguire in Fase P.
