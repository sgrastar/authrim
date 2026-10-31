#!/usr/bin/env bash
# Start a disposable PostgreSQL 17 with TLS for the AWS runtime's PostgreSQL-backed tests.
#
# Several of those tests refuse to run without verified TLS (`sslmode=verify-full` against
# `localhost`, a CA file, a nonsuperuser administrator over TLS), so a plain service container
# would leave them skipped. This script creates a one-day CA and a server certificate for
# localhost, bakes the server key into an image with the ownership PostgreSQL requires, starts
# the container, waits until it accepts TCP connections and prints the CA path. TLS is available
# but not enforced by the server: the tests that open a plaintext connection check that the
# product's own initialization refuses it.
#
#   scripts/ci-postgres-tls.sh <work-dir>        prints the CA certificate path on success
#
# AUTHRIM_CI_PG_NAME (default authrim-ci-postgres) and AUTHRIM_CI_PG_PORT (default 5432) name the
# container and the published port. Everything is throwaway: the CA key never leaves <work-dir>
# and the password is only valid for this container.
set -euo pipefail

dir="${1:?usage: ci-postgres-tls.sh <work-dir>}"
name="${AUTHRIM_CI_PG_NAME:-authrim-ci-postgres}"
port="${AUTHRIM_CI_PG_PORT:-5432}"
image="${name}-image"

mkdir -p "$dir"
cd "$dir"

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=authrim-ci-ca" \
  -keyout ca.key -out ca.crt 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" \
  -keyout server.key -out server.csr 2>/dev/null
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' > san.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 1 \
  -extfile san.ext -out server.crt 2>/dev/null

# PostgreSQL refuses a server key that is not owned by its user or is readable by others.
cat > Dockerfile <<'EOF'
FROM postgres:17
COPY --chown=postgres:postgres server.crt server.key /etc/ssl/authrim/
RUN chmod 600 /etc/ssl/authrim/server.key
EOF
docker build --quiet --tag "$image" . > /dev/null

# Never remove a container this script did not just create: a same-named container is somebody
# else's (for example a development database) until its owner removes it.
if docker inspect "$name" > /dev/null 2>&1; then
  echo "A container named $name already exists; remove it or set AUTHRIM_CI_PG_NAME." >&2
  exit 1
fi
# The data directory is a tmpfs: nothing survives the container and no anonymous volume is made.
docker run --detach --name "$name" --tmpfs /var/lib/postgresql/data \
  --publish "127.0.0.1:${port}:5432" --env POSTGRES_PASSWORD=authrim-ci "$image" \
  postgres -c ssl=on -c ssl_cert_file=/etc/ssl/authrim/server.crt \
  -c ssl_key_file=/etc/ssl/authrim/server.key > /dev/null

# The image starts a temporary socket-only server during initialization, so probe over TCP.
for _ in $(seq 1 60); do
  if docker exec "$name" pg_isready --host 127.0.0.1 --username postgres > /dev/null 2>&1; then
    echo "$dir/ca.crt"
    exit 0
  fi
  sleep 1
done
docker logs "$name" >&2 || true
echo "PostgreSQL did not become ready" >&2
exit 1
