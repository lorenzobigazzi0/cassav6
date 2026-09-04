# Memoria architettura configurazione locale, attivita, sale e flussi operativi

Data creazione: 2026-06-03

## Scopo

Questo documento e' la memoria stabile da seguire per ricostruire in modo ordinato la parte impostazioni/configurazione e per riallineare i flussi operativi collegati a sale, prenotazioni, personale, postazioni, notifiche, menu, listini, stampanti e RT.

L'obiettivo non e' fare una modifica veloce dentro mobile o postazione, ma preparare una struttura coerente, versionata e sicura che permetta al sistema di crescere senza rompere comande, pagamenti, stampa, fiscalita', prenotazioni e sessioni.

## Principi non negoziabili

- Il frontend mobile non deve contenere configurazioni statiche di sale, menu, stampanti o permessi.
- Mobile, postazione, cassa e monitor devono leggere una configurazione pubblicata dal backend.
- Le impostazioni operative devono vivere in un frontend separato di amministrazione/configurazione.
- Ogni modifica critica deve essere versionata, validata e auditata.
- Una comanda deve restare collegata allo snapshot di configurazione usato al momento dell'invio.
- Un pagamento deve mantenere importi e riferimenti della comanda originaria, anche se listini o configurazioni cambiano dopo.
- Le stampanti e le RT devono essere risolte lato backend, non lato frontend.
- I flussi gia' funzionanti di pagamenti, fiscale, ristampa, spool e sessioni non vanno rifatti insieme alla configurazione.

## Glossario dominio

### Locale

Il contenitore principale dell'installazione. In partenza esiste un solo locale.

Esempio: Amalia.

### Attivita

Un ramo operativo del locale.

Esempi:

- Bar
- Ristorante
- Spiaggia
- Pizza in Riva

Ogni locale puo' avere piu' attivita.

### Sala

Area fisica o logica dove si trovano i tavoli.

Esempi:

- Terrazza
- Pedana
- Gazebo
- Bar
- Pizza in Riva

Una sala puo' appartenere a una o piu' attivita. Le sale possono sovrapporsi tra attivita.

### Associazione attivita-sala

Relazione molti-a-molti tra attivita e sale.

Esempio: la sala Gazebo puo' essere usata sia da Bar sia da Ristorante, ma con menu, listini, personale o postazioni differenti.

### Postazione

Frontend operativo di produzione/preparazione o controllo comande.

Le postazioni possono essere assegnate a:

- una o piu' sale;
- una o piu' attivita;
- specifiche categorie menu;
- specifici reparti;
- specifiche stampanti.

### Stampante

Dispositivo non fiscale usato per comande, preconti, rettifiche, annulli, spostamenti, resi, sostituzioni e tagliandi operativi.

### RT

Registratore telematico o servizio fiscale associato solo a una o piu' attivita.
La sala non possiede RT operative: eredita RT e fiscalita dall'attivita operativa corrente.
Una RT puo' essere un provider/API fiscale e non una stampante fisica. Nel modello v2 gli RT stanno in `fiscalDevices[]`; le stampanti fisiche stanno in `printers[]` e, salvo legacy di migrazione, non rappresentano fiscalita.

### Catalogo prodotti

Lista unica dei prodotti disponibili nel sistema. Il prodotto non va duplicato per ogni sala o listino.

### Menu

Vista organizzata del catalogo in categorie/sottocategorie, filtrata per attivita, sala, utente, fascia oraria e disponibilita'.

### Listino

Regola di prezzo applicabile a prodotti o sezioni del menu. Puo' dipendere da:

- fascia oraria;
- sala;
- attivita;
- evento;
- prenotazione;
- override manuale;
- utente o ruolo, solo se previsto.

### Personale

Utenti/operatori del sistema, con permessi, sale assegnate, attivita abilitate e priorita di notifica.

### Priorita notifica

Tre livelli funzionali richiesti:

- Ordine
- Consegna
- Ritiro

Ogni cameriere puo' avere priorita diverse per ciascun tipo.

### Snapshot configurazione

Versione pubblicata della configurazione usata dai frontend runtime.

Gli ordini e i pagamenti devono salvare il riferimento allo snapshot usato, cosi' il sistema puo' ricostruire cosa era valido in quel momento.

## Modello architetturale proposto

```text
Locale
  -> Attivita
       -> RT / fiscalita
       -> menu/listini principali
       -> RT/API fiscali
       -> stampanti non fiscali principali
       -> postazioni
       -> associazioni con Sale
            -> Tavoli
            -> Personale assegnato
            -> Stampanti non fiscali specifiche della sala
            -> Menu/Listini specifici o aggiuntivi della sala
            -> Regole prenotazioni
            -> Regole notifiche
```

La relazione tra attivita e sale deve essere molti-a-molti:

```text
Attivita Bar        -> Sala Terrazza, Sala Gazebo, Sala Bar
Attivita Ristorante -> Sala Terrazza, Sala Pedana, Sala Gazebo
Attivita Spiaggia   -> Sala Spiaggia, Sala Gazebo
```

La stessa sala puo' quindi esistere in piu' contesti operativi senza duplicare i tavoli fisici.

Regola non negoziabile del modello v2: RT solo su Attivita. Sala eredita RT dall'Attivita corrente. Backend risolve tutto.
Configurazione effettiva = configurazione Attivita + eventuali specifiche Sala.
I riferimenti storici a RT, cash point fiscale o fiscalPrinterId sulla sala sono legacy/migrazione e non devono guidare runtime, mobile, postazione o fiscalita.

## Frontend impostazioni separato

Va costruito un frontend dedicato alla configurazione, separato da:

- mobile;
- cassa;
- postazione;
- monitor;
- prenotazioni operative.

Il frontend impostazioni deve gestire almeno:

- locale;
- attivita;
- sale;
- tavoli;
- postazioni;
- stampanti;
- RT e fiscalita su Attivita;
- categorie per postazione;
- utenti;
- permessi;
- personale per sala;
- priorita notifiche;
- menu;
- listini;
- associazioni menu-sale-attivita;
- regole prenotazioni;
- regole di routing stampa e comande;
- pubblicazione configurazione.

## Stati della configurazione

La configurazione deve avere almeno questi stati:

- draft: modificabile, non usata dai frontend runtime;
- published: attiva e letta da mobile/postazione/cassa/monitor;
- archived: vecchia versione mantenuta per audit e storico ordini.

Transizioni ammesse:

```text
draft -> published
published -> archived
archived -> nessuna transizione ordinaria
```

Per rollback:

```text
published corrente -> archived
archived precedente -> nuovo draft -> published
```

Non riattivare direttamente una configurazione archived senza passare da validazione.

## Schema dati concettuale

Questi nomi sono concettuali: l'implementazione puo' partire dentro la struttura dati attuale e poi essere normalizzata.

### Tabelle/collezioni candidate

- `locales`
- `activities`
- `rooms`
- `activityRoomBindings`
- `tables`
- `workstations`
- `printers`
- `fiscalDevices`
- `staffAssignments`
- `notificationPriorityRules`
- `catalogProducts`
- `menuCollections`
- `menuCategories`
- `menuCategoryBindings`
- `priceLists`
- `priceRules`
- `roomPriceOverrides`
- `stationRoutingRules`
- `reservationRules`
- `reservationRecords`
- `operationalCounters`
- `configurationSnapshots`
- `configurationAuditEvents`

### Relazioni chiave

- Un locale ha molte attivita.
- Una attivita ha molte sale tramite binding.
- Una sala puo' appartenere a molte attivita.
- Una sala ha tavoli fisici.
- Una sala puo' avere postazioni proprie.
- Una sala puo' avere stampanti non fiscali proprie. Non puo' avere RT operative proprie.
- Una sala puo' usare menu/listini propri o condivisi.
- Una categoria menu puo' essere attiva su piu' sale.
- Un prodotto puo' comparire in piu' menu senza essere duplicato.
- Un utente puo' essere assegnato a piu' sale e attivita.
- Una postazione riceve solo comande compatibili con sale, attivita, categorie e stato attivo.

## Runtime: regole di risoluzione

### Menu visibile su mobile

Il mobile deve mostrare categorie disponibili per l'utente e per il contesto operativo, non i reparti come livello principale.

Il reparto resta visibile nel dettaglio prodotto, perche' serve come informazione e routing.

### Listino

Il backend risolve sempre il prezzo effettivo.

Il frontend puo' mostrare il prezzo ricevuto, ma non deve essere autoritativo per il totale finale.

La comanda deve memorizzare:

- prezzo applicato;
- listino applicato;
- fascia oraria se presente;
- snapshot configurazione;
- timestamp server.

Se la comanda viene emessa alle 17:30 e pagata alle 18:30, resta valido il prezzo delle 17:30.

### Routing comande

La postazione riceve una comanda se e solo se:

- e' attiva;
- e' compatibile con la sala;
- e' compatibile con l'attivita;
- e' compatibile con categoria/reparto della comanda;
- non e' in pausa senza trasferimento;
- rispetta le regole di load balancing esclusivo.

Le comande non devono arrivare a piu' postazioni contemporaneamente salvo regola esplicita.

### Routing stampa

Il backend decide:

- stampante comanda;
- stampante preconto;
- stampante annullo/rettifica;
- stampante spostamento/cambio sala;
- stampante reso/storno;
- RT fiscale se richiesto.

Il frontend non deve scegliere direttamente una stampante tramite logica duplicata.

## Modifiche operative segnalate da integrare

### Sposta tavolo prenotato

Problemi segnalati:

- la modale ha contrasto errato;
- premendo conferma non completa lo spostamento;
- il comportamento non deve rompere prenotazione, occupazione, comande e stampe.

Comportamento atteso:

- modale coerente graficamente con le altre modali mobile;
- contrasto leggibile in light e dark mode;
- conferma effettua realmente lo spostamento;
- se il tavolo ha prenotazione, la prenotazione segue il tavolo o aggiorna il riferimento secondo la regola scelta;
- se ci sono comande/preconti aperti, va stampato aggiornamento come gia' previsto nei flussi tavolo;
- il digitale deve aggiornarsi subito.

### Libera tavolo prenotato

Problemi segnalati:

- premendo libera parte lo spinner;
- la prenotazione non viene rimossa o aggiornata;
- il tavolo resta bloccato.

Comportamento atteso:

- se il tavolo e' solo prenotato e non occupato, libera deve rimuovere o chiudere lo stato prenotato;
- se ci sono piu' prenotazioni future, deve liberare solo quella pertinente;
- la UI deve chiudere a esito positivo;
- il tavolo deve tornare utilizzabile se non ci sono vincoli entro la finestra dei 30 minuti.

### Dettaglio prenotazione

Quando si clicca una prenotazione nella sezione prenotati devono comparire:

- ARRIVATI;
- NO SHOW;
- ELIMINA.

Ogni azione deve avere modale di conferma.

Regole:

- ARRIVATI: occupa o prepara il tavolo secondo disponibilita;
- NO SHOW: chiude la prenotazione come mancata presentazione;
- ELIMINA: cancella la prenotazione con conferma, preferibilmente con motivo se azione admin.

### Prenotazioni multi-tavolo

Una prenotazione puo' includere piu' tavoli.

Regole richieste:

- piu' prenotazioni sullo stesso tavolo sono ammesse se distanti almeno un'ora;
- se si selezionano piu' tavoli per una prenotazione, quando la prenotazione diventa effettiva i tavoli devono essere uniti;
- se uno o piu' tavoli sono occupati, non bisogna buttare fuori l'operatore o interrompere ordine/pagamento in corso;
- il tavolo resta in gestione a chi lo sta usando finche' non viene liberato manualmente;
- 30 minuti prima, se il tavolo e' libero, diventa prenotato effettivo;
- 30 minuti prima, se il tavolo e' occupato, va avvisato che deve essere lasciato entro 10 minuti;
- se dopo 30 minuti non e' ancora liberato, chiedere cosa fare:
  - rimandare di 10 minuti;
  - liberare;
- quando la prenotazione viene liberata, i tavoli uniti per quella prenotazione devono essere ridivisi.

### Conteggio coperti totali

Serve un conteggio persistito, non solo UI.

Ambiti da decidere:

- per locale;
- per attivita;
- per sala;
- per turno;
- per data servizio;
- per operatore.

Regola consigliata:

```text
operationalCounters(serviceDate, localeId, activityId, roomId, counterType)
```

Counter type iniziali:

- `covers_total`
- `apericena_total`

### Conteggio apericena segnati

Il conteggio apericena deve aggiornarsi quando:

- viene aggiunto articolo/supplemento apericena;
- viene rimosso articolo/supplemento apericena;
- viene modificata quantita;
- viene fatto reso/storno se applicabile;
- viene cancellata una comanda prima del pagamento.

Deve restare coerente con lo storico e con il contesto sala/attivita.

### Priorita notifiche

Tre tipi richiesti:

- Ordine;
- Consegna;
- Ritiro.

Ogni cameriere deve poter avere priorita per ciascun tipo.

Esempio:

```text
Giada:
  Ordine: alta
  Consegna: media
  Ritiro: bassa
```

La priorita deve essere combinata con:

- sala assegnata;
- attivita assegnata;
- presenza online;
- carico corrente;
- eventuale postazione/cameriere richiedente.

### Assegnazione personale a sala

Ogni utente puo' essere assegnato a:

- una o piu' sale;
- una o piu' attivita;
- una o piu' mansioni;
- priorita notifica per tipo.

Le notifiche non devono essere inviate a chi non e' compatibile salvo fallback esplicito.

### Gestione per ogni postazione

Ogni postazione deve essere configurabile per:

- sale servite;
- attivita servite;
- categorie/reparti serviti;
- stampante primaria;
- stampante backup;
- regole pausa;
- regole trasferimento;
- priorita code;
- massimo comande in preparazione;
- visibilita storico.

Regole gia' richieste per postazione:

- se non ci sono comande in corso, la nuova comanda va subito in preparazione;
- se ci sono comande, la nuova va in attesa in ordine cronologico;
- la piu' vecchia deve stare piu' in alto;
- se l'utente clicca un'altra comanda e quella precedente non ha articoli spuntati, la precedente torna in attesa;
- se una comanda ha almeno un articolo spuntato resta in preparazione;
- massimo 3 comande in preparazione;
- quando una comanda viene terminata, la successiva passa automaticamente in preparazione;
- se la postazione va offline o in pausa, le comande restano in coda e riprendono;
- se esiste altra postazione disponibile, chiedere se trasferire;
- se non esiste altra postazione, mantenere sospesa senza perdere stato.

### Ordini fantasma

Problema segnalato:

- compaiono ordini fantasma su alcuni tavoli con numero ordine strano.

Ipotesi da verificare:

- vecchi record non archiviati correttamente;
- tableId/tableNumber non normalizzati;
- ordine legato a tavolo unito o poi diviso;
- storico non svuotato alla liberazione tavolo;
- retry di ordine o sync tardivo;
- cancellazione tavolo non auditata;
- comanda pagata/non pagata non allineata;
- ordine creato da preconto/reservation flow senza sequenza corretta.

Azioni richieste:

- introdurre audit specifico per ogni cambio tavolo/ordine;
- distinguere storico operativo visibile da archivio DB;
- quando un tavolo viene liberato, il nuovo utilizzo non deve mostrare storico precedente;
- mantenere archivio nel DB con sessione/tavolo/occupazione precedente;
- validare sempre orderId, displayOrderNumber, tableId, roomId, tableSessionId.

## Prenotazioni: regole operative da mantenere

### Finestra 30 minuti

Fino a 30 minuti prima, il tavolo puo' restare utilizzabile.

Se libero:

- a 30 minuti dall'orario prenotazione diventa prenotato effettivo.

Se occupato:

- non deve buttare fuori l'operatore;
- non deve chiudere ordine/pagamento in corso;
- deve avvisare che il tavolo va lasciato entro 10 minuti;
- se resta occupato, deve chiedere:
  - rimanda 10 minuti;
  - libera.

### Avvisi

Avvisi richiesti:

- 30 minuti prima solo se tavolo gia' occupato;
- 15 minuti prima;
- 5 minuti prima;
- gestione ritardo dopo finestra.

### Prenotazione da pagina prenotazioni

Deve seguire le stesse regole della prenotazione creata da dettaglio tavolo.

La pagina prenotazioni deve permettere:

- scelta data;
- scelta sala tra sale abilitate all'utente;
- scelta tavolo singolo o multiplo;
- controllo distanza minima un'ora per lo stesso tavolo;
- azioni ARRIVATI, NO SHOW, ELIMINA;
- gestione multi-sala se permessa.

## Table session e storico visibile

Quando un tavolo viene liberato:

- lo storico operativo visibile nel dettaglio tavolo deve essere svuotato;
- ordini, pagamenti e comande restano nel DB come archivio;
- il nuovo utilizzo del tavolo deve avere una nuova `tableSessionId`;
- ogni ordine/pagamento deve restare collegato alla vecchia sessione.

Questo serve a evitare ordini fantasma e residui grafici.

## Cancellazione tavolo admin

Richiesta precedente da integrare:

Negli admin, nella modale da pressione lunga sul tavolo, oltre a unisci/sposta deve esserci cancellazione.

La cancellazione deve:

- richiedere conferma;
- richiedere motivazione obbligatoria;
- cancellare o archiviare ordini pendenti;
- cancellare o archiviare pagamenti pendenti;
- cancellare comande inviate se non gia' fiscalmente/pagamento concluse;
- liberare occupazione;
- stampare ticket di cancellazione tavolo stile pagamento;
- registrare audit event.

Se ci sono transazioni gia' incassate o fiscali, non cancellare senza percorso di storno/annullo corretto.

## Flusso notifiche persistenti

Le notifiche devono rimanere appese se l'utente va offline o fa logout.

Tipi principali:

- ordine pronto;
- chiamata cameriere;
- ritiro/consegna;
- avviso postazione offline/online;
- cambio sala/tavolo;
- prenotazione imminente.

Regola:

- se non consegnata, resta pending;
- al login successivo viene consegnata;
- al primo ack valido viene marcata acked;
- se scade, viene marcata expired;
- non va duplicata a ogni poll.

## Pagamenti e scarico

Regola da mantenere:

- fino allo scarico, tutti i pagamenti dell'utente devono rimanere visibili su mobile;
- logout/login non deve nascondere movimenti della sessione non scaricata;
- dopo scarico, non devono piu' comparire nello scarico corrente;
- se ci sono tavoli da pagare, lo scarico deve avvisare con seconda conferma.

## Elementi gia' fragili da non rompere

- Pagamento POS e invio fiscale.
- Ristampa fiscale: deve usare API di ristampa, non nuova emissione.
- Spool stampa persistente.
- Utente Francesca: ordini gia' pagati, no fiscale, preconti anche a `192.168.1.36`.
- Prezzi birre con listino orario come prima.
- Menu mobile senza fallback statico sale.
- Batteria palmari.
- Stato postazioni attive e load balancing esclusivo.
- Storico ordini svuotato lato UI quando il tavolo viene liberato, ma mantenuto in archivio DB.

## Roadmap sicura

### Fase 0 - Memoria e inventario

- Consolidare questo documento.
- Inventariare dati attuali di sale, utenti, postazioni, stampanti, RT, menu e listini.
- Identificare config hardcoded ancora presenti.

### Fase 1 - Snapshot configurazione backend

- Creare modello configurazione pubblicata.
- Esporre endpoint read-only per runtime.
- Non cambiare ancora i flussi operativi.
- Aggiungere audit configurazione.

### Fase 2 - Frontend impostazioni base

- Locale.
- Attivita.
- Sale.
- Associazione attivita-sale.
- Tavoli.
- Utenti e sale abilitate.
- Pubblicazione snapshot.

### Fase 3 - Prenotazioni e table session

- Correggere sposta/libera tavolo prenotato.
- Aggiungere azioni ARRIVATI, NO SHOW, ELIMINA.
- Gestire prenotazioni multi-tavolo.
- Introdurre o rafforzare `tableSessionId`.
- Svuotare storico operativo alla liberazione tavolo.

### Fase 4 - Postazioni e routing

- Configurare postazioni per sala/attivita/categorie.
- Aggiornare subito presenza camerieri.
- Disabilitare chiamata se cameriere offline.
- Code persistenti e recupero offline.
- Massimo 3 comande in preparazione.

### Fase 5 - Notifiche e personale

- Priorita Ordine/Consegna/Ritiro.
- Assegnazione personale sala/attivita.
- Notifiche persistenti tra logout/login.

### Fase 6 - Menu e listini per sala/attivita

- Catalogo unico.
- Menu condivisibili.
- Listini per sala/attivita/fascia.
- Routing categorie per postazione.

### Fase 7 - Stampanti e RT

- Stampanti fiscali e non fiscali principali per attivita; stampanti non fiscali specifiche per sala/postazione.
- RT solo per attivita; eventuali differenze per metodo pagamento sono policy dell'attivita, non della sala.
- Fallback stampante controllato e auditato.

### Fase 8 - Monitor e audit

- Monitor deve mostrare stato reale di configurazione.
- Conteggi coperti e apericena persistiti.
- Diagnostica ordini fantasma.
- Report movimenti e anomalie.

## Test da prevedere

### Configurazione

- Attivita con sala condivisa.
- Sala con menu diverso per due attivita.
- Sala con listino diverso per due attivita.
- Postazione assegnata solo a una categoria.
- Utente assegnato a piu' sale.
- Pubblicazione snapshot valida.
- Rollback snapshot.

### Prenotazioni

- Prenotazione singolo tavolo.
- Prenotazione multi-tavolo.
- Due prenotazioni stesso tavolo distanti almeno un'ora.
- Prenotazione troppo vicina rifiutata.
- Tavolo occupato 30 minuti prima.
- Rimanda 10 minuti.
- Libera prenotato.
- Arrivati.
- No show.
- Elimina.

### Tavoli e storico

- Tavolo liberato e rioccupato non mostra vecchio storico.
- Archivio DB mantiene vecchi ordini.
- Tavolo spostato con ordini aperti.
- Tavolo unito e poi diviso.
- Prenotazione multi-tavolo libera e ridivide.

### Postazioni

- Una postazione attiva riceve tutto.
- Due postazioni fanno load balancing esclusivo.
- Postazione offline mantiene coda.
- Postazione torna online e recupera coda.
- Pausa con trasferimento.
- Pausa senza altre postazioni.
- Massimo 3 in preparazione.

### Notifiche

- Notifica pending sopravvive a logout.
- Notifica pending viene consegnata al login.
- Ack pulisce stato.
- Offline waiter disabilita chiamata.
- Online waiter riabilita chiamata.
- Priorita Ordine/Consegna/Ritiro rispettata.

### Pagamenti e scarico

- Logout/login mantiene movimenti non scaricati.
- Scarico chiude sessione pagamenti.
- Dopo scarico non ricompaiono movimenti vecchi.
- Cancellazione tavolo con transazioni viene auditata.

## Domande aperte prima dell'implementazione completa

- Il conteggio coperti deve essere per locale, attivita, sala o turno?
- L'apericena va contato per articolo principale, supplemento o entrambi?
- In una sala condivisa, chi prevale tra listino sala e listino attivita?
- Una postazione puo' appartenere a piu' attivita contemporaneamente?
- RT prevale sempre per attivita. La sala non decide RT; eventuali specifiche sala sono solo non fiscali.
- In caso di prenotazione multi-tavolo, il tavolo master va scelto dall'utente o calcolato dal sistema?
- Se un tavolo prenotato e occupato non viene liberato, chi puo' forzare la liberazione?
- La cancellazione admin deve essere consentita anche con pagamenti fiscali emessi o solo tramite storno?

## Criteri di accettazione

- Mobile vede solo configurazione backend pubblicata.
- Nessuna sala hardcoded torna nel runtime.
- Le sale possono essere condivise da piu' attivita.
- Menu/listini possono essere diversi per sala e attivita.
- RT/fiscalita sono configurate solo su attivita e risolte dal backend.
- Le parti menu possono essere condivise tra sale.
- Prenotazioni rispettano la finestra 30/15/5 minuti.
- Prenotazioni multi-tavolo uniscono e ridividono correttamente.
- Tavolo liberato non mostra storico vecchio al nuovo utilizzo.
- Notifiche persistono tra logout/login finche' non ackate.
- Postazioni mantengono code in caso offline/pausa.
- Conteggi coperti e apericena sono persistiti.
- Ordini fantasma sono tracciabili con audit e non visibili nel nuovo utilizzo tavolo.
- Tutte le azioni critiche hanno conferma, motivo dove richiesto, audit e stampa se prevista.

## Stato implementazione

### 2026-06-03 - Slice 1, snapshot configurazione read-only

Implementato primo aggancio backend non invasivo:

- modulo puro `backend/modules/configuration/configuration-snapshot.js`;
- export `backend/modules/configuration/index.js`;
- endpoint autenticato read-only `POST /api/settings/configuration/snapshot`;
- test `backend/tests/configuration-snapshot.test.mjs`.

Lo snapshot espone:

- locale;
- attivita;
- sale;
- binding attivita-sala;
- postazioni ricavate dalle aree/cash point;
- stampanti;
- RT ricavate da stampanti fiscali;
- assegnazioni personale;
- menu scope;
- invarianti runtime.

Questa slice non cambia ancora il comportamento di mobile, postazione, pagamenti, fiscalita, prenotazioni o stampa. Serve come contratto stabile per costruire il futuro frontend impostazioni e per evitare nuovi fallback o duplicazioni lato client.

Endpoint introdotto:

```http
POST /api/settings/configuration/snapshot
```

Note:

- richiede sessione valida;
- e' read-only;
- non espone mutazioni pubbliche;
- supporta configurazione legacy attuale;
- supporta gia' attivita multiple e sale condivise se il backend riceve `activities` e `activityRoomBindings`.

### 2026-06-03 - Slice 2, contenimento ordini fantasma per sessione tavolo

Diagnosi sul DB reale:

- tavoli totali: 103;
- ordini integration presenti: 16;
- pagamenti presenti: 12;
- nessun ordine con `tableId` inesistente;
- nessun ordine senza tavolo;
- diversi ordini pagati con `dueAmount=0` erano ancora legati al tavolo dentro `integration.orders`;
- gli audit contenevano molti `table.settled`, ma pochissimi `table.released`;
- la funzione sessione backend considerava solo `table.session_opened` e `table.released`, quindi un pagamento che chiudeva finanziariamente il tavolo non diventava confine di sessione.

Correzione applicata:

- `table.settled` viene trattato come confine di chiusura sessione finanziaria nella costruzione delle sessioni correnti;
- il mobile ora chiama `/api/integration/orders?includeDone=1&includeTransferred=1&currentSessionOnly=1`;
- gli ordini pagati prima di `table.settled` restano in archivio DB, ma non rientrano nella sessione corrente del tavolo;
- gli ordini nuovi dopo `table.settled` continuano a essere visibili e pagabili.

File modificati:

- `backend/server.js`;
- `mobile-frontend/src/api/tables.ts`;
- `backend/tests/integration-current-table-session.test.mjs`;
- `mobile-frontend/tests/static/tableHistorySync.test.ts`.

Test previsti/eseguiti:

- backend: endpoint ordini con `currentSessionOnly=1` esclude ordine pagato prima di `table.settled`;
- mobile statico: la fetch ordini del tavolo include `currentSessionOnly=1`.

Verifiche completate:

- `node --test backend/tests/integration-current-table-session.test.mjs` OK;
- `npm run test -- tests/static/tableHistorySync.test.ts` OK;
- `npm run check:backend` OK;
- `npm run typecheck` mobile OK;
- `npm run build` mobile OK;
- bundle mobile servito: `mobile-frontend/dist/assets/index-D9Wdl5yk.js`;
- backend riavviato su `0.0.0.0:5181` con `BACKEND_DB_MODE=sqlite`, `BACKEND_DB_PATH=/srv/applicazione/data/backend.sqlite`, `PRINTING_ENABLED=1`;
- frontend/proxy riavviato su `0.0.0.0:5180`;
- health backend OK;
- mobile `/mobile/` OK;
- verifica DB reale via API:
  - ordini archiviati totali con `includeDone=1`: 16;
  - ordini visibili nella sessione corrente con `currentSessionOnly=1`: 5;
  - ordini storici filtrati fuori dal dettaglio tavolo corrente: 11.
- `node --test backend/tests/route-policy-architecture.test.mjs` OK;
- verifica layout/ordini via API reale:
  - sale: 6;
  - tavoli: 103;
  - riferimenti tavolo invalidi negli ordini: 0;
  - ordini senza tavolo: 0;
  - numeri ordine sospetti: 0.

Rischio residuo:

- gli ordini vecchi restano correttamente in archivio; se in futuro una vista deve mostrare archivio storico completo deve chiamare l'endpoint senza `currentSessionOnly=1`;
- eventuali tavoli pagati prima dell'introduzione di audit `table.settled` e mai liberati potrebbero non avere un confine sessione ricostruibile: in quel caso serve audit/manual reset del tavolo specifico.

### 2026-06-03 - Slice 3, prenotazioni terminali e tavoli prenotati

Correzione applicata:

- le prenotazioni ora mantengono uno stato esplicito `booked`, `arrived`, `no_show`, `cancelled`, `released`;
- gli stati terminali non vengono piu' riattivati dalla finestra dei 30 minuti;
- un tavolo prenotato marcato `arrived` passa a tavolo utilizzabile/accomodato senza lasciare una prenotazione zombie;
- un tavolo prenotato marcato `no_show`, `cancelled` o `released` viene liberato e non viene piu' ribloccato dal calcolo finestra;
- l'endpoint operativo `POST /api/pos/reservations/status` consente ARRIVATI, NO SHOW, ELIMINA/ANNULLA/CHIUDI con lock prenotazione rispettato;
- il frontend mobile prenotazioni espone in dettaglio i pulsanti ARRIVATI, NO SHOW, ELIMINA solo sulle prenotazioni ancora `booked`;
- `tableReservationWindow` filtra le prenotazioni terminali prima di applicare badge o blocchi.

File modificati:

- `backend/server.js`;
- `backend/modules/reservations/reservations.handlers.js`;
- `backend/modules/reservations/reservations.routes.js`;
- `mobile-frontend/src/api/reservations.ts`;
- `mobile-frontend/src/api/tableReservationWindow.ts`;
- `mobile-frontend/src/pages/home/reservations/ReservationsWorkspace.tsx`;
- `mobile-frontend/src/styles/reservations.css`;
- `backend/tests/reservations-status.e2e.test.mjs`.

Test eseguiti:

- `node --test backend/tests/reservations-status.e2e.test.mjs` OK;
- incluso nel gruppo backend mirato del ciclo: OK.

Rischio residuo:

- restano da completare i flussi multi-tavolo avanzati: unione automatica quando la prenotazione multi-tavolo diventa effettiva e ridivisione automatica quando viene liberata;
- resta da completare la UX di rimando 10 minuti se il tavolo e' ancora occupato dopo la finestra operativa.

### 2026-06-03 - Slice 4, coda postazione e presenza camerieri

Correzione applicata:

- introdotto modulo piccolo `backend/modules/orders/order-preparation-queue.js`;
- quando una postazione seleziona una nuova comanda e la precedente nella stessa coda era `prep` senza articoli spuntati, il backend la riporta a `waiting`;
- le comande con almeno un articolo spuntato restano in preparazione;
- la demotion e' auditata con `order.selection_handoff_demoted`;
- la risposta `/api/integration/orders/sync` include `selectionHandoffDemotions` per osservabilita';
- il limite massimo di 3 comande in preparazione resta attivo;
- la presenza camerieri lato postazione viene aggiornata piu' rapidamente:
  - polling pannello camerieri: 2,5s;
  - sync UI: 1,5s;
  - polling ack chiamata: 2s;
  - finestra attivita richiesta a `/api/integration/waiters`: 20s;
- il pulsante chiamata resta disabilitato con barra rossa se il cameriere non risulta online e si riabilita al ritorno online.

File modificati:

- `backend/server.js`;
- `backend/modules/orders/order-preparation-queue.js`;
- `backend/tests/postazione-preparation-selection.e2e.test.mjs`;
- `postazione/dist/assets/postazione-waiter-panel-fix.js`;
- `postazione/dist/assets/postazione-support-routing.js`;
- `postazione/dist/index.html`.

Test eseguiti:

- `npm run check:backend` OK;
- `npm run gate:architecture-security` OK;
- `npm run audit:architecture-security` OK, nessun finding bloccante;
- `node --test backend/tests/postazione-preparation-selection.e2e.test.mjs backend/tests/reservations-status.e2e.test.mjs backend/tests/integration-current-table-session.test.mjs backend/tests/route-policy-architecture.test.mjs` OK, 9/9;
- `node --test frontend-tests/postazione-bridges.test.mjs frontend-tests/mobile-frontendv2-static.test.mjs` OK, 20/20;
- `npm --prefix mobile-frontend run typecheck` OK;
- `npm run preflight:source` NON OK per layout sorgente atteso da packaging v2 (`v2/app/...`, `README.md`, `FIX_REPORT.md`, inventari): non e' una regressione runtime del codice corrente, ma un mismatch tra cartella live `/srv/applicazione/current` e formato pacchetto atteso dal preflight.

Monolite:

- `server.js` prima del mini-refactor: 27541 righe;
- `server.js` dopo estrazione `order-preparation-queue.js`: 27474 righe;
- gate monolite rientrato sotto budget `27500`.

Rischio residuo:

- la postazione e' ancora basata su bundle `dist` con bridge runtime; va pianificata la ricostruzione nativa da sorgenti o la sostituzione del bundle con codice sorgente mantenibile;
- la pausa postazione con trasferimento verso postazioni realmente attive richiede ancora una slice dedicata;
- priorita notifiche `Ordine/Consegna/Ritiro` e assegnazione personale per sala sono documentate ma non ancora implementate.

### 2026-06-03 - Slice 5, monitor counters servizio

Correzione applicata:

- `buildMonitorOverview()` ora espone `counts.service`;
- il monitor puo' leggere:
  - `currentCovers`: coperti attuali dai tavoli;
  - `orderCovers`: coperti dagli ordini;
  - `apericenaMarked`: apericena segnati sugli ordini.

File modificato:

- `backend/modules/status/status.handlers.js`.

Rischio residuo:

- il frontend monitor attuale ha solo `dist` disponibile; la visualizzazione grafica completa dei nuovi contatori va collegata in una slice successiva o ricostruendo il frontend monitor da sorgenti.

### Verifica live post-riavvio Slice 3-5

Riavvio effettuato mantenendo configurazione runtime precedente:

- backend: `0.0.0.0:5181`;
- frontend/proxy: `0.0.0.0:5180`;
- DB: `BACKEND_DB_MODE=sqlite`, `BACKEND_DB_PATH=/srv/applicazione/data/backend.sqlite`;
- stampa: `PRINTING_ENABLED=1`;
- `BACKEND_TOKEN_SECRET` preservato dal processo precedente.

Verifiche live:

- `GET /api/health` OK;
- `/mobile/` OK;
- `/postazione/` OK;
- `GET /api/integration/waiters?source=mobile-frontend&activeMs=20000` OK, 0 camerieri attivi al momento della verifica;
- `GET /api/monitor/overview` OK, `counts.service` presente;
- `GET /api/integration/orders?includeDone=1&includeTransferred=1&currentSessionOnly=1` OK, 5 ordini visibili nella sessione corrente;
- log backend senza errori d'avvio;
- log frontends senza errori d'avvio.

### 2026-06-03 - Slice 6, notifiche persistenti e ack globale mirato

Correzione applicata:

- aggiunta una policy nativa per le notifiche mirate a operatori/dispositivi:
  - una notifica non confermata resta disponibile anche dopo logout/login;
  - una notifica mirata confermata non riappare su una nuova sessione o su un nuovo consumer dello stesso utente;
  - le notifiche broadcast non vengono forzate globalmente salvo `meta.globalAck === true`;
- la policy e' stata estratta fuori da `server.js` nel modulo puro `backend/modules/notifications/notification-ack-policy.js`;
- il pull `/api/integration/notifications/pull` ignora le notifiche marcate come globalmente confermate;
- l'ack `/api/integration/notifications/ack` marca come confermate globalmente le notifiche mirate, senza cambiare contratto API.

File modificati:

- `backend/server.js`;
- `backend/modules/notifications/notification-ack-policy.js`;
- `backend/tests/notifications-persistence.e2e.test.mjs`;
- `MEMORIA_ARCHITETTURA_CONFIGURAZIONE.md`.

Test eseguiti:

- `node --test backend/tests/notifications-persistence.e2e.test.mjs` OK, 2/2.

Rischio residuo:

- priorita notifiche `Ordine/Consegna/Ritiro` e routing personale per sala restano da implementare in una slice successiva;
- le notifiche broadcast restano con ack per consumer, per evitare regressioni su avvisi destinati a piu' postazioni/operatori.

### 2026-06-03 - Slice 7, fallback tavoli mobile neutro

Correzione applicata:

- rimosso dal sorgente mobile il fallback demo che generava tavoli occupati, prenotazioni e storico ordini fittizi;
- il fallback locale dei tavoli ora crea solo tavoli liberi e senza storico, in attesa dei dati reali dal backend;
- aggiunto test statico per impedire il ritorno di:
  - `makeInitialOrderHistory`;
  - `MOCK_TABLE_NAMES`;
  - righe demo tipo `Composizione ordine`;
  - note demo tipo allergie fittizie.

File modificati:

- `mobile-frontend/src/api/tables.ts`;
- `cassa-frontend/frontend-tests/mobile-frontendv2-static.test.mjs`;
- `mobile-frontend/dist/*` rigenerato da build;
- `MEMORIA_ARCHITETTURA_CONFIGURAZIONE.md`.

Test eseguiti:

- `npm run typecheck` in `mobile-frontend` OK;
- `npm run build` in `mobile-frontend` OK;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs` OK, 7/7.

Rischio residuo:

- se il backend non e' raggiungibile, il mobile puo' mostrare una griglia neutra temporanea; e' intenzionale e preferibile rispetto a ordini o prenotazioni inventati.

### Verifica live post-riavvio Slice 6-7

Riavvio effettuato mantenendo:

- backend: `0.0.0.0:5181`;
- frontend/proxy: `0.0.0.0:5180`;
- DB: `BACKEND_DB_MODE=sqlite`, `BACKEND_DB_PATH=/srv/applicazione/data/backend.sqlite`;
- stampa: `PRINTING_ENABLED=1`;
- `BACKEND_TOKEN_SECRET` preservato dal processo precedente.

Verifiche live:

- `GET /api/health` OK;
- `/mobile/` OK;
- `/postazione/` OK;
- `GET /api/monitor/overview` OK, include `counts.service` e fiscal receipts;
- `GET /api/integration/waiters?source=mobile-frontend&activeMs=20000` OK;
- bundle mobile servito: `index-UEPQK4KF.js`;
- log backend senza errori d'avvio, solo warning Node SQLite sperimentale.

### 2026-06-03 - Slice 8, priorita operative notifiche

Correzione applicata:

- introdotto modulo puro `backend/modules/notifications/notification-priority.js`;
- supportate tre priorita operative:
  - `ordine`;
  - `consegna`;
  - `ritiro`;
- supportati alias inglesi/legacy (`order`, `delivery`, `pickup`, `order_ready`, ecc.);
- la sanitizzazione delle notifiche aggiunge in `meta`:
  - `notificationPriority`;
  - `notificationPriorityRank`;
  - `notificationPriorityLabel`;
- il pull `/api/integration/notifications/pull` ordina prima per priorita e poi per data di creazione;
- le notifiche senza priorita continuano ad avere comportamento cronologico compatibile.

File modificati:

- `backend/server.js`;
- `backend/modules/notifications/notification-priority.js`;
- `backend/tests/notifications-priority.e2e.test.mjs`;
- `MEMORIA_ARCHITETTURA_CONFIGURAZIONE.md`.

Test eseguiti:

- `node --test backend/tests/notifications-priority.e2e.test.mjs backend/tests/notifications-persistence.e2e.test.mjs` OK, 4/4;
- `npm run check:backend` OK;
- `npm run gate:architecture-security` OK;
- `npm run audit:architecture-security` OK, nessun finding bloccante;
- gruppo mirato backend con notifiche, postazione, prenotazioni, table session e route policy OK, 13/13.

Rischio residuo:

- assegnazione personale a sala e priorita abilitate per singolo cameriere non sono ancora applicate al routing automatico;
- prossimo step consigliato: preservare/esporre `waiterUserIds` delle sale e priorita utente nel payload `/api/integration/waiters`, poi usarle nella selezione destinatari.

### Verifica live post-riavvio Slice 8

Riavvio effettuato solo sul backend mantenendo:

- backend: `0.0.0.0:5181`;
- DB: `BACKEND_DB_MODE=sqlite`, `BACKEND_DB_PATH=/srv/applicazione/data/backend.sqlite`;
- stampa: `PRINTING_ENABLED=1`;
- `BACKEND_TOKEN_SECRET` preservato dal processo precedente.

Verifiche live:

- `GET /api/health` OK;
- `GET /api/integration/waiters?source=mobile-frontend&activeMs=20000` OK;
- `GET /api/monitor/overview` OK;
- log backend senza errori d'avvio, solo warning Node SQLite sperimentale.

### 2026-06-03 - Slice 9, payload camerieri con sale assegnate e priorita abilitate

Correzione applicata:

- introdotto modulo puro `backend/modules/notifications/waiter-routing.js`;
- preservato sul profilo utente sanitizzato il campo `notificationPriorities`;
- `/api/integration/waiters` espone ora per ogni cameriere:
  - `assignedRoomIds`;
  - `assignedToCurrentRoom`;
  - `notificationPriorities`;
- le sale assegnate vengono lette da `posSettings.areas[].waiterUserIds`;
- le priorita abilitate supportano sia array sia oggetto booleano e fanno fallback sicuro a `ordine/consegna/ritiro`.

File modificati:

- `backend/server.js`;
- `backend/modules/notifications/waiter-routing.js`;
- `backend/tests/waiters-routing.e2e.test.mjs`;
- `MEMORIA_ARCHITETTURA_CONFIGURAZIONE.md`.

Test eseguiti:

- `node --test backend/tests/waiters-routing.e2e.test.mjs` OK;
- `npm run check:backend` OK;
- `npm run gate:architecture-security` OK, `server.js` 27499 righe;
- `npm run audit:architecture-security` OK, nessun finding bloccante;
- gruppo mirato backend con notifiche, postazione, prenotazioni, table session, waiters e route policy OK, 14/14.

Rischio residuo:

- il routing automatico delle notifiche non filtra ancora in base a `assignedRoomIds`/`notificationPriorities`; lo step ha esposto i dati reali e testati, lo step successivo potra' usarli nella selezione destinatari e nella UI postazione/settings.

### Verifica live post-riavvio Slice 9

Riavvio effettuato solo sul backend mantenendo:

- backend: `0.0.0.0:5181`;
- DB: `BACKEND_DB_MODE=sqlite`, `BACKEND_DB_PATH=/srv/applicazione/data/backend.sqlite`;
- stampa: `PRINTING_ENABLED=1`;
- `BACKEND_TOKEN_SECRET` preservato dal processo precedente.

Verifiche live:

- `GET /api/health` OK;
- `GET /api/integration/waiters?source=mobile-frontend&activeMs=20000` OK;
- `GET /api/monitor/overview` OK;
- log backend senza errori d'avvio, solo warning Node SQLite sperimentale.

### 2026-06-03 - Slice 10, routing notifiche per sala assegnata e priorita cameriere

Correzione applicata:

- estratto dal monolite il matcher notifiche in `backend/modules/notifications/notification-targeting.js`;
- il pull `/api/integration/notifications/pull` arricchisce il requester con:
  - sale assegnate (`assignedRoomIds`);
  - priorita abilitate (`notificationPriorities`);
- il matching notifiche ora:
  - rispetta `notificationPriority` se presente;
  - consente `targetRoomId` se il cameriere e' assegnato a quella sala, anche se il palmare non sta visualizzando quella sala;
  - continua a rispettare target personali espliciti, device, postazione e client app;
  - mantiene compatibilita' per notifiche senza priorita.

File modificati:

- `backend/server.js`;
- `backend/modules/notifications/notification-targeting.js`;
- `backend/modules/notifications/waiter-routing.js`;
- `backend/tests/waiters-routing.e2e.test.mjs`;
- `MEMORIA_ARCHITETTURA_CONFIGURAZIONE.md`.

Test eseguiti:

- `node --test backend/tests/waiters-routing.e2e.test.mjs backend/tests/notifications-priority.e2e.test.mjs backend/tests/notifications-persistence.e2e.test.mjs` OK, 6/6;
- `npm run check:backend` OK;
- `npm run gate:architecture-security` OK, `server.js` 27435 righe;
- `npm run audit:architecture-security` OK, nessun finding bloccante;
- gruppo mirato backend con notifiche, routing camerieri, postazione, prenotazioni, table session e route policy OK, 15/15.

Avanzamento stimato dopo Slice 10:

- piano complessivo stabilizzazione/configurazione: circa 67%;
- sotto-area notifiche/personale/postazioni: circa 72%.

Rischio residuo:

- il routing e' operativo a livello backend pull; UI/settings devono ancora permettere modifica completa di priorita e assegnazioni;
- la gestione postazioni per pausa/trasferimento code resta da completare.

### Verifica live post-riavvio Slice 10

Riavvio effettuato solo sul backend mantenendo:

- backend: `0.0.0.0:5181`;
- DB: `BACKEND_DB_MODE=sqlite`, `BACKEND_DB_PATH=/srv/applicazione/data/backend.sqlite`;
- stampa: `PRINTING_ENABLED=1`;
- `BACKEND_TOKEN_SECRET` preservato dal processo precedente.

Verifiche live:

- `GET /api/health` OK;
- `GET /api/integration/waiters?source=mobile-frontend&activeMs=20000` OK;
- `GET /api/monitor/overview` OK;
- log backend senza errori d'avvio, solo warning Node SQLite sperimentale.

### 2026-06-03 - Slice 11, pausa postazione e trasferimento code operator-aware

Correzione applicata:

- aggiunto modulo `backend/modules/integration/station-pause-transfer.js`;
- `/api/integration/stations/state` ora supporta una richiesta esplicita di trasferimento coda con:
  - `pauseTransferMode: "transfer"`;
  - oppure `transferOrders: true`;
- quando una postazione/operatore va offline:
  - se non viene richiesto il trasferimento, la logica resta conservativa e mantiene la coda;
  - se viene richiesto il trasferimento e c'e' una postazione reale attiva, trasferisce solo le comande non ancora iniziate dell'operatore/device offline;
  - se non ci sono destinazioni attive, le comande restano sospese/riconciliabili;
  - non trasferisce comande gia' in preparazione, bloccate, pronte, pagate o trasferite manualmente;
- corretto il caricamento DB delle `stationStates`: prima la normalizzazione teneva una sola sessione per nome postazione, ora conserva piu' operatori/device sulla stessa postazione usando una chiave `postazione + operatore/device`.

File modificati:

- `backend/server.js`;
- `backend/modules/integration/station-pause-transfer.js`;
- `backend/tests/station-pause-transfer.e2e.test.mjs`;
- `MEMORIA_ARCHITETTURA_CONFIGURAZIONE.md`.

Test eseguiti:

- `node --check backend/server.js` OK;
- `node --check backend/modules/integration/station-pause-transfer.js` OK;
- `node --test backend/tests/station-pause-transfer.e2e.test.mjs` OK, 2/2;
- `npm run check:backend` OK;
- `npm run gate:architecture-security` OK, `server.js` 27493 righe;
- `npm run audit:architecture-security` OK, nessun finding bloccante;
- gruppo mirato backend con notifiche, priorita, persistenza, postazione, disponibilita postazioni e waiters OK, 10/10.

Avanzamento stimato dopo Slice 11:

- piano complessivo stabilizzazione/configurazione: circa 70%;
- sotto-area notifiche/personale/postazioni: circa 78%.

Rischio residuo:

- la UI postazione deve ancora mostrare/forzare la scelta esplicita "trasferisci o mantieni" quando si mette in pausa;
- la lista destinazioni e' ora backend-real, ma il flusso visuale di pausa/trasferimento lato postazione va completato nel prossimo step;
- il monitor mostra 0 postazioni attive se nessuna postazione invia heartbeat valido; la UI postazione deve rendere piu' evidente questa condizione.

### Verifica live post-riavvio Slice 11

Riavvio effettuato solo sul backend mantenendo:

- backend: `0.0.0.0:5181`;
- DB: `BACKEND_DB_MODE=sqlite`, `BACKEND_DB_PATH=/srv/applicazione/data/backend.sqlite`;
- stampa: `PRINTING_ENABLED=1`;
- `BACKEND_TOKEN_SECRET` preservato dal processo precedente.

Verifiche live:

- `GET /api/health` OK;
- `GET /api/integration/waiters?source=mobile-frontend&activeMs=20000` OK;
- `GET /api/monitor/overview` OK;
- `GET /mobile/` dal proxy frontend OK;
- processi attesi attivi: backend, `serve-frontends.mjs`, battery dashboard, mirror preconto Francesca;
- log backend senza errori d'avvio, solo warning Node SQLite sperimentale.

### 2026-06-03 - Slice 12, UI postazione per pausa con trasferimento coda

Correzione applicata:

- aggiornata la postazione per chiedere esplicitamente cosa fare quando l'operatore mette la postazione in pausa;
- la modale compare solo su cambio manuale del toggle verso pausa, non sugli heartbeat automatici;
- se esistono altre postazioni reali attive:
  - pulsante `Mantieni in coda` invia `pauseTransferMode: "suspend"`;
  - pulsante `Trasferisci coda` invia `pauseTransferMode: "transfer"` e `transferOrders: true`;
- se non esistono altre postazioni attive:
  - non apre modali inutili;
  - invia automaticamente `pauseTransferMode: "suspend"`;
- la lista destinazioni usa `/api/integration/stations/active` e mostra postazione + operatore reale;
- aggiornato query string dello script in `postazione/dist/index.html` per evitare cache client del vecchio bridge.

File modificati:

- `postazione/dist/assets/postazione-station-operator-bridge.js`;
- `postazione/dist/index.html`;
- `cassa-frontend/frontend-tests/postazione-bridges.test.mjs`;
- `MEMORIA_ARCHITETTURA_CONFIGURAZIONE.md`.

Test eseguiti:

- `node --check postazione/dist/assets/postazione-station-operator-bridge.js` OK;
- `node --check frontend-tests/postazione-bridges.test.mjs` OK;
- `node --test frontend-tests/postazione-bridges.test.mjs` OK, 16/16;
- `npm run check:backend` OK;
- `npm run gate:architecture-security` OK, `server.js` 27493 righe.

Avanzamento stimato dopo Slice 12:

- piano complessivo stabilizzazione/configurazione: circa 72%;
- sotto-area notifiche/personale/postazioni: circa 82%.

Rischio residuo:

- la UI usa ancora bridge statici perche' la sorgente nativa della postazione non e' presente nella cartella corrente;
- il prossimo step dovrebbe spostare gradualmente questi bridge in moduli sorgente/build appena disponibile o quando si ricostruisce la postazione.

Verifica live:

- modifica statica, nessun riavvio backend richiesto;
- `postazione/dist/index.html` punta a `postazione-station-operator-bridge.js?v=20260603-pause-transfer`.

### 2026-06-03 - Slice 13, presenza postazioni multi-operatore lato postazione

Correzione applicata:

- rafforzato il bridge delle postazioni attive per conservare le sessioni reali distinte, non solo il nome della postazione;
- `window.__postazioneRealActiveStations` resta compatibile e continua a esporre i nomi unici delle postazioni attive;
- aggiunti i nuovi dati runtime:
  - `window.__postazioneRealActiveStationSessions`, con postazione, operatore, username, userId, deviceUuid e timestamp;
  - `window.__postazioneRealActiveStationKeys`, con chiave `postazione + operatore/device`;
  - `window.__postazioneHasRealActiveStation(station, identity)`, per verificare anche un operatore/device specifico sulla stessa postazione;
- mantenuto il filtro visuale esistente delle tile e delle select, cosi' non cambia il contratto UI gia' usato dalla postazione;
- aggiornato query string dello script in `postazione/dist/index.html` per evitare cache client del vecchio bridge.

Motivazione:

- dopo la Slice 11 il backend preserva piu' operatori/device sulla stessa postazione;
- senza questa correzione il frontend postazione continuava a comprimere la presenza per solo nome postazione, perdendo informazione utile per trasferimenti, chiamate e disponibilita' reali.

File modificati:

- `postazione/dist/assets/postazione-active-stations-bridge.js`;
- `postazione/dist/index.html`;
- `cassa-frontend/frontend-tests/postazione-bridges.test.mjs`;
- `MEMORIA_ARCHITETTURA_CONFIGURAZIONE.md`.

Test eseguiti:

- `node --check postazione/dist/assets/postazione-active-stations-bridge.js` OK;
- `node --check cassa-frontend/frontend-tests/postazione-bridges.test.mjs` OK;
- `node --test frontend-tests/postazione-bridges.test.mjs` OK, 17/17;
- `npm run check:backend` OK;
- `npm run gate:architecture-security` OK, `server.js` 27493 righe;
- verifica proxy: `GET /postazione/` punta a `postazione-active-stations-bridge.js?v=20260603-active-station-sessions`.

Avanzamento stimato dopo Slice 13:

- piano complessivo stabilizzazione/configurazione: circa 73%;
- sotto-area notifiche/personale/postazioni: circa 84%.

Rischio residuo:

- la postazione usa ancora bridge statici in `dist`; appena disponibile una pipeline sorgente/build completa, questa logica va ricollocata in moduli sorgente nativi;
- la prossima fetta consigliata e' collegare questi dati sessione alle UI che devono mostrare destinazioni/trasferimenti e presenza camerieri in modo piu' granulare.

Verifica live:

- modifica statica, nessun riavvio backend richiesto;
- `postazione/dist/index.html` punta a `postazione-active-stations-bridge.js?v=20260603-active-station-sessions`.

### 2026-06-03 - Slice 14, fallback locale reale per trasferimento postazione

Correzione applicata:

- la modale di pausa/trasferimento postazione continua a interrogare il backend reale `/api/integration/stations/active`;
- se quella chiamata fallisce temporaneamente, usa come fallback solo le sessioni reali gia' pubblicate dal bridge presenza in `window.__postazioneRealActiveStationSessions`;
- il fallback esclude la sessione corrente usando chiave `postazione + operatore/device`, quindi non propone di trasferire la coda a se stessa;
- nessun mock o fallback demo viene reintrodotto;
- aggiornato query string dello script in `postazione/dist/index.html` per evitare cache client.

Motivazione:

- durante refresh asincroni o micro-interruzioni, la postazione poteva non mostrare destinazioni anche se il bridge presenza aveva gia' dati freschi;
- questo rende piu' robusto il flusso di pausa/offline senza cambiare contratto backend.

File modificati:

- `postazione/dist/assets/postazione-station-operator-bridge.js`;
- `postazione/dist/index.html`;
- `cassa-frontend/frontend-tests/postazione-bridges.test.mjs`;
- `MEMORIA_ARCHITETTURA_CONFIGURAZIONE.md`.

Test eseguiti:

- `node --check postazione/dist/assets/postazione-station-operator-bridge.js` OK;
- `node --check cassa-frontend/frontend-tests/postazione-bridges.test.mjs` OK;
- `node --test frontend-tests/postazione-bridges.test.mjs` OK, 18/18;
- `npm run check:backend` OK;
- `npm run gate:architecture-security` OK, `server.js` 27493 righe;
- verifica proxy: `GET /postazione/` punta a `postazione-station-operator-bridge.js?v=20260603-pause-transfer-session-fallback` e `postazione-active-stations-bridge.js?v=20260603-active-station-sessions`.

Avanzamento stimato dopo Slice 14:

- piano complessivo stabilizzazione/configurazione: circa 74%;
- sotto-area notifiche/personale/postazioni: circa 86%.

Rischio residuo:

- il fallback e' volutamente solo UI/resilienza; la decisione finale di trasferimento resta backend;
- resta da collegare questa granularita' anche a eventuali pannelli futuri di selezione destinazione esplicita, se richiesti.

Verifica live:

- modifica statica, nessun riavvio backend richiesto;
- la pagina `/postazione/` servita dal proxy carica i bridge aggiornati.

### 2026-06-03 - Slice 15, persistenza notifiche ordine/consegna/ritiro

Verifica applicata:

- controllato il flusso notifiche backend:
  - le notifiche non confermate restano in `db.integration.notifications`;
  - il `pull` le riconsegna al login successivo se il target utente/app combacia;
  - l'ack mirato viene marcato in modo globale quando la notifica ha target esplicito;
  - routing e priorita' usano `notificationPriority` con livelli `ordine`, `consegna`, `ritiro`;
- non e' stata necessaria una modifica runtime: il comportamento era gia' coerente con la richiesta;
- aggiunto test regressivo specifico per i tre livelli ordine/consegna/ritiro dopo logout e nuovo login.

File modificati:

- `cassa-frontend/backend/tests/notifications-persistence.e2e.test.mjs`;
- `MEMORIA_ARCHITETTURA_CONFIGURAZIONE.md`.

Test eseguiti:

- `node --check backend/tests/notifications-persistence.e2e.test.mjs` OK;
- `node --test backend/tests/notifications-persistence.e2e.test.mjs` OK, 3/3;
- `node --test backend/tests/notifications-priority.e2e.test.mjs backend/tests/waiters-routing.e2e.test.mjs` OK, 4/4;
- `npm run check:backend` OK;
- `npm run gate:architecture-security` OK, `server.js` 27493 righe.

Avanzamento stimato dopo Slice 15:

- piano complessivo stabilizzazione/configurazione: circa 75%;
- sotto-area notifiche/personale/postazioni: circa 88%.

Rischio residuo:

- il test protegge la persistenza lato backend; resta da verificare periodicamente la UI mobile reale contro eventuali filtri locali/cache della lista notifiche;
- le notifiche con `action: delete` vengono comunque rimosse come da contratto attuale.

### 2026-06-03 - Slice 16, ciclo sessione notifiche mobile

Correzione applicata:

- il mobile non effettua piu' polling/SSE notifiche quando non esiste una sessione login valida;
- la deduplica locale delle notifiche viene azzerata quando cambia la sessione utente (`sessionStartedAt`, utente o device);
- se una notifica resta non confermata lato backend, al nuovo login dello stesso utente viene ripresentata invece di restare nascosta dalla cache locale;
- estratta la deduplica in helper puro `notificationDedup.ts`, riducendo `useNotificationCenter.ts` sotto il budget LOC monitorato;
- rimosso un `!important` ridondante da `mobile-table-groups-overrides.css` mantenendo invariata la copertura visuale.

File modificati:

- `mobile-frontend/src/pages/home/hooks/useNotificationCenter.ts`;
- `mobile-frontend/src/pages/home/hooks/notificationDedup.ts`;
- `mobile-frontend/tests/notificationCenterSession.test.tsx`;
- `mobile-frontend/public/assets/mobile-table-groups-overrides.css`;
- `MEMORIA_ARCHITETTURA_CONFIGURAZIONE.md`.

Test eseguiti:

- `npx vitest run tests/notificationCenterSession.test.tsx` OK, 1/1;
- `npm run typecheck` in `mobile-frontend` OK;
- `npx vitest run tests/notificationCenterSession.test.tsx tests/static/menuCategoriesNavigation.test.ts tests/static/menuNoHorizontalScroll.test.ts` OK, 5/5;
- `npx vitest run tests/frontendV2RuntimeContracts.test.ts tests/static/architectureRules.test.ts tests/static/tableMoveModalVisualParity.test.ts tests/static/reservationsMultiTable.test.ts` parziale: 23/24 OK, resta rosso solo il controllo LOC preesistente su file grandi non toccati;
- `node --test backend/tests/notifications-persistence.e2e.test.mjs` OK, 3/3;
- `npm run check:backend` OK;
- `npm run gate:architecture-security` OK, `server.js` 27493 righe.

Debito residuo osservato:

- `tests/static/architectureRules.test.ts` segnala ancora budget LOC superato per file gia' grandi:
  - `src/api/tables.ts`;
  - `src/pages/home/reservations/ReservationsWorkspace.tsx`;
  - `src/pages/home/tables/TablesWorkspace.tsx`;
  - `src/pages/payments/PaymentSettlementSection.tsx`;
  - `src/api/reservations.ts`;
  - `src/api/analyticsPaymentMovements.ts`.

Avanzamento stimato dopo Slice 16:

- piano complessivo stabilizzazione/configurazione: circa 76%;
- sotto-area notifiche/personale/postazioni: circa 90%.

Rischio residuo:

- il prossimo step consigliato e' iniziare una decomposizione piccola su uno dei file LOC offender, preferibilmente `src/api/analyticsPaymentMovements.ts` o `src/api/reservations.ts`, per rientrare gradualmente nel gate statico senza toccare pagamenti/fiscalita' core.

### 2026-06-03 - Slice 17, riduzione monolite backend notifiche record

Correzione/estrazione applicata:

- estratto dal monolite `backend/server.js` il dominio puro di normalizzazione record notifiche;
- nuovo modulo:
  - `backend/modules/notifications/notification-records.js`;
- funzioni spostate:
  - `normalizeIntegrationNotificationType`;
  - `sanitizeIntegrationNotification`;
  - `sanitizeIntegrationBellClaim`;
  - `getIntegrationRecentBellClaims`;
- `server.js` mantiene solo gli handler HTTP e le funzioni con side effect/stato (`findIntegrationBellClaim`, `upsertIntegrationBellClaim`, code/publish/ack);
- nessun endpoint modificato;
- nessun contratto API modificato;
- nessun flusso pagamenti/fiscalita'/stampa toccato.

Metriche:

- `backend/server.js` prima della slice: 27492 righe circa;
- `backend/server.js` dopo la slice: 27423/27424 righe secondo `wc`/gate;
- riduzione netta: circa 68-69 righe dal monolite;
- nuovo modulo: 82 righe.

File modificati:

- `cassa-frontend/backend/server.js`;
- `cassa-frontend/backend/modules/notifications/notification-records.js`;
- `cassa-frontend/backend/tests/notification-records.test.mjs`;
- `MEMORIA_ARCHITETTURA_CONFIGURAZIONE.md`.

Test eseguiti:

- `node --check backend/modules/notifications/notification-records.js` OK;
- `node --check backend/server.js` OK;
- `node --check backend/tests/notification-records.test.mjs` OK;
- `node --test backend/tests/notification-records.test.mjs backend/tests/notifications-persistence.e2e.test.mjs backend/tests/notifications-priority.e2e.test.mjs backend/tests/waiters-routing.e2e.test.mjs` OK, 9/9;
- `npm run check:backend` OK;
- `npm run gate:architecture-security` OK, `server.js` 27424 righe;
- `npm run audit:architecture-security` OK, finding bloccanti 0;
- `node --test backend/tests/route-policy-architecture.test.mjs` OK, 5/5.

Avanzamento stimato dopo Slice 17:

- piano complessivo stabilizzazione/configurazione: circa 77%;
- sotto-area decomposizione monolite backend: circa 18%;
- sotto-area notifiche/personale/postazioni: circa 91%.

Rischio residuo:

- `backend/server.js` resta molto grande;
- grandi funzioni ancora segnalate dall'audit:
  - `handlePaymentFreeSplit`;
  - `migrateDbSecurity`;
  - `validLineSelections`;
  - `handleIntegrationOrderComp`;
  - `handleIntegrationOrderSync`;
  - `handlePaymentMovementReprint`;
  - `sanitizeIntegrationOrder`;
  - `handleIntegrationOrderCreate`;
- prossimo step consigliato: estrarre un helper puro da `validLineSelections` oppure da `sanitizeIntegrationOrder`, evitando per ora handler pagamenti/fiscale.

### 2026-06-03 - Slice 18, riduzione monolite backend pagamenti split

Correzione/estrazione applicata:

- estratto dal monolite `backend/server.js` un primo dominio puro per split e selezioni pagamento;
- nuovo modulo:
  - `backend/modules/payments/payment-splits.js`;
- funzioni/costanti spostate:
  - `PAYMENT_SPLIT_TYPES`;
  - `normalizePaymentSplitType`;
  - `normalizePaymentContinuationSplitMode`;
  - `isAmountStylePaymentContinuationMode`;
  - `collectArticleUnitIdsFromPaymentItems`;
- aggiunta funzione pura dedicata:
  - `normalizePaymentLineSelections`;
- `handlePayTable()` ora usa `normalizePaymentLineSelections(payload.lineSelections)` invece del filtro inline;
- nessun endpoint modificato;
- nessun contratto API modificato;
- nessun flusso POS/fiscale/stampa modificato;
- nessun riavvio effettuato.

Controllo implementazioni mancanti:

- eseguito sweep testuale su `TODO`, `FIXME`, `not implemented`, `non implement`, `placeholder`, `mock`;
- non sono emersi fallback statici stanze nel runtime mobile:
  - `BUILTIN_FALLBACK_ROOMS` assente;
  - `DEFAULT_ROOM_ID` assente;
  - `sala_main`, `sala_terrazza`, `sala_privata`, `sala_eventi`, `sala_bar` assenti dal runtime mobile;
- i riferimenti `mock` residui risultano confinati a compatibilita' legacy, test/dev, menu demo opzionale o provider esplicitamente non-prod;
- il messaggio `Autorizzazione carta non implementata: terminale POS non configurato` resta presente come blocco sicuro quando il provider carta non e' configurato, non come lacuna del flusso POS attivo.

Metriche:

- `backend/server.js` prima della slice: 27423 righe (`wc -l`);
- `backend/server.js` dopo la slice: 27383 righe (`wc -l`), 27384 secondo gate statico;
- riduzione netta: circa 40 righe dal monolite;
- nuovo modulo: 67 righe.

File modificati:

- `cassa-frontend/backend/server.js`;
- `cassa-frontend/backend/modules/payments/payment-splits.js`;
- `cassa-frontend/backend/tests/payment-splits.test.mjs`;
- `MEMORIA_ARCHITETTURA_CONFIGURAZIONE.md`.

Test eseguiti:

- `node --check backend/modules/payments/payment-splits.js` OK;
- `node --check backend/tests/payment-splits.test.mjs` OK;
- `node --check backend/server.js` OK;
- `node --test backend/tests/payment-splits.test.mjs` OK, 5/5;
- `node --test backend/tests/payment-weird-cases.e2e.test.mjs` OK, 13/13;
- `node --test backend/tests/orders-payments-invariants.test.mjs` OK, 15/15;
- `npm run check:backend` OK;
- `npm run gate:architecture-security` OK, `server.js` 27384 righe, finding bloccanti 0;
- `npm run audit:architecture-security` OK, finding bloccanti 0;
- `node --test backend/tests/route-policy-architecture.test.mjs` OK, 5/5.

Avanzamento stimato dopo Slice 18:

- piano complessivo stabilizzazione/configurazione: circa 78%;
- sotto-area decomposizione monolite backend: circa 20%;
- sotto-area pagamenti/fiscalita' protetta dai test: stabile.

Rischio residuo:

- `backend/server.js` resta sopra 27k righe;
- le funzioni grandi restano prevalentemente handler con side effect (`handlePayTable`, `handlePaymentFreeSplit`, `handlePaymentMovementReprint`, ecc.);
- prossimo step consigliato: continuare con helper puri dentro `handlePayTable`/`handlePaymentFreeSplit` oppure estrarre state machine/normalizzatori ordini, evitando split massivi degli handler.

### 2026-06-04 - Sale reali Bar, Spiaggia e Terrazza

Correzione configurazione/runtime:

- aggiunte in app-state, tramite API settings, le sale reali `room_bar`, `room_spiaggia` e `room_terrazza`;
- le tre sale sono collegate a `activity_default` e non hanno `minimumTables`, quindi non generano tavoli mock;
- snapshot v2 verificato: i resolved context delle nuove sale ereditano fiscalita'/RT e stampanti dall'attivita', non dalla sala;
- aggiornati gruppo `acl_bar` e utenti correnti per abilitare/autorizzare le nuove sale;
- rimossi dal runtime gli ID specifici `sala_terrazza`/`sala_bar` usati per inferenza legacy:
  - `backend/server.js` ora deriva solo un ID generico `room_<slug>` dal tipo tavolo legacy;
  - `backend/modules/settings/settings.handlers.js` associa tavoli legacy alle sale solo tramite lookup dinamico sulle sale configurate;
  - `postazione/dist/assets/postazione-history-toggle-fix.js` non contiene piu' una mappa hardcoded di sale.

Debito tecnico:

- la postazione dispone solo del bundle `dist`; la modifica al bridge e' una patch runtime temporanea. Quando sara' disponibile una pipeline sorgente/build della postazione, spostare la logica in sorgente e rigenerare il dist.

Test/verifiche:

- `node --check backend/server.js` OK;
- `node --check backend/modules/settings/settings.handlers.js` OK;
- `node --check ../postazione/dist/assets/postazione-history-toggle-fix.js` OK;
- `node --test backend/tests/configuration-snapshot.test.mjs` OK, 6/6;
- `node --test backend/tests/configuration-save-contract.test.mjs` OK, 4/4;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs` OK, 7/7;
- `node --test frontend-tests/monitor-configuration-static.test.mjs` OK, 2/2;
- `node --test frontend-tests/postazione-bridges.test.mjs` non eseguito: dipendenza locale `jsdom` non disponibile nell'ambiente corrente.

### 2026-06-04 - Menu/listini nelle impostazioni e schedulazioni orarie

Correzione configurazione/backend:

- introdotto normalizzatore dedicato `backend/modules/menu/menu-configuration.js`;
- `posSettings` preserva e pubblica:
  - `menus`;
  - `priceLists`;
  - `priceListSchedules`;
  - `menuSchedules`;
  - `areaMenus` solo come compatibilita legacy;
- i prodotti del catalogo preservano campi operativi trovati/necessari:
  - IVA (`vatRate`/`iva`/`taxRate`);
  - `vatCode`;
  - prezzi per listino (`priceListPrices`);
  - postazioni abilitate (`workstationIds`, con compatibilita `stationIds`);
  - menu/categorie;
  - allergeni, tag, SKU, barcode, unita, reparto, ingredienti, descrizione, varianti;
- `handleIntegrationMenu` e `handleMenuCatalog` applicano i listini attivi lato backend e restituiscono `activePriceListIds`;
- lo snapshot v2 include menu/listini e risolve nei `resolvedContexts`:
  - menu/listini base dell'Attivita;
  - menu/listini temporizzati dell'Attivita;
  - menu/listini aggiuntivi della Sala;
  - menu/listini temporizzati della Sala.
- estratto `migrateDbSecurity` in `backend/modules/app-state/security-migration.js` per rispettare il budget del gate architetturale senza modificare la logica di migrazione.

Correzione UI impostazioni:

- la sezione Menu non e' piu solo una tabella prodotti:
  - lista Menu con categorie e prodotti assegnati;
  - lista Listini con prezzi per prodotto;
  - fasce orarie globali per cambio listino;
  - dettaglio prodotto con IVA, dati fiscali/prodotto, postazioni vendita e prezzi per listino;
- modale Attivita:
  - RT/API fiscale solo su Attivita;
  - menu/listini principali;
  - stampanti non fiscali;
  - postazioni;
  - cambio automatico menu/listini per giorno e orario;
- modale Sala:
  - personale;
  - menu/listini aggiuntivi;
  - stampanti non fiscali;
  - cambio automatico menu/listini per giorno e orario;
  - nessuna RT operativa nella Sala.

Debito tecnico:

- `settings-frontend` e' stato patchato direttamente in `dist/assets/settings-app.js` e `settings-app.css` perche' in workspace non sono presenti sorgenti/build del settings frontend;
- appena disponibili i sorgenti, ricostruire questa UI come codice sorgente mantenibile e rigenerare il dist;
- `areaMenus` rimane leggibile per migrazione, ma non deve guidare il modello target.

File modificati:

- `cassa-frontend/backend/server.js`;
- `cassa-frontend/backend/lib/pos-defaults.js`;
- `cassa-frontend/backend/modules/app-state/security-migration.js`;
- `cassa-frontend/backend/modules/menu/index.js`;
- `cassa-frontend/backend/modules/menu/menu-configuration.js`;
- `cassa-frontend/backend/modules/menu/menu.domain.js`;
- `cassa-frontend/backend/modules/menu/menu.handlers.js`;
- `cassa-frontend/backend/modules/settings/settings.handlers.js`;
- `cassa-frontend/backend/modules/configuration/operational-context.js`;
- `cassa-frontend/backend/modules/configuration/configuration-snapshot.js`;
- `cassa-frontend/backend/tests/configuration-snapshot.test.mjs`;
- `cassa-frontend/backend/tests/configuration-save-contract.test.mjs`;
- `settings-frontend/dist/assets/settings-app.js`;
- `settings-frontend/dist/assets/settings-app.css`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `MEMORIA_ARCHITETTURA_CONFIGURAZIONE.md`.

Test/verifiche:

- `node --check settings-frontend/dist/assets/settings-app.js` OK;
- `node --check backend/modules/menu/menu-configuration.js` OK;
- `node --check backend/modules/menu/menu.domain.js` OK;
- `node --check backend/modules/menu/menu.handlers.js` OK;
- `node --check backend/modules/configuration/operational-context.js` OK;
- `node --check backend/modules/configuration/configuration-snapshot.js` OK;
- `node --check backend/server.js` OK;
- `node --check backend/modules/app-state/security-migration.js` OK;
- `node --test --test-concurrency=1 backend/tests/configuration-snapshot.test.mjs` OK, 7/7;
- `node --test --test-concurrency=1 backend/tests/configuration-save-contract.test.mjs` OK, 4/4;
- `node --test --test-concurrency=1 backend/tests/settings-room-table-policy.e2e.test.mjs` OK, 4/4.
- `npm run check:backend` OK;
- `npm run gate:architecture-security` OK, `server.js` 27389 righe.

Avanzamento stimato:

- modello menu/listini impostazioni: circa 70%;
- snapshot/resolver menu/listini temporizzati: circa 80%;
- UI settings menu/listini in dist: circa 65%;
- consumo runtime mobile/postazione completo: ancora parziale.

### 2026-06-04 - Autosave impostazioni su DB

Correzione applicata:

- le modali del frontend impostazioni non salvano piu' solo nello stato locale della pagina;
- `Salva` nelle modali persiste subito sul backend:
  - Locale/Attivita/Sala/RT/Stampanti/Postazioni -> `/api/settings/pos/areas/save`;
  - Utenti/Gruppi ACL -> `/api/settings/pos/users/save`;
  - Prodotti/Menu/Listini/Fasce -> `/api/settings/menu`;
- modifiche inline e checkbox nelle sezioni impostazioni attivano autosave per dominio;
- aggiunte/rimozioni legacy di righe, cash point, postazioni sala, fasce e liste attivano autosave;
- eliminazione locale e gruppo ACL persiste subito sul DB dopo la conferma.

Verifica:

- `node --check settings-frontend/dist/assets/settings-app.js` OK;
- `node --test --test-concurrency=1 backend/tests/configuration-save-contract.test.mjs` OK, 4/4;
- `node --test --test-concurrency=1 backend/tests/configuration-snapshot.test.mjs backend/tests/settings-room-table-policy.e2e.test.mjs` OK, 11/11;
- `npm run check:backend` OK;
- `npm run gate:architecture-security` OK;
- verifica HTTP su `http://127.0.0.1:5180/impostazioni/assets/settings-app.js?v=20260506-rooms-menu-modals`: autosave presente.

Correzione cache/input successiva:

- `settings-frontend/dist/index.html` punta ora a `settings-app.js?v=20260604-settings-autosave-input`;
- `serve-frontends.mjs` serve tutti gli asset di `/impostazioni` con `Cache-Control: no-store`;
- gli input testuali inline con `data-path` schedulano autosave anche durante `input`, non solo su `change`/blur;
- server statico riavviato su porta 5180, PID 14152;
- verifica HTTP: HTML e JS di `/impostazioni` rispondono `no-store`, versione `20260604-settings-autosave-input`, autosave input presente.

Correzione salvataggio modale a singolo click:

- rimosso il `render()` dal ramo di successo del `change` su `data-modal-path`;
- motivo: quando un campo perde focus prima del click su `Salva`, il `change` veniva eseguito prima del click e sostituiva il DOM della modale, costringendo l'utente a premere `Salva` una seconda volta;
- versione asset aggiornata a `settings-app.js?v=20260604-modal-save-single-click-v2`;
- verifica HTTP: `changeSuccessHasRender=false`, guard comment presente, cache `no-store`;
- `node --check settings-frontend/dist/assets/settings-app.js` OK;
- `node --test --test-concurrency=1 backend/tests/configuration-save-contract.test.mjs` OK, 4/4.
