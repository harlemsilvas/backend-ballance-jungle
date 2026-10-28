#!/bin/sh
set -eu
cd "$(dirname "$0")"
project=${EXPERIMENT_PROJECT:-ballance-experimental-carga}
case "$project" in *[!a-z0-9_-]*|'') echo 'Nome de projeto experimental inválido.' >&2; exit 1;; esac
[ "$project" != "${DELIVERY_PROJECT:-ballance-experimental}" ] || { echo 'Use projeto diferente da aplicação.' >&2; exit 1; }
[ "$project" != "${DELIVERY_TEST_PROJECT:-ballance-experimental-testes}" ] || exit 1
compose() { docker compose -p "$project" -f compose.test.yaml -f compose.load.yaml "$@"; }
build() { if compose build "$1"; then return; fi; (export DOCKER_BUILDKIT=0; compose build "$1"); }
case "${1:-help}" in
  dashboard) build dashboard; compose up -d --no-deps --wait dashboard; echo "Painel: http://127.0.0.1:${REPORT_PORT:-38080}" ;;
  load|load3000|load-volume)
    if [ "$1" = load3000 ]; then
      export LOAD_PROFILE=3000
      export LOAD_HISTORIES=${LOAD_HISTORIES:-3000}
      export LOAD_REQUESTS=${LOAD_REQUESTS:-120}
      export LOAD_REPEATS=${LOAD_REPEATS:-1}
      export LOAD_SEED_BUDGET_MS=${LOAD_SEED_BUDGET_MS:-180000}
      [ "$LOAD_HISTORIES" = 3000 ] || { echo 'load3000 exige histórico 3000.' >&2; exit 1; }
    elif [ "$1" = load-volume ]; then
      export LOAD_PROFILE=volume
      export LOAD_HISTORIES=${LOAD_HISTORIES:-100,1000,3000}
      export LOAD_REQUESTS=${LOAD_REQUESTS:-120}
      export LOAD_REPEATS=${LOAD_REPEATS:-2}
      export LOAD_SEED_BUDGET_MS=${LOAD_SEED_BUDGET_MS:-180000}
      [ "$LOAD_HISTORIES" = '100,1000,3000' ] || { echo 'load-volume exige históricos 100,1000,3000.' >&2; exit 1; }
    else
      export LOAD_PROFILE=default
    fi
    export LOCAL_UID=${LOCAL_UID:-$(id -u)} LOCAL_GID=${LOCAL_GID:-$(id -g)}
    mkdir -p load-results
    trap 'compose stop postgres localstack >/dev/null 2>&1 || true' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    compose up -d --wait postgres localstack
    build load
    compose run --rm -T --no-deps load
    ;;
  stop) compose stop ;;
  status) compose ps -a ;;
  *) echo 'Uso: sh experimento.sh {dashboard|load|load3000|load-volume|status|stop}'; exit 1 ;;
esac
