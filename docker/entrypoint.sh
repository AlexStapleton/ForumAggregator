#!/bin/sh
# Container entrypoint: make the data folder writable, then run the app as an unprivileged user.
#
#   PUID / PGID  user and group the app runs as (default 1000:1000, like linuxserver.io images)
#
# Started as root (the default), it fixes the data folder's ownership, so both Docker volumes and
# bind-mounted host folders work without a manual `chown`, then drops all privileges. Started
# with `user:` / `--user`, it skips straight to the app.
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # Only walk the folder when something is actually owned by someone else.
  if [ "$(stat -c %u:%g "$DATA_DIR")" != "$PUID:$PGID" ] || \
     [ -n "$(find "$DATA_DIR" \( ! -user "$PUID" -o ! -group "$PGID" \) -print -quit 2>/dev/null)" ]; then
    echo "entrypoint: setting owner of $DATA_DIR to $PUID:$PGID"
    chown -R "$PUID:$PGID" "$DATA_DIR" || echo "entrypoint: warning: could not change owner of $DATA_DIR (network share?)"
  fi
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups --inh-caps=-all --no-new-privs "$@"
fi

exec "$@"
