# backups

[![CI](https://github.com/openasy/backups/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/backups/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Backups product: **did the backups run, how late are they, and has anyone
restored one** (ADR 0048). It tracks [restic](https://restic.net/) and [Velero](https://velero.io/) jobs, or any script
that reports, and it makes no backups. A backup nobody has restored is a hope, so restore tests are part of the state.

```
restic / Velero / a script  ──POST /api/v1/runs──▶  backups  ──▶  state: healthy | late | at-risk | failing | untested
a restore test, now and then ──POST /api/v1/restore-tests──▶       └── /metrics, to alert on
```

## Jobs and their state

An admin defines a **job**: what makes the backups (`restic`, `velero` or `other`), what it backs up, where it goes, how
often it should run (**cadence**) and how many hours of data may be lost (**RPO**, not less than the cadence).

A job is in the first of these states that fits:

| State | When |
| --- | --- |
| `failing` | the last 2 runs failed (change under Settings) |
| `at-risk` | the last backup is older than the RPO, or nothing has ever succeeded |
| `late` | the last backup is older than one and a half cadences |
| `untested` | no restore test yet, the last one failed, or the last one is older than 30 days (change under Settings) |
| `healthy` | on time, and a restore has been tested |
| `unknown` | no run has been reported |

A run with a **warning** is a backup that was made. Each job also shows its success rate over 30 days, the size of its
last backup (a chart over time on the job's page) and the age of its last restore test.

## Reports

Jobs report each finished run, and say when a restore was tried:

```bash
# restic: send the summary line
restic backup --json /srv | tail -n 1 | curl -sf -X POST -H "Authorization: Bearer $BACKUPS_INGEST_TOKEN" \
  -H 'content-type: application/json' --data-binary @- "https://backups.example.com/api/v1/runs?job=files"

# Velero: send the Backup resource once its phase is Completed, PartiallyFailed or Failed
kubectl -n velero get backup nightly-20261022 -o json | curl -sf -X POST -H "Authorization: Bearer $BACKUPS_INGEST_TOKEN" \
  -H 'content-type: application/json' --data-binary @- "https://backups.example.com/api/v1/runs?job=cluster"

# anything else, and a restore test
curl -sf -X POST -H "Authorization: Bearer $BACKUPS_INGEST_TOKEN" -H 'content-type: application/json' \
  -d '{"job":"db","startedAt":"2026-10-22T01:00:00Z","endedAt":"2026-10-22T01:20:00Z","status":"success","sizeBytes":5000000}' \
  https://backups.example.com/api/v1/runs
curl -sf -X POST -H "Authorization: Bearer $BACKUPS_INGEST_TOKEN" -H 'content-type: application/json' \
  -d '{"job":"db","testedAt":"2026-10-22T04:00:00Z","ok":true,"durationSeconds":340,"verifiedBy":"automated"}' \
  https://backups.example.com/api/v1/restore-tests
```

- A report for a job nobody defined is **refused**, so that a typo does not become a job. An admin can let reports create
  jobs (cadence 24 hours, RPO 48) under Settings.
- The same snapshot reported twice is one run, so a retry changes nothing.
- A Velero `PartiallyFailed` backup, or one `Completed` with warnings, is a run with a warning. Passwords and tokens in
  an error are masked.
- A person records a manual restore test on the job's page.

## Run

```bash
openssl rand -hex 32 > openasy-kek
export BACKUPS_INGEST_TOKEN=$(openssl rand -hex 32)
docker compose up -d
docker compose logs backups | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013). The UI and API
are on http://localhost:8080, the API reference at http://localhost:8080/api/docs/.

`openasy-kek` encrypts sign-in secrets in the database (ADR 0021). Keep it apart from the volume and with your backups.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `BACKUPS_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher. Give every product the same value |
| `BACKUPS_INGEST_TOKEN` | | Lets jobs report runs and restore tests and nothing else. An API token with the editor role works too |
| `BACKUPS_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key |
| `BACKUPS_DB` | `/data/backups.db` | SQLite file (WAL), on the `/data` volume |
| `BACKUPS_RETENTION_DAYS` | `365` | Runs and restore tests older than this are deleted |
| `BACKUPS_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `BACKUPS_HEADLESS` | `false` | `true` serves only the API |
| `BACKUPS_PASSWORD_SIGN_IN`, `BACKUPS_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

`/metrics` has `openasy_backups_job_state{job,state}` and `openasy_backups_last_success_timestamp_seconds{job}` for each
job, to alert on in your own Prometheus.

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`.

## Roles

Viewers see everything; editors also record restore tests; admins also define, change and delete jobs, change the
settings, and manage members and API tokens (ADR 0003).

## Develop

```bash
npm install
npm test        # report parsing, the state of a job as time passes, auto-create, and every API response against openapi.json
npm run dev     # the UI, with the API on :8080
```

## Licence

AGPL-3.0 (ADR 0008).
