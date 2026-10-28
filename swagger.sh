#!/bin/sh
set -eu
cd "$(dirname "$0")"
project=${DELIVERY_PROJECT:-ballance-experimental}
compose() { docker compose -p "$project" -f compose.yaml -f compose.app.yaml -f compose.swagger.yaml "$@"; }
case "${1:-help}" in
  up)
    [ -f .env ] || { echo 'Prepare .env da instalação com entrega.sh init.' >&2; exit 1; }
    if ! compose build api; then (export DOCKER_BUILDKIT=0; compose build api); fi
    compose up -d --no-build --wait api
    echo "Swagger: http://127.0.0.1:${PORT:-3000}/docs (confira a porta em .env)"
    ;;
  off) sh entrega.sh up ;;
  *) echo 'Uso: sh swagger.sh {up|off}'; exit 1 ;;
esac
