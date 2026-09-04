# Preflight Fisico Complessivo V5BT

Data: 2026-08-10, Europe/Rome.

## Esito

Il passo successivo della roadmap e stato eseguito fino al limite consentito
dall'hardware disponibile. L'inventario unico read-only termina `INCOMPLETE`:

- due Palmare sono collegati e distinti;
- la copertura ruoli richiede `handheld` e `station` e segnala correttamente
  la Postazione mancante;
- package, versione `1.0.39` code `40`, APK, firma e permessi coincidono con la
  matrice certificata;
- entrambi gli enrollment risultano `READY`;
- le sessioni applicative non sono autenticate e i reporter non hanno
  copertura corrente;
- la Postazione certificata non e collegata;
- Raspberry, BlueZ, NTP, servizi, registry e UPS non sono interrogabili.

Il report esportabile non contiene seriali, indirizzi di rete, identita di
registry o output grezzo. L'evidenza completa resta privata.

## Azioni Eseguite

- Acquisito l'inventario senza comandi mutanti.
- Verificata la conformita dei due Palmare alla matrice corrente.
- Confermato che entrambi sono gia presenti nel ledger B4.
- Lasciati invariati app, dati, account ed enrollment.
- Normalizzati a `0600` tutti i file privati storici della raccolta B4.
- Verificate directory private `0700` e assenza di symlink.
- Allineati stato autorevole, schema, parser, checklist e documentazione alla
  data e alle build correnti.
- Eseguito il dry-run B0: `PENDING_PHYSICAL_CAPTURE`, senza accesso ADB.

Il primo rerun delle `00:15:53Z` ha chiuso senza ADB perche il relativo
eseguibile non era nel `PATH`; e conservato come tentativo fallito. Il rerun
delle `00:16:35Z`, con toolchain esplicita, vede entrambi i Palmare e termina
comunque `INCOMPLETE` per ruolo `station` assente e Raspberry non disponibile.

Verifica offline: stato `10/10`, inventario `16/16`, manifest `7/7`, consistenza
build `11/11` e runner B0 `12/12`; manifest bidirezionale e validatore del
pacchetto `PASS`, con zero errori di isolamento.

## Gate

- B0: `PENDING`; manca la coppia Palmare/Postazione certificata.
- B1: enrollment Palmare `READY`, binding registry da rivalidare col Raspberry.
- B2: `PENDING`; nessuna nuova cattura formale.
- B3: `PENDING`; soak da `3600 s` non avviato.
- B4: `PENDING`, `2/10`; i due dispositivi presenti non sono riacquisibili.
- B5: `PENDING`, pilot e campagna non autorizzati.
- B6: `BLOCKED`.

## Ripresa Ammessa

1. Rendere disponibili Raspberry e Postazione certificata.
2. Ripetere l'inventario read-only e richiedere `COMPLETE`.
3. Avviare i monitor Android e Raspberry prima di ogni prova.
4. Eseguire login controllato e verificare reporter freschi senza reinstall,
   cancellazione dati o nuova enrollment.
5. Completare B0 formale, B1, B2 `100/100` con p95 `<= 8000 ms` e B3 per
   esattamente `3600 s`.
6. Acquisire otto ulteriori hardware fisici distinti per portare B4 a `10/10`.
7. Valutare il pilot B5.7 soltanto dopo il PASS dei prerequisiti.

Le simulazioni e i test locali non aumentano la percentuale ufficiale.

Avanzamento roadmap complessiva: **49%**
