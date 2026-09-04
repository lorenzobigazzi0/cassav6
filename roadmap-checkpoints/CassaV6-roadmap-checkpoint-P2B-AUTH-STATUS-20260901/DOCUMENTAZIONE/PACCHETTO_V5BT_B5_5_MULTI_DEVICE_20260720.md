# Pacchetto Cassa V5BT B5.5 multi-device

Archivio:

```text
CASSAV5BT_B5.5_MULTI_DEVICE_20260720.zip
```

## Contenuto

- sorgente applicazione in `SORGENTE_SISTEMA`;
- sorgenti Palmare e Postazione in `APPLICATIVI`;
- APK B5.5 fisicamente installati in `artifacts/physical-b5-5`;
- roadmap Bluetooth completa, test ed evidenze redatte;
- baseline applicative e runtime portatili;
- dump SQL di provisioning e relativa documentazione;
- launcher, strumenti, test e handover aggiornato.

## Esclusioni

L'archivio esclude:

- `node_modules`, cache Gradle e directory `build`;
- `.git`, `.idea`, `.cxx`, coverage e report temporanei;
- stato locale `.runtime`, PID, log e lock;
- `private`, `config-restricted` e `auxiliary-restricted`;
- chiavi, certificati privati, keystore e file `.env` reali;
- file temporanei usati per enrollment e report ADB con seriali.

Le dipendenze si ripristinano con i lockfile. Le credenziali e il materiale
TLS devono essere rigenerati o trasferiti separatamente tramite un canale
protetto.

## Verifica minima

Dopo l'estrazione:

1. leggere `README_V5BT.md`;
2. leggere `DOCUMENTAZIONE/HANDOVER_V5BT_B5_5_MULTI_DEVICE_20260720.md`;
3. verificare gli hash degli APK indicati nell'handover;
4. eseguire `npm ci` nei progetti Node da usare;
5. configurare JDK 17 e Android SDK prima delle build Android.
