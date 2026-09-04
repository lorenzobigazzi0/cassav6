# Ricertificazione Palmare Notification Session V5BT - 2026-08-05

## Ambito

Questa ricertificazione e esclusivamente offline. Aggiorna il target software
Palmare Advanced usato dai futuri gate Lab; non installa APK, non contatta ADB,
Raspberry, Bluetooth o UPS e non produce evidenze fisiche.

| Campo | Valore |
| --- | --- |
| Package | `com.sentrapa.palmare.advanced` |
| Versione | `1.0.37` |
| Version code | `38` |
| Artefatto | `artifacts/Palmare-Advanced-v1.0.37-V5BT-B5.7-Lab-Notification-Session-20260805-debug.apk` |
| SHA-256 | `7e6f8adfca77ff8e7f3f461a0638bfc2224ee39bb57f6a1a27179fd969a75bd3` |

Postazione Advanced resta sul target Lab `2.0.22` code `24`; questa
ricertificazione non ne modifica artefatto o digest.

## Confine Certificato

La build Palmare introduce un epoch di autenticazione dedicato per delimitare
la sessione notifiche. Il lifecycle web scarta snapshot pull appartenenti a
una sessione superata e combina soltanto dati validi per quella corrente. Il
binding nativo usa SHA-256 per legare gli eventi alla sessione e applica
ordinamento di generazione e reset fail-closed. Stream e pull usano header
Bearer senza esporre token nella query string.

## Verifica Offline

| Controllo | Esito |
| --- | --- |
| Test Android Palmare | `208/208 PASS` |
| Android lint | `0 errori`, `23 warning` |
| Test frontend mobile canonico | `29/29 PASS` |
| Test copia frontend impacchettata | `29/29 PASS` |

I risultati attestano la build e il confine applicativo verificato. Non
attestano radio, lifecycle fisico, continuita dei monitor, enrollment sul
banco o stabilita dei servizi reali.

## Impatto Sulle Evidenze

Le evidenze fisiche precedenti sono state acquisite con Palmare `1.0.36` code
`37` e restano storiche. I report esistenti non vengono modificati, ricostruiti
o reinterpretati e non possono essere trasferiti al nuovo APK.

Prima di usare il target `1.0.37` come prerequisito occorre ripetere almeno:

1. inventario read-only e verifica conservativa di package, versione, code,
   SHA-256, firma, permessi, utente ed enrollment;
2. baseline e monitor continui Android e Raspberry;
3. catture B0-B4 applicabili con i target certificati correnti;
4. ogni diagnostico B2/B3 richiesto dal runbook prima del pilot;
5. autorizzazione B0-B4 nuova e legata alle nuove evidenze.

Nessun pilot B5.7 o campagna B5 e autorizzato dalla sola ricertificazione
offline. B0-B5 restano `PENDING`; B6 resta chiusa. L'avanzamento ufficiale
resta **49%**.

## Addendum Fisico Logout Transport

Il target Palmare corrente sostituisce quello descritto nella ricertificazione
offline sopra: `Palmare Advanced 1.0.38` code `39`, artefatto
`artifacts/Palmare-Advanced-v1.0.38-V5BT-B5.7-Lab-Logout-Transport-20260805-debug.apk`,
SHA-256
`c410cae24d5f6663edb9016346842721ea94b944640df49d79ce836a861d1323`.
La firma e invariata e la baseline aggiornata chiude Android `210/210`, con
lint a `0` errori e `23` warning.

La build e stata installata in-place su due Palmare preservando dati, identita
ed enrollment. Nuovi login HTTP `200` hanno ruotato gli epoch; i token
precedenti e quelli revocati al nuovo logout hanno restituito HTTP `401`. In
background autenticato non sono stati rilevati errori. Dopo il logout di
entrambi i device le preferenze auth risultavano assenti, con servizi e
notifiche a `0`.

L'osservazione post-logout e durata `135` secondi, oltre il tick batteria di
`120` secondi. Nel perimetro filtrato strettamente per package target e UID
sono rimasti a `0` poller, trasporto, batteria, audio, fatal e ANR. Dopo il
rilancio entrambi i Palmare sono rimasti alla schermata di login, sempre con i
contatori a `0`. La creazione e il routing degli eventi sono `NOT_RUN`.

Il verdetto e `PASS` limitato a
`PHYSICAL_APPLICATION_REGRESSION / NON_GATE_EVIDENCE`. Non sostituisce le
evidenze B0-B4 e non autorizza pilot o campagna B5. B0-B5 restano `PENDING`,
B6 resta chiusa e l'avanzamento ufficiale resta **49%**.

Il report dedicato e
`reports/V5BT_PALMARE_NOTIFICATION_SESSION_PHYSICAL_REGRESSION_20260805.md`;
la controparte pubblica redatta e sotto `reports/physical/`.
