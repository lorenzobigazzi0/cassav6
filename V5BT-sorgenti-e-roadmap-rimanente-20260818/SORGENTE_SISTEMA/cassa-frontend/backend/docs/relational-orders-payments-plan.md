# Piano tecnico: primary relazionale per orders e payments

Questo documento prepara la migrazione futura di `orders` e `payments` a write-primary relazionale.
La migrazione non e' attiva: oggi gli endpoint continuano a leggere e scrivere app-state, con mirror shadow verso SQLite relazionale.

## Endpoint che scrivono ordini

- `POST /api/integration/orders/create`
  - Crea una comanda in `integration.orders`.
  - Aggiorna contatori come `integration.lastOrderNumber` e timestamp `integration.lastWriteAt`.
  - Aggiorna stato tavolo in `posSettings.tables`: occupazione, coperti, note, `pendingBills`, `totalDue` quando il workflow lo rende pagabile.
  - Genera audit event `order.created` e `order.line_added`.
  - Puo' generare job in `printSpoolJobs` per comande/stazioni.

- `POST /api/integration/orders/sync`
  - Aggiorna workflow di una comanda esistente: `waiting`, `prep`, `ready`, `delivered`.
  - Aggiorna lock/assegnazione postazione e quantita' preparate/consegnate sulle righe.
  - Non deve far tornare pagabile/non pagato un ordine gia' pagato o cancellato.
  - Aggiorna tavolo e audit, e puo' pubblicare notifiche operative.

- `POST /api/integration/orders/correct`
  - Modifica righe, quantita', note e revisione della comanda.
  - Aggiorna `integration.orderCorrections`, audit, `revision/currentRevision`, totali ordine e tavolo.
  - Genera job di stampa correzione e preconto aggiornato.

- `POST /api/integration/orders/cancel`
  - Annulla una comanda non pagata e in stato annullabile.
  - Porta totale/dovuto a zero, marca le righe come voided, aggiorna tavolo e audit.
  - Genera job di stampa annullamento.
  - Deve rifiutare una comanda gia' pagata.

- `POST /api/integration/orders/line/split`
  - Divide quantita' e riferimenti riga.
  - Deve preservare stato di preparazione, importi e riferimenti bill.

- `POST /api/integration/orders/line/price-override`
  - Cambia prezzo applicato di una riga con permesso dedicato.
  - Aggiorna totali ordine/tavolo e audit.

- `POST /api/integration/orders/comp`
  - Gestisce abbuoni/sostituzioni operative.
  - Aggiorna ordine, pagabilita', audit e job di stampa.

- `POST /api/integration/layout/table/move`
  - Non crea un ordine, ma puo' riscrivere `tableId`, `roomId`, numero tavolo e label sugli ordini attivi.
  - Aggiorna `posSettings.tables`, `pendingBills`, audit e job di ristampa/aggiornamento.

- `POST /api/integration/orders/transfer/request|resolve|force`
  - Prepara o applica trasferimenti ordine.
  - Deve preservare debiti, audit e riferimenti ordine/tavolo.

## Endpoint che scrivono pagamenti

- `POST /api/payments/table`
  - Paga il dovuto di un tavolo o una selezione bill/righe.
  - Scrive `paymentContainers`, `paymentParts`, `paymentTransactions`.
  - Aggiorna `integration.orders`: `paidAmount`, `dueAmount`, `paymentStatus`, timestamp pagamento.
  - Aggiorna `posSettings.tables`: `pendingBills`, `totalDue`, stato tavolo.
  - Scrive `fiscalReceipts` se il metodo richiede fiscalita'.
  - Genera audit `payment.completed` e job in `printSpoolJobs` per ricevute.

- `POST /api/payments/ticket`
  - Paga un ticket/bill specifico.
  - Aggiorna solo il bill e gli ordini referenziati.
  - Mantiene aperti eventuali altri bill del tavolo.

- `POST /api/payments/free-split`
  - Registra split libero, split articolo o importo parziale.
  - Scrive container, parti e transazioni.
  - Aggiorna residui ordine/tavolo/bill.
  - Gestisce idempotenza e retry fiscale senza duplicare addebiti.

- `POST /api/fiscal/command`
  - Scrive eventi fiscali o ricevute operative.
  - Non deve cambiare saldo pagamento se usato come retry/operazione tecnica.

- `POST /api/settings/pos/assign-bill`
  - Cambia assegnazione bill.
  - Va considerato nel dominio payment/tablesBills perche' puo' spostare riferimenti di incasso.

## Dati app-state modificati

- `integration.orders`
  - Fonte primaria corrente per comande, righe, workflow, payment status, revisione, note, varianti, supplementi e routing.

- `posSettings.tables`
  - Stato live tavolo, `pendingBills`, `totalDue`, `covers`, note, cliente, lock visibili e dati layout.

- `tableLocks`
  - Lock operativo per impedire mutazioni concorrenti su tavolo.

- `paymentContainers`
  - Contenitore pagamento, idempotency key, totale pagato, table/order/bill refs, fiscal metadata.

- `paymentParts`
  - Quote del pagamento, metodo, importo, stato fiscale.

- `paymentTransactions`
  - Transazioni provider/generiche, stato settlement, idempotenza/provider references.

- `fiscalReceipts`
  - Ricevute fiscali emesse o retry fiscali.

- `printSpoolJobs`
  - Stampa comande, correzioni, annullamenti, preconti, ricevute pagamento.

- `auditEvents`
  - Traccia di creazione, sync, pagamento, cancellazione, correzione, move/transfer e fiscalita'.

## Relazioni da preservare

- `orders.id` -> `order_lines.order_id`.
- `order_lines.id/lineId` -> varianti e supplementi della riga.
- `orders.tableId` -> `table_states.table_id`.
- `table_states.table_id` -> `table_bills.table_id`.
- `table_bills.id` -> riferimenti bill in payment container/part e ricevute.
- `payment_containers.id` -> `payment_parts.container_id`.
- `payment_containers.id` o `payment_transactions.container_id` -> ordine/tavolo/bill saldato.
- `payment_transactions.id` -> `fiscal_receipts.payment_transaction_id`, quando disponibile.
- `orders.id` -> `printSpoolJobs.orderId` per comande, cancellazioni, correzioni e ricevute.
- `orders.id` -> `auditEvents.entityId` per eventi ordine; `paymentContainers.id` -> audit pagamento/fiscale.

## Invarianti

- Il dovuto tavolo deve essere uguale alla somma dei bill aperti meno importi pagati.
- Un ordine pagato non puo' tornare unpaid per sync tardivo.
- Un ordine cancellato non puo' tornare ready/prep/delivered.
- Un pagamento con stessa idempotency key non crea doppio container, parte, transazione, ricevuta o job ricevuta.
- Un pagamento superiore al dovuto non modifica ordine, tavolo o contatori.
- Uno split parziale mantiene residuo esatto su ordine, bill e tavolo.
- Una cancellazione di ordine pagato deve essere rifiutata o gestita senza saldo negativo.
- Move/transfer devono cambiare table refs senza perdere bill/payment refs.
- Lock tavolo di altro device deve bloccare mutazioni su ordine/pagamento/tavolo.
- Stampa e fiscalita' sono effetti collegati alla stessa transazione logica: non vanno duplicati su retry.
- La sync shadow relazionale deve restare equivalente all'app-state per `orders`, `payments` e `tablesBills`.

## Rischi di race condition

- Due device pagano lo stesso bill in parallelo: rischio doppio incasso o residuo negativo.
- Sync postazione tardivo arriva dopo cancel/payment: rischio regressione workflow o payment status.
- Move tavolo durante pagamento: rischio pagamento agganciato al vecchio tableId mentre il bill e' sul nuovo.
- Correction durante pagamento: rischio totali ordine e bill non allineati.
- Retry idempotente simultaneo: rischio doppia ricevuta o doppio print job.
- Lock scaduto/heartbeat tardivo: rischio due mutazioni concorrenti considerate valide.
- Shadow sync fallita dopo write app-state: rischio equivalenza temporaneamente rotta, da monitorare prima del primary.

## Ordine consigliato per write-primary

1. Rendere relazionale primary solo in lettura per query read-only di ordini storici, non per flussi operativi.
2. Portare in write-primary un comando interno isolato e idempotente, per esempio append audit collegato a pagamento, mantenendo app-state come fallback di verifica.
3. Introdurre write-primary per `paymentTransactions` provider/idempotency, per chiudere la finestra di doppio pagamento.
4. Portare `paymentContainers/paymentParts/fiscalReceipts` in una transazione relazionale unica, continuando a scrivere app-state come mirror.
5. Portare `table_bills/table_states` nella stessa transazione del pagamento.
6. Solo dopo equivalenza stabile, portare `orders/order_lines` write-primary per create/correct/cancel.
7. Integrare move/transfer tavolo nella stessa transaction boundary di orders + tablesBills.
8. Infine promuovere letture operative di cassa/mobile/postazione al relazionale, con app-state solo come compat legacy temporanea.

Ogni passo deve mantenere test invarianti verdi e aggiungere un test di rollback transazionale per errore a meta' mutazione.

