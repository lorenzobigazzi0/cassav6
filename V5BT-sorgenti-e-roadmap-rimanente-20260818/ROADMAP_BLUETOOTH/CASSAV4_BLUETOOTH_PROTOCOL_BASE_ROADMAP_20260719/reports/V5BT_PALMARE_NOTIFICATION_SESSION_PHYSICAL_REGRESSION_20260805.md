# Regressione Fisica Palmare Notification Session V5BT - 2026-08-05

## Classificazione

| Campo | Valore |
| --- | --- |
| Tipo evidenza | `PHYSICAL_APPLICATION_REGRESSION` |
| Elegibilita gate | `NON_GATE_EVIDENCE` |
| Verdetto | `PASS` |
| Gate formali | `B0-B5 PENDING` |
| Avanzamento ufficiale | `49%` |

Il verdetto riguarda esclusivamente il confine applicativo di sessione,
logout e trasporto notifiche del Palmare. Non certifica Bluetooth, routing di
comande, continuita B3, ledger B4, pilot B5.7 o campagna B5.

## Target Verificato

| Campo | Valore |
| --- | --- |
| Applicazione | `Palmare Advanced` |
| Package | `com.sentrapa.palmare.advanced` |
| Versione | `1.0.38` |
| Version code | `39` |
| Artefatto | `artifacts/Palmare-Advanced-v1.0.38-V5BT-B5.7-Lab-Logout-Transport-20260805-debug.apk` |
| SHA-256 | `c410cae24d5f6663edb9016346842721ea94b944640df49d79ce836a861d1323` |
| Firma | invariata |

La build e stata installata in-place su due Palmare. Dati, identita ed
enrollment sono rimasti invariati; non sono stati usati uninstall, `pm clear`,
cambio utente o nuova enrollment.

## Baseline Software

| Controllo | Esito |
| --- | --- |
| Test Android Palmare | `210/210 PASS` |
| Android lint | `0 errori`, `23 warning` |

## Scenari Eseguiti

| Scenario | Esito | Evidenza aggregata |
| --- | --- | --- |
| Nuovo login su entrambi i Palmare | `PASS` | HTTP `200`, epoch ruotato |
| Token della sessione precedente | `PASS` | HTTP `401` |
| Permanenza in background da autenticato | `PASS` | zero errori applicativi rilevati |
| Logout su entrambi i Palmare | `PASS` | preferenze auth assenti, servizi `0`, notifiche `0` |
| Token revocati dal nuovo logout | `PASS` | HTTP `401` |
| Rilancio dopo logout | `PASS` | schermata login e tutti i contatori osservati a `0` |

## Osservazione Post-Logout

L'osservazione e durata `135` secondi, oltre il tick batteria di riferimento di
`120` secondi. L'evidenza e stata filtrata in modo stretto per package target e
relativo UID; righe non appartenenti a tale ambito non sono state attribuite
all'applicazione certificata.

| Contatore nel perimetro target | Valore |
| --- | ---: |
| Poller | 0 |
| Trasporto | 0 |
| Batteria | 0 |
| Audio | 0 |
| Fatal | 0 |
| ANR | 0 |

Dopo il rilancio l'applicazione e rimasta sulla schermata di login con servizi,
notifiche, poller, trasporto, batteria e audio ancora a `0`.

## Scenari Non Eseguiti

La creazione degli eventi di notifica e il relativo routing sono `NOT_RUN`.
Questi scenari restano necessari nella fase dedicata e non sono implicati dal
verdetto di questo report.

## Impatto Roadmap

La regressione dimostra sul banco il comportamento di logout della build
`1.0.38`, ma non produce evidenza valida per promuovere B0-B5. Le catture radio
precedenti restano storiche; i gate fisici devono essere acquisiti con la
matrice corrente e secondo i rispettivi runbook. B6 resta chiusa.

La controparte pubblica strutturata e
`reports/physical/v5bt-palmare-notification-session-physical-regression-redacted-20260805.json`.

Avanzamento roadmap complessiva: **49%**
