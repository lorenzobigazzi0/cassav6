-- MIG-040: identity users/userGroups su PostgreSQL, forma app-state.
--
-- Una tabella per collezione app-state. Le colonne promosse sono solo quelle su
-- cui il codice interroga o vincola; ogni altro campo del record vive in
-- `profile jsonb`, lossless. Il modello RBAC della bozza 010 (roles, permissions,
-- user_roles, role_permissions, user_group_members) NON viene adottato in questo
-- slice: ruoli e permessi restano costanti di codice (backend/auth/permissions.js).
-- Le sessioni sono di MIG-041 (migration 009).
--
-- Nessuna FK verso configuration (stanze, postazioni, metodi di pagamento):
-- quelle entita non esistono ancora in PostgreSQL (MIG-042). I riferimenti
-- restano id testuali dentro `profile`, esattamente come nell app-state.
--
-- Le invarianti che il codice puo dimenticare stanno qui:
--   (1) revision cresce se e solo se cambia il contenuto, per trigger;
--   (2) description di un gruppo, se c e, e una stringa di al piu 240 caratteri;
--   (3) una transazione non puo lasciare identity.users senza amministratori.
-- Le invarianti che dipendono da una funzione JavaScript restano nel codice e
-- sono misurate dai controlli di dati dell importer:
--   username_normalized = normalizeUsername(username) (backend/server.js:3347-3351)
--   row_hash            = sha256(canonicalJson(mask(record)))
-- Qui se ne vincola solo la FORMA. La ragione e scritta nei COMMENT.
--
-- Ogni CHECK nuovo ha un contatore gemello nel dry-run dell importer, perche un
-- rifiuto deve essere una riga di report e non un SQLSTATE a sorpresa.
--
-- Nessun BEGIN/COMMIT/ROLLBACK: li apre il runner (migrations.js:12, :142-151).
-- ATTENZIONE: quel pattern e /im e non sa cosa sia un commento SQL. In questo
-- file nessuna riga deve iniziare con BEGIN; START TRANSACTION; COMMIT; o
-- ROLLBACK; nemmeno dentro un commento o una stringa. Il BEGIN dei blocchi
-- plpgsql non e seguito da ';' e quindi e ammesso: precedente in esercizio
-- 007_ret01_retention_approval.sql:52-87, con BEGIN in colonna 0 a :57.

-- ---------------------------------------------------------------------------
-- 0. PRECONDIZIONI. Girano prima di creare qualunque cosa: se qualcosa non
--    torna, il runner esegue ROLLBACK (migrations.js:151) e la 010 non entra in
--    app_meta.schema_migrations. to_regclass ritorna NULL senza errore anche
--    quando lo schema non esiste (precedente: 006:83), quindi questo blocco sta
--    PRIMA di CREATE SCHEMA e non dopo.
-- ---------------------------------------------------------------------------
DO $precondizioni$
DECLARE
  intrusi text;
BEGIN
  SELECT string_agg(t, ', ' ORDER BY t) INTO intrusi
  FROM unnest(ARRAY[
    'identity.sessions',
    'identity.user_group_members',
    'identity.roles',
    'identity.permissions',
    'identity.user_roles',
    'identity.role_permissions'
  ]) AS t
  WHERE to_regclass(t) IS NOT NULL;

  IF intrusi IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'MIG-040: oggetti che non appartengono alla 010: ' || intrusi,
      DETAIL  = 'identity.sessions e di MIG-041 (migration 009). Il modello RBAC della bozza 010 (roles, permissions, user_roles, role_permissions) e user_group_members sono stati scartati: la 010 non prosegue su uno schema che contiene un modello di autorizzazione concorrente.',
      HINT    = 'Rimuovere quegli oggetti come cassav6_migrator, oppure fermare MIG-040 e chiarire chi li ha creati e perche.';
  END IF;

  SELECT string_agg(t, ', ' ORDER BY t) INTO intrusi
  FROM unnest(ARRAY['identity.users', 'identity.user_groups']) AS t
  WHERE to_regclass(t) IS NOT NULL;

  IF intrusi IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'MIG-040: relazioni identity gia presenti prima della 010: ' || intrusi,
      DETAIL  = 'La 010 e la prima migration che le crea; la 010 crea le tabelle, non le adotta. Se esistono sono nate fuori dal runner e il loro schema non e verificabile con un checksum.',
      HINT    = 'Verificare se la 010 e stata applicata a mano e, in tal caso, allineare app_meta.schema_migrations.';
  END IF;
END
$precondizioni$;

CREATE SCHEMA IF NOT EXISTS identity;

REVOKE ALL ON SCHEMA identity FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 1. identity.users
-- ---------------------------------------------------------------------------
CREATE TABLE identity.users (
  id                  text        PRIMARY KEY,
  username            text        NOT NULL,
  -- Colonna ORDINARIA, non GENERATED: lower(btrim(x)) non e
  -- String(x).trim().toLowerCase(). Vedi il COMMENT in fondo.
  username_normalized text        NOT NULL,
  -- Nullable per la fedelta del round-trip: NULL significa "chiave assente nel
  -- record legacy", e rowToUser ri-omette fullName.
  full_name           text,
  role                text        NOT NULL DEFAULT 'operator',
  pin_hash            text        NOT NULL DEFAULT '',
  profile             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  app_state_position  integer     NOT NULL DEFAULT 0,
  row_hash            text        NOT NULL,
  revision            bigint      NOT NULL DEFAULT 0,
  -- Nullable e SENZA default: un timestamp legacy presente ma non parsabile
  -- deve poter restare NULL, e NOT NULL DEFAULT now() lo renderebbe impossibile.
  created_at          timestamptz,
  updated_at          timestamptz,
  CONSTRAINT identity_users_id_not_blank
    CHECK (btrim(id) <> ''),
  -- Non aggiunge percorsi di rifiuto nuovi: uno username che btrim svuota
  -- normalizza a vuoto ed e gia errore duro dell importer.
  CONSTRAINT identity_users_username_not_blank
    CHECK (btrim(username) <> ''),
  CONSTRAINT identity_users_username_normalized_not_blank
    CHECK (btrim(username_normalized) <> ''),
  -- Idempotenza, non equivalenza: dice che il valore scritto e gia minuscolo e
  -- senza spazi ai bordi, cosa vera per ogni output di normalizeUsername. NON
  -- dice, e non puo dire, che derivi dallo username di questa riga.
  CONSTRAINT identity_users_username_normalized_shape
    CHECK (username_normalized = lower(btrim(username_normalized))),
  CONSTRAINT identity_users_role_allowed
    CHECK (role IN ('operator', 'responsabile', 'admin')),
  CONSTRAINT identity_users_pin_hash_never_plaintext
    CHECK (pin_hash = '' OR pin_hash LIKE 'scrypt$%'),
  CONSTRAINT identity_users_profile_is_object
    CHECK (jsonb_typeof(profile) = 'object'),
  CONSTRAINT identity_users_profile_without_secrets
    CHECK (NOT (profile ?| ARRAY['pin','plainPin','pinCode','password','passwordPlain','pinHash'])),
  -- row_hash e il perno del write-through incrementale: se fosse vuoto o un
  -- segnaposto, il confronto "row_hash uguale => nessuna UPDATE" salterebbe ogni
  -- scrittura e revision resterebbe ferma per sempre, senza alcun errore.
  CONSTRAINT identity_users_row_hash_is_sha256
    CHECK (row_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT identity_users_revision_non_negative
    CHECK (revision >= 0),
  CONSTRAINT identity_users_position_non_negative
    CHECK (app_state_position >= 0)
);

CREATE UNIQUE INDEX identity_users_username_normalized_key
  ON identity.users (username_normalized);

CREATE INDEX identity_users_position_idx
  ON identity.users (app_state_position, id);

-- Al servizio del trigger amministratore: rende il conteggio un index scan.
-- Il predicato e IDENTICO a quello della query nel trigger, altrimenti il
-- planner non puo usarlo.
CREATE INDEX identity_users_administrators_idx
  ON identity.users (id)
  WHERE role = 'admin' OR profile @> '{"permissions": ["manage_users"]}'::jsonb;

-- ---------------------------------------------------------------------------
-- 2. identity.user_groups
-- ---------------------------------------------------------------------------
CREATE TABLE identity.user_groups (
  id                 text        PRIMARY KEY,
  name               text        NOT NULL,
  active             boolean     NOT NULL DEFAULT true,
  profile            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  app_state_position integer     NOT NULL DEFAULT 0,
  row_hash           text        NOT NULL,
  revision           bigint      NOT NULL DEFAULT 0,
  -- I gruppi non hanno timestamp nell app-state: questi sono valori NUOVI e
  -- restano fuori dal confronto per record.
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_user_groups_id_not_blank
    CHECK (btrim(id) <> ''),
  CONSTRAINT identity_user_groups_name_not_blank
    CHECK (btrim(name) <> ''),
  -- Contratto completo. La forma a tre rami del progetto lasciava passare
  -- qualunque description NON stringa: e proprio il caso distruttivo, perche
  -- users.service.js:93 fa String(...).trim().slice(0,240) e quella funzione gira
  -- anche IN LETTURA (:19-21), quindi un oggetto diventa "[object Object]" e il
  -- primo users.save lo persiste cosi, cancellando l originale.
  CONSTRAINT identity_user_groups_description_bounded
    CHECK (
      NOT (profile ? 'description')
      OR (
        jsonb_typeof(profile -> 'description') = 'string'
        AND char_length(profile ->> 'description') <= 240
      )
    ),
  CONSTRAINT identity_user_groups_profile_is_object
    CHECK (jsonb_typeof(profile) = 'object'),
  -- Per simmetria con identity.users: un segreto nel profile di un GRUPPO non
  -- sarebbe trovato da nessun controllo scritto per il dominio utenti.
  CONSTRAINT identity_user_groups_profile_without_secrets
    CHECK (NOT (profile ?| ARRAY['pin','plainPin','pinCode','password','passwordPlain','pinHash'])),
  CONSTRAINT identity_user_groups_row_hash_is_sha256
    CHECK (row_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT identity_user_groups_revision_non_negative
    CHECK (revision >= 0),
  CONSTRAINT identity_user_groups_position_non_negative
    CHECK (app_state_position >= 0)
);

CREATE INDEX identity_user_groups_position_idx
  ON identity.user_groups (app_state_position, id);

-- ---------------------------------------------------------------------------
-- 3. revision: la possiede il database, non la query.
--    Il repository NON la mette nella SET; la usa solo nella WHERE come lock
--    ottimistico. Se qualcuno scrivesse comunque "revision = revision + 1"
--    seguendo 05_DATA_MODEL_AND_TRANSACTIONS.md:28-36, il trigger sovrascrive
--    il valore con lo stesso valore: la clausola diventa ridondante, mai +2.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION identity.bump_revision_on_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, identity
AS $function$
BEGIN
  -- Qualunque differenza che non sia la revision stessa e un cambio di
  -- contenuto. to_jsonb(NEW) e deliberato: un elenco esplicito di colonne
  -- andrebbe aggiornato a ogni ALTER TABLE, cioe sarebbe la stessa dimenticanza
  -- che questo trigger esiste per impedire.
  IF to_jsonb(NEW) - 'revision' IS DISTINCT FROM to_jsonb(OLD) - 'revision' THEN
    NEW.revision := OLD.revision + 1;
  ELSE
    NEW.revision := OLD.revision;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION identity.bump_revision_on_change() FROM PUBLIC;

-- Nessun trigger sull INSERT: COPY FROM esegue i trigger di riga su INSERT, e un
-- BEFORE INSERT che forzasse revision := 0 azzererebbe le revisioni di un
-- restore logico (verify-postgresql-logical-restore.sh, MIG-014).
CREATE TRIGGER identity_users_bump_revision
  BEFORE UPDATE ON identity.users
  FOR EACH ROW
  EXECUTE FUNCTION identity.bump_revision_on_change();

CREATE TRIGGER identity_user_groups_bump_revision
  BEFORE UPDATE ON identity.user_groups
  FOR EACH ROW
  EXECUTE FUNCTION identity.bump_revision_on_change();

-- ---------------------------------------------------------------------------
-- 4. Mai zero amministratori. Differito al commit, altrimenti un import che
--    inserisce prima un operatore e poi l amministratore fallirebbe sulla prima
--    riga (precedente: 004:149-153).
--    AFTER UPDATE OR DELETE e non anche INSERT: un INSERT non puo ridurre il
--    conteggio, e includerlo pagherebbe un count(*) per riga proprio sull unica
--    operazione che ne inserisce molte, cioe l import.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION identity.require_surviving_administrator()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, identity
AS $function$
DECLARE
  amministratori integer;
BEGIN
  -- Contenimento sull oggetto intero, non su profile -> 'permissions': la forma
  -- con la freccia restituisce NULL quando la chiave manca, e la chiave che
  -- manca e un caso legittimo e significativo del modello.
  SELECT count(*) INTO amministratori
  FROM identity.users
  WHERE role = 'admin'
     OR profile @> '{"permissions": ["manage_users"]}'::jsonb;

  IF amministratori = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'identity.users: la transazione lascerebbe zero amministratori',
      DETAIL  = 'Amministratore = role admin oppure manage_users fra i permessi: la stessa definizione di hasAdministrativeUser (backend/server.js:17097-17107). Senza, il login risponde 503 e non esiste via di rientro, perche scripts/create-admin.mjs scrive solo json o sqlite.',
      HINT    = 'Il rollback totale dell import si esegue come proprietario delle tabelle disabilitando esplicitamente questo trigger.';
  END IF;

  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION identity.require_surviving_administrator() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER identity_users_require_administrator
  AFTER UPDATE OR DELETE ON identity.users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION identity.require_surviving_administrator();

-- ---------------------------------------------------------------------------
-- 5. Privilegi. Deroga circoscritta: DELETE al runtime sulle sole due tabelle
--    identity, perche la cancellazione di un utente e un operazione di runtime
--    ordinaria (users.save sostituisce l array intero e la cancellazione e l
--    assenza dall array). Nessun TRUNCATE, che aggirerebbe i trigger di riga;
--    nessun TRIGGER, che permetterebbe al runtime di disattivare il guardiano;
--    nessun CREATE sullo schema; niente concesso direttamente a cassav6_app,
--    che eredita per INHERIT da cassav6_runtime.
--    EXECUTE sulle due funzioni di trigger NON si concede: il privilegio si
--    verifica alla CREATE TRIGGER, non a ogni esecuzione (precedente in
--    esercizio: 004:141-142 con :144-147 e :156).
-- ---------------------------------------------------------------------------
REVOKE ALL ON identity.users       FROM PUBLIC;
REVOKE ALL ON identity.user_groups FROM PUBLIC;

GRANT USAGE ON SCHEMA identity TO cassav6_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.users       TO cassav6_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.user_groups TO cassav6_runtime;

-- ---------------------------------------------------------------------------
-- 6. Commenti: sono il contratto per chi apre \d+ e non ha questo documento.
-- ---------------------------------------------------------------------------
COMMENT ON SCHEMA identity IS
  'Identity: utenti e gruppi (MIG-040). Sessioni in MIG-041 (009). Ruoli e permessi restano costanti di codice (backend/auth/permissions.js): niente roles/permissions/role_permissions, e la 010 rifiuta di applicarsi se qualcuno li ha creati.';

COMMENT ON TABLE identity.users IS
  'Un record per utente app-state. profile contiene i campi non promossi a colonna, senza segreti. L appartenenza ai gruppi resta in profile.groupIds: non esiste user_group_members.';
COMMENT ON TABLE identity.user_groups IS
  'Un record per gruppo app-state. profile.description ha un contratto di schema (stringa <= 240 caratteri) perche il runtime, per qualunque altro tipo, la distrugge convertendola con String(): users.service.js:93, applicata sia in scrittura sia in lettura (:19-21).';

COMMENT ON COLUMN identity.users.username_normalized IS
  'Chiave di login unica. Valore prodotto dal CODICE con normalizeUsername (backend/server.js:3347-3351 = String(v).trim().toLowerCase()), NON da una colonna GENERATED: lower(btrim(x)) rimuove il solo U+0020 e dipende dalla collation, quindi divergerebbe da trim()/toLowerCase() su tab, NBSP, U+FEFF e maiuscole non ASCII, e schema e codice direbbero cose opposte su chi e questo utente. I CHECK qui verificano la FORMA, non la derivazione da username: quella la verifica il controllo di dati normalization_drift dell importer, a fine --apply e al boot. Chi scrive a mano da psql DEVE ricalcolarla.';
COMMENT ON COLUMN identity.users.full_name IS
  'NULL significa chiave assente nel record legacy: rowToUser ri-omette fullName. Una stringa vuota significa che il legacy aveva davvero "".';
COMMENT ON COLUMN identity.users.profile IS
  'Record app-state meno id/username/fullName/role/pinHash/createdAt/updatedAt. Lossless: nessun campo sconosciuto viene scartato. Include gli alias legacy vivi, fra cui pauseSettings (letto da waiter-pauses.js:19-20 quando waiterPauseSettings manca) e i tre alias di notificationPriorities.';
COMMENT ON COLUMN identity.users.pin_hash IS
  'scrypt$N$r$p$saltHex$hashHex (backend/auth/password.js:10-19). Copiato verbatim dal legacy, mai ricalcolato, mai stampato, mai in un report. Stringa vuota = utente senza PIN, lecito.';
COMMENT ON COLUMN identity.users.row_hash IS
  'sha256 esadecimale minuscolo del record app-state CANONICALIZZATO (chiavi ordinate, pinHash sostituito dal fingerprint). Non contiene l ordine di emissione originale: non dedurlo da qui. Il CHECK garantisce la forma, non il contenuto: la coerenza con il record la verifica il --verify dell importer. Chi modifica una riga fuori dal repository DEVE ricalcolarlo.';
COMMENT ON COLUMN identity.users.revision IS
  'Concorrenza ottimistica. La scrive il trigger identity_users_bump_revision, non il repository: il repository la usa solo nella WHERE (id = $1 AND revision = $N), e 0 righe aggiornate significa conflitto -> 409. Un UPDATE che non cambia altro non consuma revisioni. updated_at nella SET deve venire dal record, mai da now(), altrimenti ogni UPDATE sembra un cambio di contenuto.';
COMMENT ON COLUMN identity.users.app_state_position IS
  'Posizione originale nell array app-state: conserva l ordine per il round-trip e per i confronti di equivalenza.';
COMMENT ON COLUMN identity.user_groups.row_hash IS
  'Come identity.users.row_hash. Attenzione: created_at e updated_at dei gruppi sono valori NUOVI (l app-state non li ha) e restano fuori dal confronto per record.';

COMMENT ON FUNCTION identity.bump_revision_on_change() IS
  'MIG-040: revision +1 se e solo se cambia qualcosa che non sia revision. to_jsonb(NEW) e deliberato: un elenco di colonne andrebbe aggiornato a ogni ALTER TABLE, cioe sarebbe la dimenticanza che questo trigger impedisce. Prova D26: togliere il trigger da una copia della 010 deve far diventare rosso il test del conflitto di revisione.';
COMMENT ON FUNCTION identity.require_surviving_administrator() IS
  'MIG-040: differito al commit, cosi un import che inserisce prima un operatore e poi l amministratore non fallisce sulla prima riga. Non e armato sull INSERT perche un INSERT non puo ridurre il conteggio. TRUNCATE aggira i trigger di riga: il boot verifica comunque admin_count >= 1.';

-- ---------------------------------------------------------------------------
-- 7. POSTCONDIZIONI TRANSAZIONALI. Stanno qui e non in mig040-postconditions.sql:
--    quel file gira da psql DOPO il COMMIT del runner e dopo l INSERT in
--    app_meta.schema_migrations (migrations.js:145-149), quindi un suo
--    fallimento e rilevato ma NON annulla la migration. Fuori restano solo le
--    verifiche informative.
--    I vincoli si asseriscono PER NOME e non per conteggio: un numero non dice
--    quale manca, si rompe se un altra migration aggiunge un CHECK, e in
--    PostgreSQL 18 i NOT NULL entrano in pg_constraint.
-- ---------------------------------------------------------------------------
DO $postcondizioni$
DECLARE
  mancanti text;
  n integer;
BEGIN
  SELECT string_agg(t, ', ' ORDER BY t) INTO mancanti
  FROM unnest(ARRAY['identity.users','identity.user_groups']) AS t
  WHERE to_regclass(t) IS NULL;
  IF mancanti IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'MIG-040: tabelle mancanti dopo la 010: ' || mancanti;
  END IF;

  -- L indice vive nello schema identity: va qualificato, altrimenti to_regclass
  -- lo cerca nel search_path e ritorna NULL anche quando esiste.
  SELECT string_agg(t, ', ' ORDER BY t) INTO mancanti
  FROM unnest(ARRAY[
    'identity.identity_users_username_normalized_key',
    'identity.identity_users_position_idx',
    'identity.identity_users_administrators_idx',
    'identity.identity_user_groups_position_idx'
  ]) AS t
  WHERE to_regclass(t) IS NULL;
  IF mancanti IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'MIG-040: indici mancanti dopo la 010: ' || mancanti;
  END IF;

  SELECT string_agg(t, ', ' ORDER BY t) INTO mancanti
  FROM unnest(ARRAY[
    'identity_users_id_not_blank',
    'identity_users_username_not_blank',
    'identity_users_username_normalized_not_blank',
    'identity_users_username_normalized_shape',
    'identity_users_role_allowed',
    'identity_users_pin_hash_never_plaintext',
    'identity_users_profile_is_object',
    'identity_users_profile_without_secrets',
    'identity_users_row_hash_is_sha256',
    'identity_users_revision_non_negative',
    'identity_users_position_non_negative',
    'identity_user_groups_id_not_blank',
    'identity_user_groups_name_not_blank',
    'identity_user_groups_description_bounded',
    'identity_user_groups_profile_is_object',
    'identity_user_groups_profile_without_secrets',
    'identity_user_groups_row_hash_is_sha256',
    'identity_user_groups_revision_non_negative',
    'identity_user_groups_position_non_negative'
  ]) AS t
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_constraint pc
    JOIN pg_namespace pn ON pn.oid = pc.connamespace
    WHERE pn.nspname = 'identity' AND pc.conname = t AND pc.contype = 'c'
  );
  IF mancanti IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'MIG-040: CHECK mancanti su identity: ' || mancanti;
  END IF;

  SELECT string_agg(t, ', ' ORDER BY t) INTO mancanti
  FROM unnest(ARRAY[
    'identity_users_bump_revision',
    'identity_user_groups_bump_revision',
    'identity_users_require_administrator'
  ]) AS t
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_trigger tg
    JOIN pg_class cl ON cl.oid = tg.tgrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    WHERE ns.nspname = 'identity' AND tg.tgname = t AND NOT tg.tgisinternal
  );
  IF mancanti IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'MIG-040: trigger mancanti su identity: ' || mancanti;
  END IF;

  -- Quattro verifiche separate in AND: has_table_privilege con la stringa
  -- 'SELECT,INSERT,UPDATE,DELETE' ha semantica OR e passerebbe con il solo SELECT.
  IF NOT (
    has_table_privilege('cassav6_runtime', 'identity.users', 'SELECT')
    AND has_table_privilege('cassav6_runtime', 'identity.users', 'INSERT')
    AND has_table_privilege('cassav6_runtime', 'identity.users', 'UPDATE')
    AND has_table_privilege('cassav6_runtime', 'identity.users', 'DELETE')
    AND has_table_privilege('cassav6_runtime', 'identity.user_groups', 'SELECT')
    AND has_table_privilege('cassav6_runtime', 'identity.user_groups', 'INSERT')
    AND has_table_privilege('cassav6_runtime', 'identity.user_groups', 'UPDATE')
    AND has_table_privilege('cassav6_runtime', 'identity.user_groups', 'DELETE')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'MIG-040: grant runtime incompleti sulle tabelle identity';
  END IF;

  IF has_table_privilege('cassav6_runtime', 'identity.users', 'TRUNCATE')
     OR has_table_privilege('cassav6_runtime', 'identity.user_groups', 'TRUNCATE')
     OR has_table_privilege('cassav6_runtime', 'identity.users', 'TRIGGER')
     OR has_table_privilege('cassav6_runtime', 'identity.user_groups', 'TRIGGER') THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'MIG-040: il ruolo runtime non deve avere TRUNCATE ne TRIGGER su identity: aggirerebbe i guardiani della 010';
  END IF;

  IF has_schema_privilege('cassav6_runtime', 'identity', 'CREATE') THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'MIG-040: il ruolo runtime non deve avere CREATE sullo schema identity';
  END IF;

  -- PUBLIC non e interrogabile con has_table_privilege.
  SELECT count(*) INTO n
  FROM information_schema.role_table_grants
  WHERE grantee = 'PUBLIC' AND table_schema = 'identity';
  IF n <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'MIG-040: PUBLIC ha privilegi sulle tabelle identity';
  END IF;
END
$postcondizioni$;


