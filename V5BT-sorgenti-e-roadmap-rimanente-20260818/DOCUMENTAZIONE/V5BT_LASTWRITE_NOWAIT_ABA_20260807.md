# V5BT LastWrite NOWAIT A/B/A - 2026-08-07

## Classificazione E Perimetro

Il canary diagnostico implementa il flush ordinario di
`integration.lastWriteAt` con lock `NOWAIT`. La recovery di avvio resta
bloccante sul lock canonico. Le collisioni MySQL `3572/ER_LOCK_NOWAIT` e
MariaDB `1205/ER_LOCK_WAIT_TIMEOUT` sono classificate come contention
deferral: il payload viene reinserito con backoff esponenziale, conservando
il `MAX` tra valore in volo e nuovi enqueue. Il flag operativo resta OFF.

Il gate lastWrite usa lo schema `2`, attesta esplicitamente la modalita lock
del flush e richiede contabilita coerente tra retry, deferral ed errori. I
test con MySQL reale trattengono la riga marker in una transazione separata e
attestano sia il fallimento rapido `NOWAIT`, con rollback, sia la recovery
bloccante che attende il rilascio e persiste il `MAX`.

Nessun hardware e stato usato. La campagna e offline e non modifica B4, B5,
B6 o l'avanzamento ufficiale.

## Correzione Di Monotonicita

Durante l'attestazione MySQL reale e stato scoperto un difetto nel confronto
monotono. Il driver MySQL puo restituire una colonna JSON scalare gia
decodificata, quindi senza le virgolette JSON. Il parser precedente trattava
quel valore come non valido e poteva considerare scrivibile un timestamp
entrante piu vecchio, permettendo la regressione di `lastWriteAt`.

La correzione normalizza il timestamp sia dal valore JSON analizzato sia dal
valore scalare grezzo. Il writer ora respinge la regressione in entrambe le
forme restituite dal driver, conserva `app_state_position` ed esegue sempre
il confronto sotto il lock di riga.

## Verifiche

- test focused: `248/248 PASS`;
- contratti: `103/103 PASS`;
- stress combinato: `10` giri, `50/50 PASS`;
- blocco ambiente: `23/23 PASS`;
- full suite finale: `1918/1918 PASS`;
- gate lastWrite schema `2`: `PASS` sul segmento B;
- attestazione lock: `PASS` per flush `NOWAIT` e recovery bloccante.

Il deadlock di bootstrap e stato riprodotto anche nello stress combinato. Il
trace InnoDB lo ha localizzato sul marker, tra chiave `PRIMARY` e gap degli
indici. La correzione separa l'upsert del marker e applica il mutex marker
soltanto alle entry nuove; gli heartbeat su entry esistenti restano paralleli.

I test MySQL reali coprono marker preesistente con `16` coppie concorrenti,
`25` ID nuovi e contesa sullo stesso ID con conservazione del `MAX`. I test
isolano inoltre `INVOCATION_ID` e `JOURNAL_STREAM`, eliminando contaminazioni
provenienti dall'ambiente di esecuzione.

## Confronto A/B/A

| Segmento | Profilo | Azioni | P95 azioni | P95 comande | Lock wait | Tempo lock | Esito |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| A1 | OFF | 300/300 | 3212 ms | 2247 ms | 115 | 30233 ms | FAIL |
| B | NOWAIT | 300/300 | 3490 ms | 2165 ms | 104 | 15738 ms | FAIL |
| A2 | OFF | 300/300 | 2831 ms | 2521 ms | 112 | 27851 ms | PASS |

A1 fallisce per P95 azioni e registra anche un `GUI_UNEXPECTED_5XX`. B
completa `300/300` con zero errori business, ma fallisce il solo gate P95
azioni. A2 completa `300/300` e chiude `PASS`.

Nel segmento B il gate lastWrite schema `2` attesta `86` enqueue, `60`
coalescenze, `24` batch, `86` flush, `6` retry e `6/6` contention deferral
recuperati, con zero errori e zero residui.

## Delta Rispetto Al Controllo

Il punto medio A1/A2 misura P95 azioni `3021,5 ms`, P95 comande `2384 ms`,
`113,5` lock wait e `29042 ms` di tempo lock. Rispetto a tale controllo, B:

- peggiora il P95 azioni di `468,5 ms`, pari a `+15,51%`;
- migliora il P95 comande di `219 ms`, pari a `-9,19%`;
- riduce il tempo lock del `45,81%`;
- riduce i lock wait di `9,5`, pari a `-8,37%`.

Il fail-fast riduce nettamente il tempo trascorso in lock, ma il P95 azioni
di `3490 ms` resta sopra la soglia assoluta di `3000 ms`.

## Verdetto Operativo

Verdetto: `REJECTED_ACTION_P95`. Il flag operativo resta OFF. Lo smoke da
`1200` operazioni non e autorizzato e non deve essere eseguito. La correzione
del bootstrap e la full suite verde non cambiano questo verdetto
prestazionale.

## Evidenze Sigillate

Bundle aggregato:
`SORGENTE_SISTEMA/logs/v5bt-lastwrite-nowait-aba-20260807`.

- manifest A1:
  `7684907648ca561099d4ab96bda8724658a97e747e4d461ecf046f7f1e85e526`;
- manifest B:
  `148d3c3d33d39117f2517df780d0c7968159661bea217f961a00297242df915d`;
- manifest A2:
  `dc69dd51149db7b4fac9d0bc376ec6ed38ec80032c97bcb95bba20aaa3948b58`;
- manifest aggregato:
  `ed0fe6f771ad4250d6514deb9ccf6a7db385a4ff462de63020bba1b92f579742`.

B4 `2/10`, B5 `PENDING`, B6 `BLOCKED`.

Avanzamento roadmap complessiva: **49%**
