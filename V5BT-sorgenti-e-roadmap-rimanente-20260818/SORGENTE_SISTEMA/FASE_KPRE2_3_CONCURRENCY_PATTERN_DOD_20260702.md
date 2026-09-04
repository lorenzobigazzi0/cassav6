# FASE K-PRE.2.3 - Concurrency pattern DoD

Data: 2026-07-02

## Obiettivo

Rendere il test di concorrenza reale con `concurrency-harness.mjs` un passo standard e non opzionale per ogni sotto-fase K4-K7.

## Modifica eseguita

File aggiornato:

- `/home/sentrapa/Downloads/ROADMAP_REALTIME_CASSAV4_v4.md`

In ogni blocco DoD di K4, K5, K6 e K7 e' stata aggiunta la voce esplicita:

> Test di concorrenza reale con `concurrency-harness.mjs` come voce dedicata del DoD, non implicita nei test attesi.

## Verifica

Controllo documentale eseguito con:

```bash
rg -n "concurrency-harness\\.mjs|### K[4-7]|\\*\\*DoD" /home/sentrapa/Downloads/ROADMAP_REALTIME_CASSAV4_v4.md
```

Risultato:

- K4: voce DoD presente.
- K5: voce DoD presente.
- K6: voce DoD presente.
- K7: voce DoD presente.

## Esito

K-PRE.2.3 completata.

STOP/REVIEW: K-PRE.2 chiusa. Il prossimo step della roadmap e' K-PRE.3.
