# Architecture

## Bootstrap — Issue #2

The backend runs NestJS 11 on Bun 1.3.14. TypeScript compiles decorator metadata before production execution; Bun executes the compiled JavaScript. MikroORM 6.6.17 owns PostgreSQL connections and versioned reversible migrations. Dependency versions and Docker image tags are fixed; the Bun lockfile fixes transitive dependencies.

LocalStack 4.0.3 is deliberately pinned to an account-free release supporting the SQS FIFO API. It is a local testing dependency, not a production service. Integration tests exercise queue creation, sending, receiving and deletion against the actual emulator. Its older release and the local Keycloak development mode must be reconsidered before hosting; this Compose configuration is exclusively for local development and CI.

Liveness only checks the running HTTP process. Readiness independently queries PostgreSQL and SQS, returns bounded, sanitized dependency status and does not expose connection strings. This bootstrap creates short-lived clients for probes; shared lifecycle-managed clients can replace these when application modules acquire persistent connections. Probes do not depend on financial tables.

The initial migration creates the wagering schema without inventing business entities. Tests create a uniquely named disposable database, run up/down/up, assert schema existence and clean up their own database. The local database account needs CREATEDB for this test; restricted runtime and migration identities will be introduced with the financial schema in Issue #3.

Keycloak is started here; realm configuration, application authentication and human/provider identities are delivered in Issue #3. Financial processing, inbox/outbox and workers are subsequent tickets. No financial guarantees are claimed by this bootstrap.

## Design references

- [NestJS MikroORM integration](https://docs.nestjs.com/recipes/mikroorm)
- [MikroORM migrations](https://mikro-orm.io/docs/migrations)
- [LocalStack SQS](https://docs.localstack.cloud/aws/services/sqs/)
- [Approved specification](docs/spec.md)
- [Architecture decisions](docs/adr/)
