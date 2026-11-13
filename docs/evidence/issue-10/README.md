# Issue #10 evidence

The console lists persisted transactions and filters by wallet, current status, and wager kind. Opening a row shows the original submission receipt separately from its current GET state, preserving exact decimal strings.

Demo operators can create a wallet and run real duplicate, concurrent race, and out-of-order reference scenarios. The server obtains the configured provider's client-credentials token; operations use the production wager HTTP endpoint. The reference scenario waits on actual GET results and keeps the original `202 PENDING_REFERENCE` receipt visible beside the final state. The backend records the human actor, provider identity, scenario, wallet, transaction IDs, and results.

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
