#!/usr/bin/env bash
set -Eeuo pipefail

export LC_ALL=C
export TZ=UTC
umask 077

SCRIPT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SOURCE_ROOT_ARG="$SCRIPT_ROOT"
OUTPUT=""
SIDECAR=""
LIST_ONLY=0
ARCHIVE_ROOT="v6"
MANIFEST_NAME="V6_PACKAGE_MANIFEST.tsv"
FIXED_TIMESTAMP="202608200000.00"

usage() {
  cat <<'EOF'
Uso: tools/create-v6-package.sh [--list-only] [--source-root DIR] [--output FILE.zip]

Senza --output costruisce e verifica un archivio temporaneo senza pubblicarlo.
Con --output pubblica ZIP e sidecar .sha256 atomici, 0600 e no-clobber.
La radice interna e sempre v6/ e il timestamp e fissato al 202608200000.00.
EOF
}

fail() {
  printf 'ERRORE: %s\n' "$*" >&2
  exit 1
}

has_control_character() {
  local value="$1"
  [[ "$value" =~ [[:cntrl:]] ]]
}

has_parent_traversal() {
  local value="${1//\\//}"
  case "/$value/" in
    */../*) return 0 ;;
  esac
  return 1
}

while (($# > 0)); do
  case "$1" in
    --list-only)
      LIST_ONLY=1
      shift
      ;;
    --source-root)
      (($# >= 2)) || { echo "--source-root richiede un percorso" >&2; exit 2; }
      SOURCE_ROOT_ARG="$2"
      shift 2
      ;;
    --output)
      (($# >= 2)) || { echo "--output richiede un percorso" >&2; exit 2; }
      OUTPUT="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Argomento non riconosciuto: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

has_control_character "$SOURCE_ROOT_ARG" && { echo "Carattere di controllo in --source-root" >&2; exit 2; }
has_parent_traversal "$SOURCE_ROOT_ARG" && { echo "Traversal non ammesso in --source-root" >&2; exit 2; }
[[ -d "$SOURCE_ROOT_ARG" && ! -L "$SOURCE_ROOT_ARG" ]] || fail "source root non valida"
SOURCE_ROOT="$(cd -- "$SOURCE_ROOT_ARG" && pwd -P)"

if [[ -n "$OUTPUT" ]]; then
  ((LIST_ONLY == 0)) || { echo "--list-only e --output sono incompatibili" >&2; exit 2; }
  has_control_character "$OUTPUT" && { echo "Carattere di controllo in --output" >&2; exit 2; }
  has_parent_traversal "$OUTPUT" && { echo "Traversal non ammesso in --output" >&2; exit 2; }
  [[ "$OUTPUT" == *.zip ]] || { echo "L'output deve terminare con .zip" >&2; exit 2; }
  if [[ "$OUTPUT" != /* ]]; then
    OUTPUT="$PWD/$OUTPUT"
  fi
  output_parent_arg="$(dirname -- "$OUTPUT")"
  output_basename="$(basename -- "$OUTPUT")"
  [[ -d "$output_parent_arg" && ! -L "$output_parent_arg" ]] || fail "directory output non valida"
  output_parent="$(cd -- "$output_parent_arg" && pwd -P)"
  OUTPUT="$output_parent/$output_basename"
  SIDECAR="$OUTPUT.sha256"
  case "$OUTPUT" in
    "$SOURCE_ROOT"|"$SOURCE_ROOT"/*) fail "l'output non puo essere interno alla source root" ;;
  esac
  [[ ! -e "$OUTPUT" && ! -L "$OUTPUT" ]] || fail "output gia esistente: $OUTPUT"
  [[ ! -e "$SIDECAR" && ! -L "$SIDECAR" ]] || fail "sidecar gia esistente: $SIDECAR"
fi

INCLUDE_DIRECTORIES=(
  APPLICATIVI
  DOCUMENTAZIONE
  ROADMAP_BLUETOOTH
  ROADMAP_V6
  SORGENTE_SISTEMA
  database
  deploy
  scripts
  tests
  tools
)

ACTIVE_ROOT_FILES=(
  CONTENUTO_PACCHETTO.md
  HANDOFF_V6_20260820.md
  LEGGIMI.md
  README_V6.md
  V6_BOOTSTRAP_MANIFEST.tsv
  V6_BOOTSTRAP_MANIFEST.tsv.sha256
  V6_BOOTSTRAP_PROVENANCE.md
  hardware.env.example
  start-v6.sh
  stop-v6.sh
)

LEGACY_ROOT_FILES=(
  HANDOFF_V5BT_20260724.md
  README_V5BT.md
  V5BT_SOURCE_ARCHIVE_INFO.txt
  V5BT_SOURCE_MANIFEST.tsv
)

APPROVED_TLS_FIXTURES=(
  APPLICATIVI/Palmare/android-app/app/src/test/resources/tls/tls-server-valid.p12
  APPLICATIVI/Palmare/android-app/app/src/test/resources/tls/tls-server-expired.p12
  APPLICATIVI/Postazione/android-app/app/src/test/resources/tls/tls-server-valid.p12
  APPLICATIVI/Postazione/android-app/app/src/test/resources/tls/tls-server-expired.p12
)

APPROVED_DIST_PREFIXES=(
  SORGENTE_SISTEMA/battery-dashboard/dist/
  SORGENTE_SISTEMA/cassa-frontend/dist/
  SORGENTE_SISTEMA/mobile-frontend/dist/
  SORGENTE_SISTEMA/monitor-frontend/dist/
  SORGENTE_SISTEMA/postazione/dist/
  SORGENTE_SISTEMA/reservation-frontend/dist/
  SORGENTE_SISTEMA/settings-frontend/dist/
)

is_named_value() {
  local candidate="$1"
  shift
  local value
  for value in "$@"; do
    [[ "$candidate" == "$value" ]] && return 0
  done
  return 1
}

is_approved_dist() {
  local relative="$1" prefix
  for prefix in "${APPROVED_DIST_PREFIXES[@]}"; do
    [[ "$relative" == "$prefix"* ]] && return 0
  done
  return 1
}

is_ignored_generated_path() {
  local relative="$1"
  local lower="${relative,,}"

  is_approved_dist "$relative" && return 1
  case "/$lower/" in
    */.git/*|*/.gradle/*|*/.idea/*|*/.print-spool/*|*/.cache/*|*/.dart_tool/*|*/.expo/*|*/.mypy_cache/*|*/.next/*|*/.nuxt/*|*/.parcel-cache/*|*/.pytest_cache/*|*/.svelte-kit/*|*/.turbo/*|*/.vite/*|*/__pycache__/*|*/build/*|*/cache/*|*/caches/*|*/coverage/*|*/dist/*|*/log/*|*/logs/*|*/node_modules/*|*/out/*|*/p4-results/*|*/snapshots/*|*/target/*|*/temp/*|*/tmp/*)
      return 0
      ;;
  esac
  case "$lower" in
    applicativi/palmare/android-app/app/src/main/assets/mobile/*|applicativi/postazione/android-app/app/src/main/assets/postazione/*)
      return 0
      ;;
    *apk*sha256sums*|*aab*sha256sums*|*.aab|*.aab.sha256|*.aar|*.apk|*.apk.sha256|*.class|*.dex|*.log|*.log.*|*.pyc|*.pyo|*.shm|*.so|*.tsbuildinfo|*.wal|*.zip|*.zip.sha256)
      return 0
      ;;
  esac
  return 1
}

is_secret_path() {
  local relative="$1"
  local lower="${relative,,}"
  local basename="${lower##*/}"

  is_named_value "$relative" "${APPROVED_TLS_FIXTURES[@]}" && return 1
  case "/$lower/" in
    */.cassav6-private/*|*/.credentials/*|*/.keys/*|*/.private/*|*/.registry/*|*/.runtime/*|*/.secrets/*|*/.v5bt-private/*|*/.v6-private/*|*/cert/*|*/certificates/*|*/certs/*|*/credentials/*|*/keys/*|*/keystore/*|*/private/*|*/registry/*|*/secrets/*)
      return 0
      ;;
  esac
  case "$basename" in
    .env.example|hardware.env.example) return 1 ;;
    .env|.env.*|.netrc|.npmrc|.pypirc|authorized_keys|cassav6.env|credentials.json|credentials.yaml|credentials.yml|device-registry.json|hardware.env|id_dsa|id_ecdsa|id_ed25519|id_rsa|key.properties|keystore.properties|known_hosts|local.properties|registry.json|secrets.json|secrets.yaml|secrets.yml|service-account*.json|tokens.json|v5bt.env|v6.env)
      return 0
      ;;
  esac
  case "$lower" in
    *.age|*.asc|*.crt|*.cer|*.csr|*.der|*.gpg|*.jks|*.kdb|*.kdbx|*.key|*.keystore|*.mobileprovision|*.ovpn|*.p12|*.pem|*.pfx|*.pgp|*.ppk|*.private-key|*.provisionprofile|*.pub|*.secret)
      return 0
      ;;
  esac
  return 1
}

is_approved_binary_exception() {
  local relative="$1"
  case "${relative,,}" in
    */gradle/wrapper/gradle-wrapper.jar) return 0 ;;
  esac
  is_named_value "$relative" "${APPROVED_TLS_FIXTURES[@]}"
}

GENERATED_DIRECTORY_NAMES=(
  .git
  .gradle
  .idea
  .print-spool
  .cache
  .dart_tool
  .expo
  .mypy_cache
  .next
  .nuxt
  .parcel-cache
  .pytest_cache
  .svelte-kit
  .turbo
  .vite
  __pycache__
  build
  cache
  caches
  coverage
  dist
  log
  logs
  node_modules
  out
  p4-results
  snapshots
  target
  temp
  tmp
)

GENERATED_FIND_PRUNE=('(' -type d '(')
for generated_name in "${GENERATED_DIRECTORY_NAMES[@]}"; do
  ((${#GENERATED_FIND_PRUNE[@]} > 4)) && GENERATED_FIND_PRUNE+=(-o)
  GENERATED_FIND_PRUNE+=(-iname "$generated_name")
done
GENERATED_FIND_PRUNE+=(')' -prune ')' -o)

canonical_mode() {
  local absolute="$1"
  local source_mode
  source_mode="$(stat -c '%a' -- "$absolute")"
  if (( (8#$source_mode & 8#111) != 0 )); then
    printf '0755\n'
  elif [[ "$source_mode" == 600 ]]; then
    printf '0600\n'
  else
    printf '0644\n'
  fi
}

write_inventory() {
  local inventory_root="$1"
  local inventory_list="$2"
  local inventory_output="$3"
  local inventory_label="$4"
  local absolute after_identity after_size before_identity digest mode relative size

  : > "$inventory_output"
  while IFS= read -r relative; do
    absolute="$inventory_root/$relative"
    [[ -f "$absolute" && ! -L "$absolute" ]] || fail "$inventory_label non regolare: $relative"
    before_identity="$(stat -c '%d:%i' -- "$absolute")"
    mode="$(canonical_mode "$absolute")"
    size="$(stat -c '%s' -- "$absolute")"
    digest="$(sha256sum -- "$absolute" | cut -d' ' -f1)"
    [[ -f "$absolute" && ! -L "$absolute" ]] || fail "$inventory_label mutato: $relative"
    after_identity="$(stat -c '%d:%i' -- "$absolute")"
    after_size="$(stat -c '%s' -- "$absolute")"
    [[ "$after_identity" == "$before_identity" && "$after_size" == "$size" ]] || fail "$inventory_label mutato: $relative"
    printf '%s\t%s\t%s\t%s\n' "$mode" "$size" "$digest" "$relative" >> "$inventory_output"
  done < "$inventory_list"
}

temporary=""
publish_directory=""
published_archive_identity=""
published_sidecar_identity=""
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$published_archive_identity" && -f "$OUTPUT" && ! -L "$OUTPUT" ]]; then
    [[ "$(stat -c '%d:%i' -- "$OUTPUT" 2>/dev/null || true)" != "$published_archive_identity" ]] || unlink -- "$OUTPUT" 2>/dev/null || true
  fi
  if [[ -n "$published_sidecar_identity" && -f "$SIDECAR" && ! -L "$SIDECAR" ]]; then
    [[ "$(stat -c '%d:%i' -- "$SIDECAR" 2>/dev/null || true)" != "$published_sidecar_identity" ]] || unlink -- "$SIDECAR" 2>/dev/null || true
  fi
  if [[ -n "$publish_directory" && -d "$publish_directory" && ! -L "$publish_directory" ]]; then
    find "$publish_directory" -xdev -depth -delete 2>/dev/null || true
  fi
  if [[ -n "$temporary" && -d "$temporary" && ! -L "$temporary" ]]; then
    chmod -R u+rwX -- "$temporary" 2>/dev/null || true
    find "$temporary" -xdev -depth -delete 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT

temporary="$(mktemp -d)"
chmod 0700 "$temporary"
raw_list="$temporary/raw-files.bin"
file_list="$temporary/source-files.txt"
: > "$raw_list"

for relative in "${INCLUDE_DIRECTORIES[@]}"; do
  [[ -d "$SOURCE_ROOT/$relative" && ! -L "$SOURCE_ROOT/$relative" ]] || fail "directory allowlist assente o non regolare: $relative"
  find "$SOURCE_ROOT/$relative" -mindepth 1 "${GENERATED_FIND_PRUNE[@]}" ! -type d -print0 >> "$raw_list"
done

for prefix in "${APPROVED_DIST_PREFIXES[@]}"; do
  approved_dist="$SOURCE_ROOT/${prefix%/}"
  [[ -e "$approved_dist" || -L "$approved_dist" ]] || continue
  [[ -d "$approved_dist" && ! -L "$approved_dist" ]] || fail "dist approvata non regolare: ${prefix%/}"
  find "$approved_dist" -mindepth 1 ! -type d -print0 >> "$raw_list"
done

for relative in "${ACTIVE_ROOT_FILES[@]}" "${LEGACY_ROOT_FILES[@]}"; do
  [[ -f "$SOURCE_ROOT/$relative" && ! -L "$SOURCE_ROOT/$relative" ]] || fail "file root allowlist assente o non regolare: $relative"
  printf '%s\0' "$SOURCE_ROOT/$relative" >> "$raw_list"
done

while IFS= read -r -d '' top_entry; do
  top_name="${top_entry#"$SOURCE_ROOT/"}"
  has_control_character "$top_name" && fail "carattere di controllo in una voce root"
  has_parent_traversal "$top_name" && fail "traversal in una voce root"
  [[ "$top_name" != *\\* ]] || fail "voce root non portabile"
  if [[ -d "$top_entry" && ! -L "$top_entry" ]]; then
    is_named_value "$top_name" "${INCLUDE_DIRECTORIES[@]}" || fail "directory root fuori allowlist: $top_name"
  elif [[ -f "$top_entry" && ! -L "$top_entry" ]]; then
    is_named_value "$top_name" "${ACTIVE_ROOT_FILES[@]}" "${LEGACY_ROOT_FILES[@]}" || fail "file root fuori allowlist: $top_name"
  else
    fail "voce root non regolare: $top_name"
  fi
done < <(find "$SOURCE_ROOT" -mindepth 1 -maxdepth 1 -print0)

for relative in "${INCLUDE_DIRECTORIES[@]}"; do
  while IFS= read -r -d '' directory; do
    directory_relative="${directory#"$SOURCE_ROOT/"}"
    has_control_character "$directory_relative" && fail "carattere di controllo in una directory sorgente"
    has_parent_traversal "$directory_relative" && fail "traversal in una directory sorgente"
    [[ "$directory_relative" != *\\* ]] || fail "directory sorgente non portabile"
    is_secret_path "$directory_relative/marker" && fail "directory sensibile non ammessa: $directory_relative"
  done < <(find "$SOURCE_ROOT/$relative" "${GENERATED_FIND_PRUNE[@]}" -type d -print0)
done

while IFS= read -r -d '' absolute; do
  relative="${absolute#"$SOURCE_ROOT/"}"
  [[ "$relative" != "$absolute" && -n "$relative" ]] || fail "percorso esterno alla source root"
  has_control_character "$relative" && fail "carattere di controllo nel percorso sorgente"
  has_parent_traversal "$relative" && fail "traversal nel percorso sorgente"
  [[ "$relative" != /* && "$relative" != *\\* ]] || fail "percorso sorgente non portabile: $relative"

  is_ignored_generated_path "$relative" && continue
  is_secret_path "$relative" && fail "percorso sensibile non ammesso: $relative"
  [[ -f "$absolute" && ! -L "$absolute" ]] || fail "symlink o file speciale non ammesso: $relative"

  lower="${relative,,}"
  case "$lower" in
    *.db|*.db-*|*.gz|*.jar|*.sqlite|*.sqlite-*|*.sqlite3|*.sqlite3-*|*.tar|*.tar.*|*.tgz|*.xz|*.zst|*.7z)
      is_approved_binary_exception "$relative" || fail "binario fuori allowlist: $relative"
      ;;
  esac

  if LC_ALL=C grep -aEq -- '-----BEGIN ([A-Z ]+ )?PRIVATE KEY-----' "$absolute"; then
    fail "marker di chiave privata non ammesso: $relative"
  fi
  printf '%s\n' "$relative"
done < "$raw_list" | LC_ALL=C sort -u > "$file_list"

[[ -s "$file_list" ]] || fail "allowlist vuota"

if ((LIST_ONLY)); then
  cat "$file_list"
  exit 0
fi

for command_name in cmp find grep mktemp mv readlink rmdir rsync sha256sum stat touch unzip zip; do
  command -v "$command_name" >/dev/null || fail "comando richiesto non trovato: $command_name"
done

source_snapshot="$temporary/source-snapshot.tsv"
write_inventory "$SOURCE_ROOT" "$file_list" "$source_snapshot" "file sorgente"

stage="$temporary/$ARCHIVE_ROOT"
mkdir -p -- "$stage"
rsync -a --safe-links --files-from="$file_list" -- "$SOURCE_ROOT/" "$stage/"
find "$stage" -type l -print -quit | grep -q . && fail "symlink copiato nello staging"
find "$stage" ! -type d ! -type f -print -quit | grep -q . && fail "file speciale copiato nello staging"
stage_file_list="$temporary/stage-files.txt"
find "$stage" -type f -printf '%P\n' | LC_ALL=C sort -u > "$stage_file_list"
cmp -s "$file_list" "$stage_file_list" || fail "inventario source-stage diverso"

find "$stage" -type d -exec chmod 0755 -- {} +
while IFS= read -r relative; do
  staged="$stage/$relative"
  is_secret_path "$relative" && fail "percorso sensibile nello staging: $relative"
  [[ -f "$staged" && ! -L "$staged" ]] || fail "file staging non regolare: $relative"
  lower="${relative,,}"
  case "$lower" in
    *.db|*.db-*|*.gz|*.jar|*.sqlite|*.sqlite-*|*.sqlite3|*.sqlite3-*|*.tar|*.tar.*|*.tgz|*.xz|*.zst|*.7z)
      is_approved_binary_exception "$relative" || fail "binario staging fuori allowlist: $relative"
      ;;
  esac
  if LC_ALL=C grep -aEq -- '-----BEGIN ([A-Z ]+ )?PRIVATE KEY-----' "$staged"; then
    fail "marker di chiave privata nello staging: $relative"
  fi
  chmod "$(canonical_mode "$staged")" -- "$staged"
done < "$file_list"

manifest="$stage/$MANIFEST_NAME"
write_inventory "$stage" "$file_list" "$manifest" "file staging"
cmp -s "$source_snapshot" "$manifest" || fail "snapshot source-stage diverso: sorgente modificato durante il packaging"
chmod 0600 "$manifest"

find "$stage" -exec touch -h -t "$FIXED_TIMESTAMP" -- {} +

if [[ -n "$OUTPUT" ]]; then
  publish_directory="$(mktemp -d --tmpdir="$output_parent" ".${output_basename}.tmp.XXXXXXXX")"
  chmod 0700 "$publish_directory"
  archive_path="$publish_directory/$output_basename"
  sidecar_path="$publish_directory/${output_basename}.sha256"
else
  archive_path="$temporary/v6-dry-run.zip"
  sidecar_path="$archive_path.sha256"
fi

(
  cd "$temporary"
  find "$ARCHIVE_ROOT" -type f -printf '%p\n' | LC_ALL=C sort |
    zip -X -q "$archive_path" -@
)
chmod 0600 "$archive_path"

unzip -tq "$archive_path" >/dev/null
archive_listing="$temporary/archive-listing.txt"
expected_listing="$temporary/expected-listing.txt"
unzip -Z1 "$archive_path" | LC_ALL=C sort > "$archive_listing"
{
  sed "s#^#$ARCHIVE_ROOT/#" "$file_list"
  printf '%s\n' "$ARCHIVE_ROOT/$MANIFEST_NAME"
} | LC_ALL=C sort -u > "$expected_listing"
cmp -s "$expected_listing" "$archive_listing" || fail "inventario ZIP diverso dall'allowlist"
cmp -s "$manifest" <(unzip -p "$archive_path" "$ARCHIVE_ROOT/$MANIFEST_NAME") || fail "manifest ZIP non canonico"

archive_verify="$temporary/archive-verify"
mkdir -p -- "$archive_verify"
unzip -q "$archive_path" -d "$archive_verify"
find "$archive_verify" -type l -print -quit | grep -q . && fail "symlink presente nello ZIP"
find "$archive_verify" ! -type d ! -type f -print -quit | grep -q . && fail "file speciale presente nello ZIP"
archive_inventory="$temporary/archive-inventory.tsv"
write_inventory "$archive_verify/$ARCHIVE_ROOT" "$file_list" "$archive_inventory" "file ZIP"
cmp -s "$manifest" "$archive_inventory" || fail "contenuto ZIP diverso dal manifest"

archive_digest="$(sha256sum "$archive_path" | cut -d' ' -f1)"
archive_files="$(wc -l < "$archive_listing")"
archive_basename="$(basename -- "$archive_path")"
printf '%s  %s\n' "$archive_digest" "$archive_basename" > "$sidecar_path"
chmod 0600 "$sidecar_path"
(
  cd "$(dirname -- "$archive_path")"
  sha256sum -c -- "$(basename -- "$sidecar_path")" >/dev/null
)

if [[ -n "$OUTPUT" ]]; then
  sidecar_identity="$(stat -c '%d:%i' -- "$sidecar_path")"
  mv -T -n -- "$sidecar_path" "$SIDECAR"
  [[ ! -e "$sidecar_path" && ! -L "$sidecar_path" ]] || fail "pubblicazione sidecar no-clobber rifiutata"
  published_sidecar_identity="$sidecar_identity"
  [[ -f "$SIDECAR" && ! -L "$SIDECAR" ]] || fail "sidecar atomico assente"
  [[ "$(stat -c '%d:%i' -- "$SIDECAR")" == "$sidecar_identity" ]] || fail "sidecar atomico inatteso"
  [[ "$(stat -c '%a' -- "$SIDECAR")" == 600 ]] || fail "modo sidecar diverso da 0600"

  archive_identity="$(stat -c '%d:%i' -- "$archive_path")"
  mv -T -n -- "$archive_path" "$OUTPUT"
  [[ ! -e "$archive_path" && ! -L "$archive_path" ]] || fail "pubblicazione no-clobber rifiutata"
  published_archive_identity="$archive_identity"
  [[ -f "$OUTPUT" && ! -L "$OUTPUT" ]] || fail "output atomico assente"
  [[ "$(stat -c '%d:%i' -- "$OUTPUT")" == "$archive_identity" ]] || fail "output atomico inatteso"
  [[ "$(stat -c '%a' -- "$OUTPUT")" == 600 ]] || fail "modo output diverso da 0600"
  (
    cd "$output_parent"
    sha256sum -c -- "${output_basename}.sha256" >/dev/null
  )
  rmdir -- "$publish_directory"
  publish_directory=""
  published_archive_identity=""
  published_sidecar_identity=""
  printf 'Archivio: %s\n' "$OUTPUT"
  printf 'Sidecar: %s\n' "$SIDECAR"
else
  printf 'Archivio: temporaneo (non pubblicato)\n'
  printf 'Sidecar: temporaneo (non pubblicato)\n'
fi
printf 'Radice: %s/\n' "$ARCHIVE_ROOT"
printf 'File: %s\n' "$archive_files"
printf 'Manifest: %s\n' "$MANIFEST_NAME"
printf 'SHA-256: %s\n' "$archive_digest"
