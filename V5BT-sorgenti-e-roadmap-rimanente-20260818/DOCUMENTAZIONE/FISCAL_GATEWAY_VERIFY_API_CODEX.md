# Implementazione API verifica fiscale autorevole

Questo file e' il prompt operativo da passare al Codex che lavora sul servizio
gateway fiscale. Il progetto CASSAv4 e' gia' predisposto a consumare questo
contratto.

## Obiettivo

Implementare nel servizio fiscale un endpoint autorevole che permetta a CASSAv4
di sapere se una emissione o un annullamento e' gia' stato eseguito prima di
inviare nuovamente il comando al registratore telematico.

L'obiettivo di consistenza e':

```text
1 pagamento
-> 1 chiave idempotente
-> 1 operazione fiscale durevole
-> 1 solo documento sul registratore
```

Il servizio gateway fiscale e' la fonte di verita' per questo ambito. Non e'
accettabile dedurre `NOT_FOUND` da un timeout, da un DB non disponibile o da un
registratore non raggiungibile.

## Endpoint da implementare

```text
POST /api/fiscal/receipt/verify
Content-Type: application/json
Idempotency-Key: <chiave>
X-Fiscal-Device-Id: <id RT>
```

L'endpoint deve essere disponibile sullo stesso `apiBaseUrl` gia' usato da:

```text
GET  /api/fiscal/status
POST /api/fiscal/receipt
POST /api/fiscal/void
POST /api/fiscal/reprint
```

## Request

```json
{
  "schemaVersion": 1,
  "operation": "issue",
  "idempotencyKey": "pos_fiscal_tx_123",
  "fiscalRequestId": "pos_fiscal_tx_123",
  "paymentId": "tx_123",
  "receiptId": "fiscal_abcd",
  "payloadHash": "sha256-esadecimale-o-null"
}
```

Per l'annullamento:

```json
{
  "schemaVersion": 1,
  "operation": "void",
  "idempotencyKey": "fiscal_void_fiscal_abcd",
  "fiscalRequestId": "pos_fiscal_tx_123",
  "paymentId": "tx_123",
  "receiptId": "fiscal_abcd",
  "payloadHash": "sha256-esadecimale-o-null",
  "originalDocument": {
    "providerRef": "0972-0023",
    "movementId": "MF000050",
    "receiptDate": "2026-07-17",
    "documentNumber": "0023"
  }
}
```

Regole:

- `operation` ammette solo `issue` o `void`.
- `Idempotency-Key` header e `body.idempotencyKey` devono coincidere.
- `X-Fiscal-Device-Id` identifica il registratore configurato.
- Nessun endpoint, host o device arbitrario deve essere accettato dal body.
- Se la stessa chiave arriva con un payload hash diverso, rispondere `409`.

## Response autorevole

Documento emesso:

```json
{
  "ok": true,
  "authoritative": true,
  "operation": "issue",
  "idempotencyKey": "pos_fiscal_tx_123",
  "found": true,
  "state": "ISSUED",
  "completedAt": "2026-07-17T12:00:00.000Z",
  "document": {
    "providerRef": "0972-0023",
    "movementId": "MF000050",
    "receiptDate": "2026-07-17",
    "documentNumber": "0023"
  }
}
```

Documento annullato:

```json
{
  "ok": true,
  "authoritative": true,
  "operation": "void",
  "idempotencyKey": "fiscal_void_fiscal_abcd",
  "found": true,
  "state": "VOIDED",
  "completedAt": "2026-07-17T12:05:00.000Z",
  "document": {
    "providerRef": "VOID-9001",
    "movementId": "MFVOID0001",
    "receiptDate": "2026-07-17",
    "documentNumber": "9001"
  }
}
```

Operazione assente:

```json
{
  "ok": true,
  "authoritative": true,
  "operation": "issue",
  "idempotencyKey": "pos_fiscal_tx_123",
  "found": false,
  "state": "NOT_FOUND"
}
```

Operazione ancora in corso:

```json
{
  "ok": true,
  "authoritative": true,
  "operation": "issue",
  "idempotencyKey": "pos_fiscal_tx_123",
  "found": true,
  "state": "PROCESSING",
  "retryable": true
}
```

Operazione fallita con certezza senza effetto fiscale:

```json
{
  "ok": true,
  "authoritative": true,
  "operation": "issue",
  "idempotencyKey": "pos_fiscal_tx_123",
  "found": true,
  "state": "FAILED",
  "retryable": true,
  "sideEffectApplied": false,
  "message": "Operazione rifiutata prima dell'invio al registratore."
}
```

Stati ammessi:

```text
issue: ISSUED, PROCESSING, NOT_FOUND, FAILED
void:  VOIDED, PROCESSING, NOT_FOUND, FAILED
```

## Requisito di persistenza

Creare o riusare un journal durevole, per esempio:

```text
fiscal_operation_journal

id
fiscal_device_id
operation
idempotency_key
request_hash
state
side_effect_applied
retryable
provider_ref
movement_id
receipt_date
document_number
error_code
error_message
created_at
updated_at
completed_at
```

Vincolo univoco obbligatorio:

```text
UNIQUE(fiscal_device_id, operation, idempotency_key)
```

Indice minimo:

```text
INDEX(state, updated_at)
INDEX(payment_id)
```

Il journal non deve essere solo in memoria. Deve sopravvivere a riavvio,
crash e perdita della risposta HTTP.

## Protocollo obbligatorio per issue e void

Anche gli endpoint esistenti `/api/fiscal/receipt` e `/api/fiscal/void` devono
usare lo stesso journal.

Sequenza minima:

1. Validare device, operazione, chiave e payload.
2. Creare atomicamente la riga `PROCESSING`, oppure leggere quella esistente.
3. Se la chiave esiste con hash diverso, rispondere `409`.
4. Se esiste gia' uno stato terminale, restituire lo stesso risultato senza
   inviare un nuovo comando al registratore.
5. Eseguire il comando RT una sola volta.
6. Salvare riferimenti e stato terminale nel journal prima di rispondere HTTP.
7. Se la connessione HTTP cade dopo il punto 6, una successiva verifica deve
   restituire il documento gia' registrato.

Se una riga resta `PROCESSING` dopo un crash, il servizio deve avere una
riconciliazione all'avvio o un worker che interroga il registratore/provider.
Finche' non e' possibile stabilire l'esito, deve restare `PROCESSING`; non deve
diventare `NOT_FOUND` per timeout.

## Semantica degli errori

- `400`: request non valida.
- `401/403`: autenticazione o autorizzazione non valida, se previste.
- `409`: stessa chiave con payload/operazione incompatibile.
- `503`: DB, provider o fonte autorevole non consultabile.
- `404`: solo endpoint inesistente. Non usare `404` per chiave non trovata.

Una chiave realmente assente deve restituire HTTP `200`, `authoritative: true`,
`found: false`, `state: "NOT_FOUND"`.

Non impostare mai `authoritative: true` quando la consultazione durevole non e'
stata completata.

## Sicurezza e logging

- Non loggare token, PIN, payload completi o dati fiscali sensibili.
- Loggare correlation/idempotency key, device, operation, stato e latenza.
- Non permettere al client di scegliere host o path del registratore.
- Applicare limiti al body e timeout espliciti.
- Non inserire certificati, chiavi private o segreti nel repository.

## Test obbligatori

1. `issue` mai visto -> verifica `NOT_FOUND`.
2. `issue` riuscito -> verifica `ISSUED` con gli stessi riferimenti.
3. `void` riuscito -> verifica `VOIDED` con riferimenti dell'annullamento.
4. Due `issue` concorrenti con stessa chiave -> un solo comando RT.
5. Due `void` concorrenti con stessa chiave -> un solo comando RT.
6. Stessa chiave con hash diverso -> `409`, zero secondo comando RT.
7. Risposta HTTP persa dopo emissione -> retry/verifica restituisce `ISSUED`,
   zero documenti duplicati.
8. Risposta HTTP persa dopo annullamento -> verifica restituisce `VOIDED`,
   zero annullamenti duplicati.
9. DB non disponibile -> `503`, mai `NOT_FOUND`.
10. Riavvio con record `PROCESSING` -> recovery deterministico.
11. Test multi-device: richieste di device diversi non si contaminano.
12. Test retention: non eliminare record necessari alla finestra operativa e
    di audit.

Gate finale:

```text
1 pagamento
-> 1 riga journal issue
-> 1 documento fiscale
-> N verifiche
-> 0 duplicati
```

## Integrazione gia' presente in CASSAv4

CASSAv4 usa come default:

```text
verifyEndpoint = /api/fiscal/receipt/verify
```

La configurazione accetta anche:

```text
verifyEndpoint
fiscalVerifyEndpoint
```

Il backend CASSAv4 espone inoltre:

```text
POST /api/reports/payment-movement/fiscal/verify
```

Questa route non accetta endpoint o device dal frontend: ricostruisce tutto dal
DB, interroga il gateway e riconcilia la ricevuta locale.

Per compatibilita' un gateway legacy senza endpoint di verifica puo' ricevere
solo il primissimo invio. Qualunque retry incerto viene bloccato fino a quando
la verifica autorevole non e' disponibile.

## Output richiesto al Codex del gateway

Al termine deve consegnare:

1. Elenco file modificati e migrazione DB.
2. Test eseguiti con risultati.
3. Esempi reali delle quattro risposte principali.
4. Prova automatica del caso risposta persa senza doppia emissione.
5. Comando di avvio/deploy e configurazione necessaria.
6. Eventuali limiti del registratore reale dichiarati esplicitamente.
