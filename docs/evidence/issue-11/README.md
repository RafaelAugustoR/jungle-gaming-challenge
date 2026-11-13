# Issue #11 — observability evidence

Bun 1.3.14, PostgreSQL 16.6, LocalStack 4.0.3, Keycloak 26.0.7,
Prometheus 3.5.0 and Grafana 12.1.1. All data below comes from actual requests,
SQL locks and SQS deliveries; no dashboard series or persistence mocks were used.

## Final automated validation

- `bun run build`: passed (typecheck and frontend bundle).
- `bun test tests/unit`: 36 passed, zero failures; 200 assertions.
- `METRICS_PORT=0 bun run test:integration`: **108 passed, one browser test
  separately gated, zero failures; 786 assertions**, about 82 seconds. The runner
  exited normally with code 0 and printed its concurrency JSON.
- Targeted HTTP/reference/DLQ integration run: 30 passed, 275 assertions before
  the final strengthened lock/retry assertions. The complete run above covers
  their final versions as well as the previous outbox and command-worker suites.
- `docker compose ... config --quiet`: passed for the isolated stack.

The HTTP integration test sends ten concurrent authenticated scrapes while a
real PostgreSQL `ACCESS EXCLUSIVE` lock blocks the durable snapshot. PostgreSQL
reports one waiting snapshot query (singleflight). All scrapes return 200, retain
the previous financial gauges, report `durable_snapshot_success=0` and an aging
snapshot, then recover to 1. No query-result mock remains.

Other assertions verify exactly three lock conflicts for three failed SQL
attempts, distinct deadlock/serialization retry reasons, HTTP errors included in
attempt counters, reference attempts/latency, and native SQS redrive depth read
by a new metrics observer after restart. Explicit-transfer counters stay separate.
The event consumer also starts with a source-only queue: optional DLQ sampling
resolves lazily and cannot prevent financial-event consumption.

## Actual Grafana load and dependency failure

The existing isolated project `jungle-observability-review` used PostgreSQL
55449, SQS 4576, Keycloak 18090, API 3009, Prometheus 19090, Grafana 13001 and
metrics subnet `172.31.22.0/24`. Its volumes were preserved between runs. No shared
service was stopped or reset.

`scripts/observability-evidence.ts` creates a fictitious wallet, performs accepted
BETs, same-key replays and insufficient-funds rejections, holds a real wallet lock
until a SQL retry is observed, and sends an invalid provider message through SQS.
Each execution makes 24 financial HTTP submissions: 12 distinct approved BETs,
six replays and six rejections. The final scripted wallet reconciles to `969.00`.
This is a bounded operational demonstration, **not** the Issue #13 load benchmark.

The script ran repeatedly; two runs after the final API restart provide meaningful
counter baselines for Grafana `rate`/`increase`. The loaded snapshot contains
37 persisted BET approvals, 19 persisted rejections and four openings, including
older executions in the same isolated database. Process counters since the API
restart contain 36 processed submissions, 12 rejections, 12 replays, two lock
conflicts and two financial retries. DLQ depth is three command messages and zero
events. This deliberately demonstrates durable counts versus process attempts.

| State | Liveness | Readiness | Viewer metrics | Snapshot success | Snapshot age |
| --- | --- | --- | --- | --- | --- |
| Loaded | 200 | 200 | 200 | 1 | 0 s |
| Isolated PostgreSQL stopped | 200 | 503 | 200 | 0 | 29.485 s |
| PostgreSQL restored | 200 | 200 | 200 | 1 | 1.094 s |

All five Prometheus targets remain `up=1` during the PostgreSQL outage: the API
listener remains available while dependency health and snapshot freshness expose
the incident. Unauthenticated `/internal/metrics` returns 401 in all three states;
a request from the default Compose network to the private scrape listener returns
403. Grafana requires login and scrape ports are not host-published.

Committed evidence:

- [Loaded dashboard, 14 panels](grafana-loaded.png) and [actual samples](loaded.json).
- [Dashboard during PostgreSQL outage](grafana-postgres-unavailable.png) and
  [actual samples/statuses](postgres-unavailable.json).
- [Recovered dashboard](grafana-recovered.png) and [actual samples/statuses](recovered.json).

The dashboard displays persisted outcomes, attempt outcomes including errors,
replays, SQL locks/retries, DLQ depth by worker and API snapshot freshness. Its
availability history also includes target replacements caused by image rebuilds;
the instant samples above distinguish those deployments from dependency failure.

## Reproduce

Start the normal Compose stack with its `events` profile, or use an isolated
project with equivalent port/subnet overrides. Set `.env` for that stack, including
its runtime/migration URLs, SQS endpoint and Keycloak issuer/JWKS URLs, then run:

```sh
bun install --frozen-lockfile
bun run build
bun test tests/unit
METRICS_PORT=0 bun run test:integration
OBSERVABILITY_API_URL=http://127.0.0.1:3009 bun scripts/observability-evidence.ts
# Repeat once to obtain baselines for rate/increase panels.
OBSERVABILITY_API_URL=http://127.0.0.1:3009 bun scripts/observability-evidence.ts
```

The script writes `artifacts/issue-11/load.json` and `loaded.prom` (ignored by Git).
It requires the migration connection only to hold the demonstration wallet lock.
Open the provisioned `jungle-operations` dashboard in Grafana and inspect all 14
panels. On this isolated project, the failure drill was:

```sh
docker stop --timeout 1 jungle-observability-review-postgres-1
# Inspect /health/live, /health/ready, authenticated /internal/metrics and Grafana.
docker start jungle-observability-review-postgres-1
# Confirm readiness/snapshot recovery and all five Prometheus targets up.
```

Keep these failure commands scoped to the dedicated demonstration project. SQS
statistics are approximate; stale snapshots are explicitly signaled and must not
be read as current financial state. No RPS or production SLA is claimed.
