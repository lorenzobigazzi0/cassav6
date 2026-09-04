# Migrazioni PostgreSQL applicative

I file eseguibili devono usare il formato `NNN_nome.sql` e non devono contenere
`BEGIN`, `COMMIT` o `ROLLBACK`: la transazione e gestita dal migration runner.

La sequenza applicativa inizia con `001_foundation.sql` (MIG-020). Gli SQL
`DRAFT TARGET` della roadmap non vanno copiati o eseguiti direttamente: ogni
file deve prima essere convertito, revisionato e coperto da test.

Il proprietario DDL e `cassav6_migrator`. I privilegi DML applicativi vengono
concessi al ruolo tecnico senza login `cassav6_runtime`, ereditato dal login
configurato per il backend; non vengono concessi privilegi DDL al runtime.
