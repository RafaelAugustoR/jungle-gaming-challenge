# Issue #10 evidence

The console lists persisted transactions and filters by wallet, current status, and wager kind. Opening a row shows the original submission receipt separately from its current GET state, preserving exact decimal strings.

Demo operators can create a wallet and run real duplicate, concurrent race, and out-of-order reference scenarios. The server obtains the configured provider's client-credentials token; operations use the production wager HTTP endpoint. Every receipt remains visible while the console polls actual GET results for all transactions, including both duplicate replays and both racing bets. The reference scenario keeps the original `202 PENDING_REFERENCE` receipt visible beside the final state. The backend records the human actor, provider identity, scenario, wallet, transaction IDs, and receipts.

## Verification

- `bun run typecheck` and `bun run build:frontend` passed.
- `bun test tests/unit/config.test.ts tests/unit/wager-transaction.test.ts` passed.
- `INTEGRATION=1 bun test tests/integration/demo.test.ts tests/integration/wagering-http.test.ts` passed with disposable PostgreSQL databases and Keycloak. The reference path used a real worker process.
- `BROWSER=1 SCREENSHOTS=1 CHROME_PATH=/usr/bin/google-chrome bun test tests/integration/console.test.ts` passed with Keycloak, a disposable database, and a real reference worker. The browser covers login, loading/empty/error states, demo-operator and viewer controls, the complete reference flow, and stale wallet and transaction responses.
- Screenshots at 1440, 768, and 390 px were checked for horizontal overflow.

The app direction was `achromatic-ledger`; its quiet data table and separate receipt/current sections fit the console's transaction review task. The existing branded shell, wallet tools, and palette remain intact. The taste linter reports no failures; remaining warnings are the existing outlined controls and the table's real missing-value dashes. The anonymous login view's first-fold void is intentional while wallet and transaction data stay hidden until authentication.

## Screenshots

- [1440 px](console-1440.png)
- [768 px](console-768.png)
- [390 px](console-390.png)

## Review corrections

The transaction and ledger cursors share a versioned opaque codec. Transaction
pagination keeps only the descending `(created_at, id)` boundary, with indexes for
global and per-wallet reads. The new indexes also survive a full migration
up/down/up test. The human-only list no longer filters provider rows after pagination.

The demo responds with typed immutable receipts without server-side polling. The
browser shows every operation and uses GET to follow pending results. Race amounts
are derived with integer minor units from the wallet balance: a balance of 100.00
produces two 80.00 bets, with one processed and one rejected. Client credentials
and HTTP remain server-side to exercise the actual provider authentication boundary
from ADR 0003; `DemoProviderClient` owns that transport. Client 4xx errors retain
their status/code, while dependency failures map to 503. Audit intent persists
before submission, and audit completion failure cannot replace the original error.

Validation of the review corrections:

- Build/typecheck and 36 unit tests passed.
- Full PostgreSQL/Keycloak/SQS integration: 106 passed, one browser-only skip,
  zero failures, 770 assertions.
- Browser: one passed, 22 assertions; all scenario results, receipt/current state,
  stale responses, permissions and 1440/768/390 px screenshots were checked.
- Docker test container: demo integration passed with 33 assertions, including
  token acquisition through the internal Keycloak URL.
- UI detector reported no findings; desktop and mobile screenshots were inspected.

A final browser regression holds the scenario's last wallet response, selects a
different wallet, and then releases the old response. The current selection and
hidden transaction detail remain unchanged. Build/typecheck and the final browser
run passed (21 assertions without repeating screenshots; the responsive capture
run above included three additional viewport assertions).
