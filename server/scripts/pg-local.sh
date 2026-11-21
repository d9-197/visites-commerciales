#!/usr/bin/env bash
# Base PostgreSQL locale jetable pour les tests (sans Docker). Usage : pg-local.sh start|stop
# Variables : PGDIR (défaut /tmp/visites-pg), PGPORT (défaut 54329), PGBIN (défaut /usr/lib/postgresql/16/bin)
set -euo pipefail
PGDIR="${PGDIR:-/tmp/visites-pg}"; PGPORT="${PGPORT:-54329}"; PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
run() { if [ "$(id -u)" = 0 ]; then su postgres -c "$*"; else bash -c "$*"; fi; }
case "${1:-}" in
  start)
    mkdir -p "$PGDIR"; [ "$(id -u)" = 0 ] && chown postgres "$PGDIR"
    [ -d "$PGDIR/data" ] || run "$PGBIN/initdb -D $PGDIR/data -A trust >/dev/null"
    run "$PGBIN/pg_ctl -D $PGDIR/data -o '-p $PGPORT -k $PGDIR -c fsync=off' -l $PGDIR/log -w start" >/dev/null
    echo "postgres://postgres@127.0.0.1:$PGPORT/postgres" ;;
  stop) run "$PGBIN/pg_ctl -D $PGDIR/data stop -m fast" >/dev/null ;;
  *) echo "usage: $0 start|stop" >&2; exit 1 ;;
esac
