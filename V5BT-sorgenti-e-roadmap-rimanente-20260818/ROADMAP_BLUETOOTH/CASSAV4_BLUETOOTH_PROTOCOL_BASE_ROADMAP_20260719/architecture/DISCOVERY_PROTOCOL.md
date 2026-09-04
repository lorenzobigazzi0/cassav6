# Discovery protocol

## Formato legacy congelato v1

L'AdvData primario deve restare entro i 31 byte BLE legacy. In questo documento
`AdvData` indica il campo Advertising Data passato al controller: non include
header, indirizzi o CRC della PDU Link Layer. Il precedente vettore applicativo
da 17 byte non era trasmissibile insieme all'UUID custom:

```text
Flags AD structure                              3 byte
Service Data 128-bit overhead                  18 byte
  length + type 0x21 + UUID 128-bit
vecchio payload                                17 byte
totale                                         38 byte  NON VALIDO
```

Se si aggiungesse anche una lista UUID separata, il totale salirebbe a 56 byte.
Il formato v1 usa quindi un solo campo Service Data, che incorpora gia l'UUID:

```text
Flags AD structure                              3 byte
Service Data 128-bit overhead                  18 byte
payload CASSAv4 v1                             10 byte
totale                                         31 byte
```

Non vengono inclusi nome locale, TX power, Manufacturer Data, lista UUID
separata o scan response obbligatoria. In questo modo tutti i campi necessari
alla discovery sono atomici nell'AdvData primario.

L'encoder di riferimento emette la serializzazione Flags-first:

```text
offset  byte  significato
0       02    lunghezza struttura Flags
1       01    AD type Flags
2       06    LE General Discoverable + BR/EDR Not Supported
3       1b    lunghezza struttura Service Data
4       21    AD type Service Data - 128-bit UUID
5..20         service UUID, 16 byte least-significant-octet first
21..30        payload CASSAv4 v1, 10 byte
```

La cattura fisica BlueZ 5.82 ha dimostrato che l'API D-Bus strutturata puo
emettere le stesse due strutture in ordine Service Data-first:

```text
offset  byte  significato
0       1b    lunghezza struttura Service Data
1       21    AD type Service Data - 128-bit UUID
2..17         service UUID, 16 byte least-significant-octet first
18..27        payload CASSAv4 v1, 10 byte
28      02    lunghezza struttura Flags
29      01    AD type Flags
30      06    LE General Discoverable + BR/EDR Not Supported
```

Il decoder deve ricevere esattamente 31 byte e accetta esclusivamente queste
due permutazioni:

```text
Flags, Service Data 128
Service Data 128, Flags
```

In entrambi i casi devono esistere esattamente una struttura Flags
`02 01 06` e una struttura Service Data `1b 21 <UUID_LE_16> <PAYLOAD_10>`.
Duplicati, strutture aggiuntive, tipi sconosciuti, lunghezze alternative, UUID
diversi, terminatori e byte finali residui sono sempre rifiutati. Questa e
interoperabilita strutturale limitata, non un riordino generico. L'encoder di
riferimento continua a produrre Flags-first.

## Payload Service Data v1

Il payload e esattamente 10 byte:

```text
offset  size  campo
0       1     header
1       6     rotatingAlias, 48 bit in network byte order
7       1     bootId, 1..255
8       1     capability bitmap
9       1     advertisement sequence, modulo 256
```

Header:

```text
bit 0..2  protocolVersion (v1 = 1)
bit 3..4  nodeKind (1 Raspberry, 2 handheld, 3 station; 0 riservato)
bit 5     serverReachable
bit 6..7  riservati, devono essere zero
```

Capability bitmap:

```text
bit 0  scan
bit 1  advertise
bit 2  GATT client
bit 3  GATT server
bit 4  scan e advertise concorrenti
bit 5  outbox locale durable
bit 6  bridge verso backend / route advertisement
bit 7  riservato, deve essere zero
```

`bootId` e un token casuale nonzero nuovo a ogni avvio dell'advertiser e non e
un'identita. Prima di azzerare la sequenza, anche dopo perdita dello stato
locale senza reboot fisico, l'advertiser deve generare un nuovo `bootId`.

La sequenza si incrementa modulo 256 a ogni aggiornamento semantico
dell'advertisement. Dati candidato `C` e riferimento `R`, il ricevente calcola
`d = (C.sequence - R.sequence) mod 256`, esclusivamente quando
`rotatingAlias` e `bootId` coincidono:

```text
d = 0       duplicate
d = 1..127  newer
d = 128     ambiguous
d = 129..255 older
```

Un valore `ambiguous` non deve avanzare lo stato. Se alias o bootId differiscono
il confronto e `incomparable`: si apre una nuova osservazione soft-state senza
dedurre ordinamento, identita o autorizzazione e senza cancellare
immediatamente la precedente. Una collisione casuale di `bootId` resta
possibile; per questo sequenza e bootId servono solo a freshness/dedup della
discovery e non sono mai prova di reboot o identita.

La regola half-range presuppone al massimo 127 aggiornamenti semantici non
osservati nello stesso stream. Dopo la scadenza soft-state non si riusa un
riferimento vecchio: la prima osservazione valida ricrea lo stream. Due AdvData
con stessa tupla e stessa sequenza ma contenuto differente sono un conflitto,
non un aggiornamento; il ricevente li scarta e registra una metrica.

## Alias e privacy

Il NodeId stabile e un UUID e non viene mai pubblicato. L'alias e il troncamento
a 48 bit di:

```text
HMAC-SHA256(aliasKey, "CASSAV4-BT-ALIAS-V1\0" || nodeId || "\0" || epoch_u64_be)
```

La serializzazione del messaggio HMAC e normativa, senza normalizzazioni
dipendenti dall'implementazione:

```text
"CASSAV4-BT-ALIAS-V1\0"   UTF-8/ASCII con NUL finale
nodeId                     UUID canonico lowercase, 36 byte UTF-8
"\0"                       un byte 0x00
epoch_u64_be               unsigned 64 bit, network byte order
```

Un NodeId uppercase o non canonico deve essere rifiutato prima della
derivazione. Non si usa la forma UUID binaria da 16 byte.

`aliasKey` e una chiave casuale da 32 byte protetta dal keystore/registry.
L'epoch predefinita dura 60 secondi. A 400 nodi, la probabilita di collisione in
una singola epoch resta circa `2.84e-10`; un'eventuale collisione rilevata dopo
l'autenticazione chiude la sessione e produce una metrica, senza associare
automaticamente l'alias a un NodeId.

I vettori canonici e il codec di riferimento sono in:

```text
contracts/PROTOCOL_TEST_VECTORS.json
shared/protocol/advertisement-v1.mjs
shared/protocol/rotating-alias-v1.mjs
```

Gli advertisement non contengono dati business o personali.

## Soft-state

PeerDirectory usa soft-state:

```text
seen < 5 s: fresh
5-15 s: aging
> 15 s: expired
```
