# FASE K-PRE.4.3 - Fiscal boundary DoD K4-K7

Data: 2026-07-02

## Obiettivo

Collegare in modo esplicito il test di confine fiscale agli step K4-K7 della roadmap realtime, cosi' ogni futura modifica ai path di publish dei pagamenti fiscali deve rieseguire il controllo contro l'ottimismo realtime.

## File aggiornato

- `/home/sentrapa/Downloads/ROADMAP_REALTIME_CASSAV4_v4.md`

## Modifica inserita

In ciascuno degli step K4, K5, K6 e K7 e' stata aggiunta la voce DoD:

```text
Test di confine fiscale con `fiscal-optimism-boundary.e2e.test.mjs` come voce dedicata del DoD, da rieseguire quando lo step tocca il path di publish del proprio endpoint.
```

## Verifica

Comando eseguito:

```bash
rg -n "K-PRE\\.4\\.3|fiscal-optimism-boundary\\.e2e\\.test\\.mjs|### K[4-7]|Test di confine fiscale" /home/sentrapa/Downloads/ROADMAP_REALTIME_CASSAV4_v4.md
```

Risultato:

- K4 contiene la voce DoD del test di confine fiscale.
- K5 contiene la voce DoD del test di confine fiscale.
- K6 contiene la voce DoD del test di confine fiscale.
- K7 contiene la voce DoD del test di confine fiscale.

## Esito

K-PRE.4.3 completata.

Questa chiude il blocco K-PRE.4. Il prossimo passaggio naturale e' il gate finale di revisione K-PRE prima di iniziare gli step K veri e propri, che restano sospesi finche' non arriva il via esplicito.
