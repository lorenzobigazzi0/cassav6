# Shared protocol reference

Questi moduli sono l'implementazione di riferimento eseguibile dei contratti B1.
Non avviano scan, advertising o connessioni Bluetooth.

## Advertisement v1

`advertisement-v1.mjs` codifica e valida il payload Service Data da 10 byte e
puo costruire l'AdvData legacy completo da 31 byte. AdvData e il campo dati
passato al controller, non l'intera PDU Link Layer. L'encoder produce
`02 01 06 1b 21 <UUID_LE_16> <PAYLOAD_10>`. Il decoder accetta anche l'esatta
permutazione BlueZ osservata
`1b 21 <UUID_LE_16> <PAYLOAD_10> 02 01 06`.

Non sono ammesse altre varianti: devono esserci esattamente una struttura Flags
e una Service Data, con valori e lunghezze congelati. Versioni, bit riservati,
duplicati, tipi extra, Flags, UUID, strutture residue e byte finali non validi
sono rifiutati.

La `sequence` usa aritmetica seriale modulo 256. Il confronto e definito solo
per lo stesso `(rotatingAlias, bootId)`: distanza avanti `1..127` significa
`newer`, `0` significa `duplicate`, `128` e `ambiguous`, `129..255` significa
`older`. Alias o bootId diversi producono `incomparable`.

## Rotating alias v1

`rotating-alias-v1.mjs` deriva l'alias da 48 bit con:

```text
HMAC-SHA256(aliasKey, "CASSA_V6-BT-ALIAS-V1\0" || nodeId || "\0" || epoch_u64_be)
```

La serializzazione e normativa: `nodeId` e il testo UUID canonico lowercase,
esattamente 36 byte UTF-8; segue un byte NUL e poi l'epoch unsigned a 64 bit in
big-endian. Input UUID uppercase o non canonici vengono rifiutati.

L'alias e formato dai primi 6 byte del digest. `aliasKey` e una chiave casuale
da 32 byte creata durante il provisioning, conservata nel keystore del device e
nel registry autorizzato. Il NodeId stabile non entra mai nell'advertisement.

## GATT profile v1

`gatt-profile-v1.mjs` normalizza e congela il servizio CASSA_LINK_V1 e le
sette caratteristiche definite in `configs/gatt-uuids.json`. Ogni voce
contiene nome, UUID e flag BlueZ; il modello rifiuta duplicati e contratti non
esatti.

Il modulo e transport-free: non apre D-Bus o BluetoothGatt, non mantiene
connessioni e non autorizza accessi. Il runtime Raspberry lo usa per costruire
l'albero GATT, mentre autenticazione e traffico appartengono alla sessione B5.

## Direct control v1

`direct-control-v1.mjs` congela il controllo B5.7 successivo alla mutual auth.
I messaggi `1..3` restano riservati all'autenticazione; il nuovo contratto usa:

```text
4  CLIENT_KEY_SHARE    94 byte
5  SERVER_KEY_SHARE    94 byte
6  CLIENT_KEY_CONFIRM  50 byte
7  PING                54 byte
8  PONG                54 byte
9  CLOSE               55 byte
10 CLOSE_ACK           55 byte
```

Le chiavi pubbliche effimere sono SPKI X25519 canoniche da 44 byte. Il client
lega il proprio share ai due HELLO e al certificateId tramite HMAC alias-key;
il binder di sessione lega poi entrambi gli share. HKDF-SHA256 deriva quattro
chiavi distinte da 32 byte per controllo client-server, controllo
server-client e le due conferme. Label, ordine dei campi e vettore RFC7748
cross-language sono congelati nel test del modulo.

PING, PONG e chiusura portano un HMAC-SHA256 completo sul wire header e sulla
sequenza unsigned big-endian. Il primo PING/PONG e un activation probe: solo
dopo la sua verifica il lifecycle puo passare da `KEY_ESTABLISHED` ad
`ACTIVE`. CLOSE e CLOSE_ACK devono avere sequence e reason identici. Il modulo
non crea timer, non conserva sessioni e non autorizza traffico business.

## Test

```bash
node --test shared/protocol/advertisement-v1.test.mjs
node --test shared/protocol/gatt-profile-v1.test.mjs
node --test shared/protocol/direct-control-v1.test.mjs
node scripts/validate-contracts.mjs --root .
```
