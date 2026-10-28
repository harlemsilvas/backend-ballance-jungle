#!/bin/sh
set -eu
cd "$(dirname "$0")"
command -v docker >/dev/null 2>&1 || { echo 'Instale o Docker conforme README.md.' >&2; exit 1; }
docker compose version >/dev/null
docker info >/dev/null 2>&1
# Compose can find a stale Buildx plugin even when docker buildx itself works.
build() {
  if "$@"; then return 0; fi
  echo 'Build falhou; tentando uma vez com o builder clássico.' >&2
  (export DOCKER_BUILDKIT=0; "$@")
}
project=${DELIVERY_PROJECT:-ballance-experimental}
test_project=${DELIVERY_TEST_PROJECT:-ballance-experimental-testes}
[ "$project" != "$test_project" ] || { echo 'Projetos de aplicação e testes devem ser diferentes.' >&2; exit 1; }
app() { docker compose -p "$project" -f compose.yaml -f compose.app.yaml "$@"; }
tests() { docker compose -p "$test_project" -f compose.test.yaml "$@"; }
case "${1:-help}" in
  init)
    [ ! -e .env ] || { echo '.env já existe; foi preservado.'; exit 0; }
    secret=$(docker run --rm oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d bun -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))")
    # noclobber refuses to overwrite a concurrently created file.
    (umask 077; set -C; printf 'RUNTIME_DB_PASSWORD=%s\n' "$secret" > .env)
    echo '.env privado criado. Guarde-o para reutilizar o volume.'
    ;;
  up)
    [ -f .env ] || { echo 'Execute primeiro: sh entrega.sh init' >&2; exit 1; }
    chmod +x docker/localstack/init-queues.sh
    # Build only the provision service, whose image is reused by API and worker.
    build app build provision
    app up -d --no-build --wait
    app ps
    ;;
  test)
    # Stop test infrastructure on success, error or interruption; preserve its volume.
    trap 'tests stop >/dev/null 2>&1 || true' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap 'exit 129' HUP
    tests up -d --wait postgres localstack
    build tests build tests
    tests run --rm -T tests
    ;;
  smoke)
    build docker compose -p "$project" -f compose.yaml -f compose.app.yaml -f compose.tools.yaml build smoke
    docker compose -p "$project" -f compose.yaml -f compose.app.yaml -f compose.tools.yaml run --rm -T --no-deps smoke
    ;;
  stop) app stop ;;
  status) app ps ;;
  logs) app logs --tail 100 api worker provision ;;
  *) echo 'Uso: sh entrega.sh {init|up|test|smoke|status|logs|stop}'; exit 1 ;;
esac
