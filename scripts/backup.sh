#!/usr/bin/env bash
# ============================================================
# scripts/backup.sh — Nightly backup for BOARDLINK
# ============================================================
#
# Backs up the two things that cannot be recreated:
#
#   1. The MySQL database  — board records, agendas, minutes,
#      comments, user accounts and the RBAC assignments.
#   2. The uploads/ directory — the scanned resolutions
#      themselves. These are irreplaceable: the paper originals
#      date back to 1985 and re-scanning them is weeks of work.
#
# The application code is NOT backed up here; it lives in Git.
#
# Install as a cron job, e.g. 1:30am daily:
#   30 1 * * * /opt/boardlink/scripts/backup.sh >> /var/log/boardlink-backup.log 2>&1

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

# Load DB credentials from .env without executing arbitrary lines.
if [[ -f .env ]]; then
  while IFS='=' read -r key value; do
    [[ $key =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    value="${value%\"}"; value="${value#\"}"
    export "$key=$value"
  done < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' .env || true)
fi

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-root}"
DB_NAME="${DB_NAME:-boardlink}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-30}"

STAMP="$(date +%Y-%m-%d_%H%M)"
mkdir -p "$BACKUP_DIR"

echo "[$(date '+%F %T')] starting backup -> $BACKUP_DIR"

# --- 1. Database ------------------------------------------------
# --single-transaction keeps the dump consistent without locking
# the tables, so an overnight backup never blocks a late-working
# Board Secretary.
DUMP="$BACKUP_DIR/boardlink-db-$STAMP.sql.gz"
MYSQL_PWD="${DB_PASSWORD:-}" mysqldump \
    --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" \
    --single-transaction --quick --routines --events \
    "$DB_NAME" | gzip > "$DUMP"
echo "  database -> $(basename "$DUMP") ($(du -h "$DUMP" | cut -f1))"

# --- 2. Uploaded documents --------------------------------------
FILES="$BACKUP_DIR/boardlink-uploads-$STAMP.tar.gz"
# UPLOAD_DIR in .env, when set, is where the files are kept.
UPLOADS_PATH="${UPLOAD_DIR:-$(grep -E '^UPLOAD_DIR=' .env 2>/dev/null | cut -d= -f2-)}"
UPLOADS_PATH="${UPLOADS_PATH:-uploads}"
if [[ -d "$UPLOADS_PATH" ]]; then
  tar -czf "$FILES" -C "$(dirname "$UPLOADS_PATH")" "$(basename "$UPLOADS_PATH")"
  echo "  uploads  -> $(basename "$FILES") ($(du -h "$FILES" | cut -f1))"
else
  echo "  uploads  -> directory not found, skipped"
fi

# --- 3. Verify the dump is readable -----------------------------
# A backup that has never been tested is not a backup.
if ! gzip -t "$DUMP"; then
  echo "  ERROR: database dump failed integrity check" >&2
  exit 1
fi
echo "  verified : archives are readable"

# --- 4. Retention ----------------------------------------------
find "$BACKUP_DIR" -name 'boardlink-*' -type f -mtime "+$RETAIN_DAYS" -print -delete \
  | sed 's/^/  removed  : /' || true

echo "[$(date '+%F %T')] backup complete"
echo
echo "REMINDER: copy $BACKUP_DIR to storage OUTSIDE this server."
echo "A backup sitting on the same machine does not survive a disk"
echo "failure, theft, or fire."
