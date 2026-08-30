# Local setup

Everything below has been run on Windows 11 with no container runtime. A
container runtime works too — `infra/docker-compose.yml` starts the same three
services — but it is not required, and on a machine without virtualisation it
is not an option.

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | ≥ 22.5 | `node:sqlite` and native TS type stripping |
| pnpm | ≥ 10 | Workspace protocol, `allowBuilds` |
| PostgreSQL | 17 | Authoritative store (section 9.1) |
| Redis-compatible server | ≥ 5 | BullMQ needs streams |
| S3-compatible storage | any | Immutable artefacts |

## Option A — containers

```bash
docker compose -f infra/docker-compose.yml up -d
```

## Option B — native Windows

No WSL, no Hyper-V, no BIOS changes.

```bash
winget install --id PostgreSQL.PostgreSQL.17 --silent
winget install --id Memurai.MemuraiDeveloper --silent
winget install --id MinIO.Server --silent
```

If the Memurai installer fails with exit code 1603, see
[troubleshooting](./troubleshooting.md#memurai-installer-fails-with-1603).

**Memurai needs two settings BullMQ depends on.** Without keyspace
notifications, delayed jobs do not fire:

```bash
memurai-cli config set notify-keyspace-events Ex
```

```bash
memurai-cli config set appendonly yes
```

```bash
memurai-cli config rewrite
```

`maxmemory-policy` must remain `noeviction`. BullMQ keeps job state in Redis,
and eviction silently discards work.

**MinIO** runs from its binary rather than as a service:

```bash
minio server C:\Users\<you>\arfos-minio --address :9000 --console-address :9001
```

Set `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` first, matching `.env`.

## Database

```bash
psql -U postgres -c "CREATE ROLE arfos LOGIN PASSWORD 'arfos'"
```

```bash
psql -U postgres -c "CREATE DATABASE arfos OWNER arfos TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C' ENCODING 'UTF8'"
```

`LC_COLLATE=C` matters: it makes `ORDER BY` deterministic regardless of host
locale, and matches what the compose file configures.

## Install, migrate, seed

```bash
pnpm install
```

```bash
pnpm build
```

```bash
pnpm db:migrate
```

```bash
pnpm db:seed
```

The seed creates one organisation and three users with distinct roles. It
creates **no** campaigns, strategies or results: the build prompt forbids fake
data outside tests, and a library of invented strategies would undermine the
one thing this system exists to do.

It prints the dev tokens:

```
seeded RESEARCHER        token: dev:dev-researcher
seeded DEVELOPER         token: dev:dev-developer
seeded COMMITTEE_MEMBER  token: dev:dev-committee
```

## Running

Copy `.env.example` to `.env` and set `AUTH_DEV_MODE=true`. The API refuses
that flag when `NODE_ENV=production`, so it cannot reach a deployed
environment.

```bash
pnpm --filter @arf/api dev
```

```bash
pnpm --filter @arf/web dev
```

```bash
pnpm --filter @arf/worker-backtest start
```

API on 3001, web on 3000. Authenticate with `Authorization: Bearer dev:dev-developer`.

## Verifying

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Integration tests need PostgreSQL, Redis and MinIO running:

```bash
pnpm test:integration
```

End-to-end starts its own servers on ports 3100 and 3101, so a dev stack can
stay open:

```bash
pnpm test:e2e
```
