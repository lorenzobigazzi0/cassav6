# Milestone e gate

## Gate obbligatori

```text
B0: tutti i device target supportano scan; device bridge target supportano advertise/peripheral
B1: protocol test vectors passano
B2: discovery reciproca p95 entro 8 secondi
B3: foreground service stabile 60 minuti
B4: Raspberry vede almeno 10 nodi consecutivi senza leak
B5: 100 sessioni Android↔Raspberry open/close senza crash
B6: 100 sessioni Android↔Android per coppia certificata
B7: zero perdita/duplicazione nei test di frammentazione/retry
B8: reboot device non perde messaggi durable
B9: serverReachable advertisement aggiornata entro 5 secondi
B10: shadow mode non altera il comportamento POS
B11: soak 2 ore, zero crash/ANR e zero session leak
```
