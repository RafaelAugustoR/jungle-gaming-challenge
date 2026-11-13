# Issue #11 — observability evidence

## Automated checks

- `bun run build` — passed (`typecheck` plus frontend build).
- `bun test` — 45 passed, 101 integration-only cases skipped, 0 failed.
- `bun test tests/unit/logger.test.ts tests/unit/metrics.test.ts tests/unit/metrics-network.test.ts tests/integration/identity.test.ts` — 9 passed. This covers nested log redaction, singleflight/cached database snapshots, timeout failures not being cached, CIDR filtering, and public liveness versus viewer-authenticated `/internal/metrics`.
- `INTEGRATION=1 DATABASE_URL=postgresql://jungle:local-demo-only@127.0.0.1:55449/jungle SQS_ENDPOINT=http://127.0.0.1:4576 KEYCLOAK_ISSUER=http://localhost:18090/realms/jungle KEYCLOAK_JWKS_URL=http://localhost:18090/realms/jungle/protocol/openid-connect/certs bun test tests/integration/wagering-http.test.ts` — 15 passed. The integration cases verify a real PostgreSQL wallet row lock increments `wallet_lock_conflicts_total`, a real deadlock SQLSTATE triggers one successful internal retry, the correlated wager log omits monetary payload, and a table `ACCESS EXCLUSIVE` lock makes the read-only metrics query hit its 750ms statement timeout. After releasing the table lock, the same registry successfully scrapes again.
- `INTEGRATION=1 DATABASE_URL=postgresql://jungle:local-demo-only@127.0.0.1:55449/jungle SQS_ENDPOINT=http://127.0.0.1:4576 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test KEYCLOAK_ISSUER=http://localhost:18090/realms/jungle KEYCLOAK_JWKS_URL=http://localhost:18090/realms/jungle/protocol/openid-connect/certs bun test tests/integration/outbox.test.ts` — 13 passed. Published/retry/blocked events emitted correlation and transaction identifiers without logging event payloads.
- `docker compose config --quiet` — passed.

## Container scrape and recovery

The Compose stack ran as project `jungle-issue11` with separate host ports and fresh PostgreSQL, SQS, Prometheus, and Grafana volumes. Prometheus `/api/v1/targets` reported `api`, `command-consumer`, `reference-worker`, `outbox-publisher`, and `event-consumer` all `up`. An actual scrape returned database-backed outbox/reference gauges and process metrics. The provisioned Grafana endpoint returned dashboard `Jungle Gaming Operations` with 11 panels.

Scaling `command-consumer` to two instances produced two distinct Prometheus targets. Stopping both replicas made the target availability query report `down`; starting them restored `up`. API readiness remained `ok` with PostgreSQL and SQS healthy. A request from the default Compose network to the metrics listener returned 403 because its address did not match the dedicated scrape subnet. The listener has no host-published port; `/internal/metrics` returned 401 without a viewer token while `/health/live` returned 200.

The isolated Compose database was empty during dashboard inspection, so the durable transaction series had no samples there. The integration HTTP run exercised actual persisted opening and wager records and asserted their values in the database-derived scrape; no dashboard data was fabricated.
