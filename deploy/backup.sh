#!/bin/sh
# Hourly database dump (kept 2 days) and one dump a day (kept 14 days), in /backups.
# Restoring: see deploy/README.md. Copying them off the server is up to you (the server disk is not a backup of itself).
set -u
mkdir -p /backups
while true; do
  stamp=$(date -u +%Y-%m-%d-%H)
  if pg_dump --no-owner -f /tmp/dump.sql; then
    gzip -c /tmp/dump.sql > "/backups/hourly-$stamp.sql.gz.part" && mv "/backups/hourly-$stamp.sql.gz.part" "/backups/hourly-$stamp.sql.gz"
    if [ "$(date -u +%H)" = "00" ]; then cp "/backups/hourly-$stamp.sql.gz" "/backups/daily-$(date -u +%Y-%m-%d).sql.gz"; fi
    echo "backup ok: hourly-$stamp.sql.gz"
  else
    echo "backup FAILED at $stamp" >&2
  fi
  rm -f /tmp/dump.sql
  find /backups -name 'hourly-*' -mmin +2880 -delete
  find /backups -name 'daily-*' -mtime +14 -delete
  sleep 3600
done
