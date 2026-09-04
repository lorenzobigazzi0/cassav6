# Aggiornamento frontend Android - 17 luglio 2026

## Ambito

Workspace autorevole:

```text
D:\cassav2\CASSAV4_V4.6_CURRENT
```

Sono state aggiornate e installate le app Android Palmare e Postazione usando i
relativi frontend V4.6 presenti nella workspace corrente.

## Allineamento sorgenti

Postazione:

- tutti i 62 file applicativi confrontati coincidono byte per byte con il
  frontend Postazione corrente;
- nessun file sorgente corrente risulta mancante nel progetto Android.

Palmare:

- tutti i file del frontend Mobile corrente sono presenti;
- sono state mantenute le estensioni Android intenzionali per runtime offline,
  configurazione WebView, stato connessione e client API;
- gli owner offline restano separati per evitare code duplicate e conservare le
  operazioni durante una disconnessione.

## Artefatti

```text
Palmare 1.0.10 (versionCode 11)
D:\cassav2\CASSAV4_V4.6_CURRENT\android\Palmare\Palmare-1.0.10-debug.apk
SHA-256 E4E13100BD23FFEE460DC55065B152C5A197DE96E44B540F7F470112907D9A93

Postazione 2.0.14 (versionCode 16)
D:\cassav2\CASSAV4_V4.6_CURRENT\android\Postazione\Postazione-2.0.14-debug.apk
SHA-256 D44C2F28FA7ED888A6BACA04F10A6ABCF1AF1487E9CC5D8496AB72CCC637739F
```

Entrambi gli APK risultano firmati con APK Signature Scheme v2.

## Validazione

- build Vite e build Android completate per entrambe le app;
- test unitari Android, lint e `assembleDebug` completati;
- Palmare: 5 file di test frontend mirati, 26 test superati;
- installazione in-place completata senza cancellare dati o configurazioni;
- Palmare verificato su SM-A165F `RFGYA0ZAGFW`;
- Postazione verificata su SM-T503 `R9WT50ZN5VZ`;
- package manager Android e avvio delle rispettive `MainActivity` verificati;
- UI mobile portrait e UI Postazione landscape verificate con schermate reali.

Durante la verifica non erano presenti listener locali sulle porte 5280 e 5281.
La Postazione ha quindi mostrato correttamente lo stato backend offline, mentre
il bundle locale e la shell Android sono stati caricati senza errori.
