# Issue #5 — settlement and reversals

Implementation follows ADRs 0009, 0010 and 0017 and the approved spec. WIN credits, LOSS records a result without moving balance, REFUND reverses a processed BET, and ROLLBACK inverts BET/WIN/REFUND. Supplied references are resolved within the provider and checked against player, wallet, currency, round, kind, status and reversal amount.

## Guarantees implemented

- Financial effects, immutable balanced journal, historical receipt and typed outbox result remain one SQL transaction under the wallet lock.
- Positive credits use Wallet.credit; overflow becomes an audit-safe AMOUNT_LIMIT_EXCEEDED rejection.
- Debit reversals rejected for insufficient funds use REVERSAL_INSUFFICIENT_FUNDS. The rejected key remains terminal; a different operation may later succeed without consuming the applied reversal slot.
- Uniqueness is reference + reversal kind for PROCESSED operations, enforced by a partial unique index. The approved literal REFUND plus direct ROLLBACK of one BET yields 100 → 80 → 100 → 120; ROLLBACK of the REFUND instead debits its credit.
- A deferred database trigger checks references and rollback journal direction on processed operations. Reference identity columns are immutable after submission under the existing transaction-identity trigger.
- Zero-value movements and LOSS create no journal or WalletBalanceChanged and do not increment wallet version. Every processed operation still has its result event.
- Query endpoints expose supplied and resolved reference IDs, while replay preserves the original receipt.

## Boundary with Issue #6

A reference absent or still pending is accepted as PENDING_REFERENCE with a persisted 202 receipt and pending event; this prevents a false terminal rejection. This ticket does not implement scheduled retries, TTL expiry or reference resolution after acceptance. Issue #6 must add that worker and permit assigning a previously absent resolved reference ID during its valid pending-to-terminal transition. No claim of complete out-of-order recovery is made here.

## Verification

Executed in an isolated worktree using disposable PostgreSQL databases, ephemeral API ports and the existing healthy Keycloak/SQS infrastructure. No shared database reset or container shutdown was performed.

- `bun run build`: strict typecheck and frontend build passed.
- `bun test tests/unit`: 24 passed, 146 assertions.
- `bun run test:integration`: 53 passed, 1 browser test skipped, 370 assertions. Includes existing BET three-process proofs and migration up/down/up through migration 0004.
- Added six HTTP settlement scenarios: WIN/LOSS/zero, all reversible kinds, historical replay, reference validation, reversal insufficient balance, overflow and pending acceptance.
- Added three-process race: twelve distinct REFUND operations against one BET produced exactly one processed refund and eleven ALREADY_REVERSED rejections, wallet 100.00/version 3, one refund journal entry, reconstructed balance 100.00. A direct SQL insert bypassing the application independently failed the reversal unique index.

The skipped browser test is unchanged and gated by BROWSER=1. This ticket changes no frontend behavior. Issue #9 owns console ledger/reconciliation enhancements in a separate branch.

## Coordinated review corrections

The public Wallet.credit interface now checks currency compatibility even for zero amounts; a regression test first failed with a zero USD credit on a BRL wallet and passes after moving exact addition before the zero shortcut. The original wallet remains unchanged on either path.

Operation policies explicitly own their allowed reference kinds and movement: BET debits without references, WIN credits, LOSS has no movement, REFUND credits a BET reversal, and ROLLBACK chooses the inverse direction from its validated reference. Shared reference validation no longer dispatches on the submitted operation kind.
