# B11 pilot checklist

## Massimo Misto Non-Gate Schema 3

- [x] composizione fissata a 2 Palmari fisici + 8 virtuali
- [x] composizione fissata a 1 Postazione fisica + 2 virtuali
- [x] 1 Raspberry fisico; cassa automatica e RT virtuali
- [x] 2/2 Palmari fisici osservati nel preflight corrente
- [x] receipt corrente: 2/4 attori fisici osservati
- [x] contratto eseguibile schema 3 `MIXED_NON_GATE_INCOMPLETE`-only
- [x] verdetto positivo non emettibile dal compositore corrente
- [ ] 1/1 Postazione fisica osservata, APK byte-esatto e signer certificati
- [x] `WAIVED_NON_GATE` registrato solo come metadato/policy futura
- [x] waiver incapace di soddisfare readiness nel contratto v3 corrente
- [x] inventario: APK certificato con SHA-256 byte-esatto e signer derivato
  dallo stesso binding
- [x] nessuna probe signer separata; signer ignorato implica APK non certificato
- [ ] 1/1 Raspberry osservato
- [ ] Raspberry con readiness SSH, BlueZ, NTP, servizi e registry attestata
- [ ] presenza e readiness complete di 4/4 attori fisici nello stesso run
- [ ] 600/600 cicli su 6 link real-real con HELLO/auth/data/cleanup
- [ ] 600/600 azioni fisiche e 160/160 comande Palmare
- [ ] business fisico su `LAN_HTTP_SSE`, business Bluetooth zero
- [ ] monitor continui su 4/4 attori fisici
- [ ] soak fisico wall-clock >= 7200000 ms
- [ ] futura versione: manifest e receipt fisici verificabili e byte-bound
- [ ] futura versione: evidenza per-link 6/6 e per-actor 4/4
- [ ] futura versione: timestamp verificabili e provenance live
- [x] 4000/4000 cicli cross-domain attribuiti soltanto al modello software
- [x] 4500/4500 cicli virtual-only attribuiti soltanto al modello software
- [x] sostituzione virtuale dei quattro slot fisici vietata
- [x] stato corrente `MIXED_NON_GATE_INCOMPLETE`; radio, business fisico,
  monitor e soak `NOT_RUN`
- [x] `gateImpact: NONE`, B11 `PENDING`, promozione vietata, avanzamento `49%`

## Storico Massimo Virtualizzato Schema 2

- [x] 10 Palmari virtuali e 3 Postazioni virtuali
- [x] 1 Raspberry, 1 cassa automatica e 1 RT virtuali
- [x] 16/16 attori virtualizzati, 0 attori fisici conteggiati
- [x] 78 coppie Android + 13 link Android-Raspberry
- [x] 9100/9100 connect/disconnect
- [x] 2600/2600 azioni applicative e 800 comande Palmare
- [x] 100/100 transazioni cassa automatica e 100/100 transazioni RT
- [x] accessi ADB/SSH/radio/servizi/periferiche reali assenti
- [x] business su `LAN_HTTP_SSE`, business Bluetooth inoltrato `0`
- [x] report redatto, digest ricalcolato, `gateImpact: NONE`
- [x] B11 `PENDING`, promozione vietata, avanzamento `49%`

## Pilot Fisico Formale

- [ ] 100 discovery cycles
- [ ] 100 direct server sessions
- [ ] 100 peer sessions
- [ ] auth negative
- [ ] retry/dedup
- [ ] reboot durability
- [ ] soak 2h
