# Security handshake

La sicurezza BLE di link non è sufficiente.

Handshake applicativo:

```text
HELLO protocol/capabilities
challenge random
signature Ed25519 device key
certificate/registry validation
X25519 ephemeral exchange
HKDF session keys
AEAD encrypted frames
```

Android private key in Keystore. Raspberry device registry read-only per il processo Bluetooth.

## Provisioning B1

Il flusso amministrativo offline emette un token casuale monouso con scadenza.
Il payload QR v1 contiene soltanto `version`, `enrollmentEndpointId` tecnico e
token. Nel registry viene conservato solo l'hash SHA-256 domain-separated del
token.

Android genera una sola volta il proprio NodeId UUID canonico e la coppia
Ed25519 nel Keystore. L'enrollment richiede entrambi, valida la chiave pubblica
SPKI, conserva il NodeId proposto senza sostituirlo e lo restituisce identico
nella risposta. Il registry genera soltanto certificateId UUID e aliasKey
casuale da 32 byte. Il consumo del token e l'inserimento del device sono una
singola mutazione bloccata e atomica. Chiavi private Android non vengono
accettate ne archiviate.

L'aliasKey viene codificata come base64url senza padding e restituita solo nella
risposta iniziale da importare nel Keystore. Lookup pubblici, inventario e CLI
normale non la mostrano. Un eventuale enrollment via rete deve usare un canale
autenticato con TLS: token monouso e scadenza non sostituiscono la sicurezza del
trasporto.

Il registry e un file JSON versionato `0600`. Il processo Bluetooth futuro
potra leggerlo per autenticazione, ma non potra attivare enrollment runtime per
default. Contratti, libreria e procedura sono in:

```text
contracts/device-registry-v1.schema.json
contracts/enrollment-qr-v1.schema.json
shared/provisioning/
```

La unit systemd del nodo applica `ProtectSystem=strict` e un
`ReadOnlyPaths` esplicito sul registry di produzione. Il processo radio puo
quindi leggere le credenziali tecniche ma non emettere token, iscrivere,
revocare o riscrivere il file. L'eventuale override del percorso richiede un
aggiornamento equivalente della sandbox systemd prima dell'abilitazione.
