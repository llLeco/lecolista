#!/usr/bin/env bash
#
# Backup do Coolify Postgres + arquivos /data/coolify críticos.
# Rodar via cron diário no Raspberry.
#
# Setup no Pi:
#   sudo install -m 755 /home/pi/lecolista/scripts/backup-coolify.sh /usr/local/bin/coolify-backup
#   sudo crontab -e
#     0 3 * * *  /usr/local/bin/coolify-backup >> /var/log/coolify-backup.log 2>&1
#
# Verifica os últimos backups:
#   ls -lh /home/pi/backups/coolify/
#
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/home/pi/backups/coolify}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP_DIR"

echo "[$(date -Iseconds)] LecoLista/Coolify backup → $BACKUP_DIR"

# 1) Postgres dump (apps, deploys, settings)
echo "  · pg_dump coolify..."
docker exec coolify-db pg_dump -U coolify -Fc coolify \
  > "$BACKUP_DIR/coolify-db-${TIMESTAMP}.dump"

# 2) Tar das pastas críticas do Coolify (proxy config, ssl, ssh keys)
echo "  · tar /data/coolify..."
tar -czf "$BACKUP_DIR/coolify-data-${TIMESTAMP}.tar.gz" \
  --exclude='/data/coolify/applications/*/source' \
  --exclude='/data/coolify/backups' \
  -C / data/coolify 2>/dev/null || true

# 3) Limpeza de backups antigos
echo "  · removendo backups > ${RETENTION_DAYS} dias..."
find "$BACKUP_DIR" -type f -name "coolify-*" -mtime +${RETENTION_DAYS} -delete

# 4) Resumo
SIZE_DB=$(du -h "$BACKUP_DIR/coolify-db-${TIMESTAMP}.dump" | cut -f1)
SIZE_TAR=$(du -h "$BACKUP_DIR/coolify-data-${TIMESTAMP}.tar.gz" | cut -f1)
TOTAL=$(du -sh "$BACKUP_DIR" | cut -f1)
echo "[$(date -Iseconds)] ✓ backup OK · db=$SIZE_DB · data=$SIZE_TAR · total=$TOTAL"
