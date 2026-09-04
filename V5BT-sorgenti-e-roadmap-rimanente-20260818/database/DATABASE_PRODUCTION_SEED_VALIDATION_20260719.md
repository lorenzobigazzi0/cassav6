# Validazione seed produzione Cassa V5BT

Data: 2026-07-19

## Sorgente

- host: Raspberry `192.168.1.79`
- schema sorgente: `cassav4`
- database sorgente: MariaDB 11.8.6
- dump: `cassav5bt_production_seed_20260719.sql.gz`
- SHA-256:
  `9c1bcdd6095c669440a524987dc173874edd6186f64571eb98788f957ec613f8`
- dimensione compressa: 25.905.098 byte
- dimensione SQL: 236.058.013 byte

## Prova Di Ripristino

Il dump e stato importato in un'istanza MySQL 8.0.46 temporanea, inizializzata
in `/tmp`, con rete e binary log disabilitati. Non e stato usato ne modificato
il server MySQL di sistema.

Risultati:

- import terminato con codice `0`;
- 480 tabelle attese e 480 presenti;
- elenco tabelle identico al dump;
- 480 tabelle InnoDB, nessuna view;
- `mysqlcheck`: 480/480 `OK`;
- 121.187 righe;
- 5.015 colonne e 480 primary key;
- 320 vincoli `CHECK` applicati;
- nessun JSON non valido nei sei domini applicativi principali;
- nessun errore InnoDB, crash o corruzione.

Gli avvisi osservati riguardavano soltanto display width interi deprecati,
`DROP TABLE IF EXISTS` su schema vuoto e `DISABLE/ENABLE KEYS` ignorato da
InnoDB.

L'istanza temporanea e stata arrestata regolarmente e il datadir di prova e
stato rimosso.
