# Architecture

## Bootstrap — Issue #2

The backend and tests execute the same TypeScript sources directly with Bun 1.3.14. TypeScript remains the mandatory strict typecheck (`build` checks types and bundles the browser console); no separate transpiled runtime exists. MikroORM 6.6.17 owns migrations, discovered from the migrations directory without a manual list.

LocalStack 4.0.3 is pinned to an account-free release. MiniStack was considered as the alternative permitted by the challenge; the chosen release is validated against FIFO deduplication, visibility release and automatic DLQ redrive, in addition to send/receive/delete. This is evidence of the required emulator capabilities, not a claim that every SQS feature is equivalent to AWS. Older local images require reassessment before hosted deployment.

A typed configuration is loaded and validated once at boot. Factories receive it explicitly; local credentials come from the environment, and absent AWS credentials use the SDK provider chain. InfrastructureModule provides separate MikroORM and SQSClient tokens, closed by its lifecycle provider on shutdown. Financial modules do not depend on HealthModule. EntityManager forks will isolate financial requests in the next ticket. HealthModule lives under observability and only consumes infrastructure; ApiModule.register composes the modules. Readiness queries shared clients with a probe-local SQL deadline/cancellation and SQS abort signal. There is no global statement timeout imposed on migrations or future financial queries. Probe failures log a sanitized reason; Nest exceptions and startup failures use JSON logging with URL/credential redaction. HTTP responses only expose booleans. Shared clients retain SDK defaults for retry/long polling; probe deadlines are applied only at the call site. DATABASE_CONNECT_TIMEOUT_MS controls database connection establishment separately. JSON logs preserve Nest stack/context and structured application fields with recursive redaction.

Compose runs a one-shot migration service before API startup. Readiness still measures dependency connectivity; schema rollout is an explicit deployment prerequisite rather than being inferred from connectivity. CI tests real PostgreSQL/SQS and waits for the runtime healthcheck. Keycloak is started by the full local stack; realm/auth testing belongs to the next ticket.

The initial migration creates the wagering schema without inventing business entities. Tests create a uniquely named disposable database, run up/down/up, assert schema existence and clean up their own database. The local database account needs CREATEDB for this test; restricted runtime and migration identities will be introduced with the financial schema in Issue #3.

Keycloak is started here; realm configuration, application authentication and human/provider identities are delivered in Issue #3. Financial processing, inbox/outbox and workers are subsequent tickets. No financial guarantees are claimed by this bootstrap.

## Design references

- [NestJS MikroORM integration](https://docs.nestjs.com/recipes/mikroorm)
- [MikroORM migrations](https://mikro-orm.io/docs/migrations)
- [LocalStack SQS](https://docs.localstack.cloud/aws/services/sqs/)
- [Approved specification](docs/spec.md)
- [Architecture decisions](docs/adr/)

## Authenticated wallet opening — Issue #3

Identity verifies JWTs with jose and Keycloak JWKS. Public console assets and health routes remain available before login; wallet routes enforce human roles on the backend. The public client uses the official keycloak-js adapter, PKCE S256 and in-memory tokens. Human role inheritance is configured in the imported realm; each provider has its own confidential client and fixed providerId claim. A trusted issuer and audience are mandatory before claims become a principal.

Wallet, Money and JournalEntry have private constructors, factories and rehydrate methods. They depend on neither NestJS nor MikroORM. Financial requests use an EntityManager fork and one transaction. Persistence uses explicit SQL through MikroORM to preserve PostgreSQL NUMERIC strings, deferred constraints and exact journal semantics. No identity map or connection session is shared between requests. Opening and gaming counterpart accounts are distinct and have no materialized balance or per-wallet update/lock. The BRL counterpart accounts are seeded in the migration.

A single journal row represents the pair: debit counterpart, credit player, one positive amount and one currency. The player ledger is a view over that fact. Composite foreign keys enforce currencies and transaction context. Deferred constraint triggers check the wallet balance/version against its opening and the applicable outbox event at commit. Runtime cannot UPDATE/DELETE/TRUNCATE the journal, and immutable triggers also protect owner writes. Only the separate migration owner can change the schema. Amounts use unconstrained NUMERIC plus finitude/scale/range checks to reject 0.001 before PostgreSQL can round it.

Migration 0003 evolves existing OPENING rows into a common `transactions` table without recreating financial data or foreign keys. The database validates journal adjacency, arithmetic, processed transaction linkage, wallet endpoints and applicable outbox presence for both credit and debit; the ledger derives kind and direction. The current API still produces OPENING only. Wagering transitions, external identities, receipts and idempotency remain in the wagering ticket. Event payload shape/version is owned by domain classes and their public tests, while PostgreSQL enforces relational atomicity and immutability. The outbox publisher ticket must add publication/lease state in a separate table without editing event payloads. Neither inbox nor submission receipts apply to the internal wallet creation command. Zero opening creates no opening transaction, journal or event.

The console uses buildless HTML/CSS plus TypeScript bundled by Bun, served from the API origin. It creates and queries real wallets and reads the ledger; no seeded display balances, frontend finance arithmetic or machine credentials are included. Further wagering and reconciliation screens remain in their respective tickets.

Review follow-up: `Wallet.open` returns wallet, internal transaction, journal entry and derived event as one domain result; zero produces only the wallet. Factories validate creation; Wallet/JournalEntry rehydrate persisted facts without reopening them. Wallet holds Money, and only Money imports decimal.js. REST parsers produce typed commands and serializers preserve the existing HTTP contracts. Application use cases depend on the WalletStore port and throw typed DomainError codes, with one global REST filter translating them; SQL and database error classification live in the persistence adapter. Only the player/currency unique constraint maps to WALLET_ALREADY_EXISTS. Identity principals are a human/provider discriminated union; provider client-to-providerId bindings come from PROVIDER_CLIENTS configuration.
