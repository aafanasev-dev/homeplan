#!/bin/sh
# Register someone and print the link that lets them set a password.
#
#   docker exec -it homeplan add_user.sh someone@example.com
#   docker exec -it homeplan add_user.sh someone@example.com --reset
#   docker exec -it homeplan add_user.sh --list
#
# BASE_URL (for example https://plans.example.com) decides what the printed link looks like.

set -eu

APP_DIR="${APP_DIR:-/app}"

if [ $# -eq 0 ]; then
  echo "Usage: add_user.sh <email> [--reset]"
  echo "       add_user.sh --list"
  exit 2
fi

exec node "$APP_DIR/server/cli.js" add-user "$@"
