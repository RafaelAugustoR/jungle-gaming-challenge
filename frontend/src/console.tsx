import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, followTransaction, isAbort, type Api } from './api';
import { LedgerView, TicketsView } from './evidence';
import { ErrorNote } from './fields';
import { ProofView } from './proof';
import {
  isProofId,
  isViewId,
  proofById,
  type ProofId,
  type ReconcileEntry,
  type ScenarioEntry,
  type ViewId,
} from './proofs';
import { Rail } from './rail';
import { can, type Role } from './roles';
import type { ProofRun, ScenarioProgress } from './run';
import { StartView } from './start';
import type { DemoScenarioResult, Reconciliation, Wallet } from './types';
import './console.css';

function readUrl() {
  const params = new URLSearchParams(location.search);
  return { wallet: params.get('wallet'), view: params.get('view') };
}
function writeUrl(wallet?: string, view?: ViewId) {
  const params = new URLSearchParams();
  if (wallet) params.set('wallet', wallet);
  if (wallet && view) params.set('view', view);
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}`);
}

const asApiError = (error: unknown) =>
  error instanceof ApiError ? error : new ApiError((error as Error).message);

/**
 * Owns the open wallet and its proof runs. Everything started for a wallet hangs off one
 * AbortController (`scope`); opening another wallet aborts it, so no late response can write
 * into the new one. A recovery run also has its own `stop` signal to end the polling early.
 */
export function Console({ api, role }: { api: Api; role: Role }) {
  const [wallet, setWallet] = useState<Wallet>();
  const [view, setView] = useState<ViewId | 'start'>('start');
  const [runs, setRuns] = useState<Partial<Record<ProofId, ProofRun>>>({});
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<Error>();
  const scope = useRef(new AbortController());
  const stops = useRef<Partial<Record<ProofId, AbortController>>>({});

  function go(next: ViewId | 'start', walletId = wallet?.id) {
    setView(next);
    writeUrl(next === 'start' ? undefined : walletId, next === 'start' ? undefined : next);
    window.scrollTo({ top: 0 });
  }

  function resetWallet(next: Wallet | undefined, nextView: ViewId | 'start') {
    scope.current.abort();
    scope.current = new AbortController();
    stops.current = {};
    setRuns({});
    setWallet(next);
    go(nextView, next?.id);
  }

  const openWallet = (next: Wallet, created: boolean) =>
    resetWallet(next, created && can(role, 'demo-operator') ? 'race' : 'tickets');

  useEffect(() => {
    const { wallet: walletId, view: requested } = readUrl();
    if (!walletId) return setBooting(false);
    api
      .request<Wallet>(`/wallets/${encodeURIComponent(walletId)}`)
      .then((loaded) => resetWallet(loaded, isViewId(requested) ? requested : 'tickets'))
      .catch((caught) => setBootError(caught as Error))
      .finally(() => setBooting(false));
  }, []);

  function refreshWallet() {
    if (!wallet) return;
    const { signal } = scope.current;
    api
      .request<Wallet>(`/wallets/${wallet.id}`, { signal })
      .then(setWallet)
      .catch(() => undefined);
  }

  /** Writes a run only while the wallet that started it is still open. */
  function publisher(id: ProofId, signal: AbortSignal) {
    return (run: ProofRun) => {
      if (!signal.aborted) setRuns((previous) => ({ ...previous, [id]: run }));
    };
  }

  async function runScenario(proof: ScenarioEntry, walletId: string, amount?: string) {
    const { id } = proof;
    const { signal } = scope.current;
    stops.current[id]?.abort();
    const stop = new AbortController();
    stops.current[id] = stop;
    const publish = publisher(id, signal);
    const startedAt = Date.now();
    const progress: ScenarioProgress = { kind: 'scenario', views: [] };
    const snapshot = () => ({ ...progress, views: [...progress.views] });
    const running = (watching: boolean) =>
      publish({ status: 'running', watching, startedAt, progress: snapshot() });
    running(false);
    try {
      const before = await api.request<Wallet>(`/wallets/${walletId}`, { signal });
      if (!signal.aborted) setWallet(before);
      progress.before = before.balance;
      running(false);
      const result = await api.request<DemoScenarioResult>('/demo/scenarios', {
        body: { scenario: proof.scenario, walletId, ...(amount ? { amount } : {}) },
        signal,
      });
      progress.result = result;
      progress.views = result.transactions.map(() => undefined);
      running(true);
      const submittedAt = Date.now();
      let pendingMs = 0;
      await Promise.all(
        result.transactions.map((submission, index) =>
          followTransaction(api, submission.originalReceipt.body.transactionId, {
            deadlineMs: proof.followMs,
            signal,
            stop: stop.signal,
            onUpdate: (update) => {
              if (update.status === 'PENDING_REFERENCE') pendingMs = Date.now() - submittedAt;
              progress.views[index] = update;
              running(true);
            },
          }).catch((error) => {
            if (isAbort(error)) throw error;
            return undefined;
          }),
        ),
      );
      const after = await api.request<Wallet>(`/wallets/${walletId}`, { signal });
      if (!signal.aborted) setWallet(after);
      progress.after = after.balance;
      const verdict = proof.judge({
        result,
        views: progress.views,
        before: before.balance,
        after: after.balance,
        pendingMs,
      });
      publish({ status: 'done', verdict, startedAt, progress: snapshot() });
    } catch (error) {
      if (!isAbort(error))
        publish({ status: 'error', error: asApiError(error), startedAt, progress: snapshot() });
    }
  }

  async function runReconcile(proof: ReconcileEntry, walletId: string) {
    const { signal } = scope.current;
    const publish = publisher(proof.id, signal);
    const startedAt = Date.now();
    publish({ status: 'running', watching: false, startedAt, progress: { kind: 'reconcile' } });
    try {
      const reconciliation = await api.request<Reconciliation>(
        `/wallets/${walletId}/reconciliation`,
        { body: {}, signal },
      );
      const progress = { kind: 'reconcile' as const, reconciliation };
      publish({ status: 'done', verdict: proof.judge(reconciliation), startedAt, progress });
    } catch (error) {
      if (!isAbort(error))
        publish({
          status: 'error',
          error: asApiError(error),
          startedAt,
          progress: { kind: 'reconcile' },
        });
    }
  }

  if (booting) return <p class="booting">Abrindo a wallet do link…</p>;

  const proof = isProofId(view) ? proofById(view) : undefined;
  return (
    <div class="console">
      <Rail
        wallet={wallet}
        view={view}
        role={role}
        runs={runs}
        onView={(next) => {
          if (next === 'tickets' || next === 'ledger') refreshWallet();
          go(next);
        }}
        onLeave={() => resetWallet(undefined, 'start')}
      />
      <main class="stage" id="conteudo">
        {bootError && view === 'start' && <ErrorNote error={bootError} />}
        {(!wallet || view === 'start') && (
          <StartView api={api} canCreate={can(role, 'demo-operator')} onWallet={openWallet} />
        )}
        {wallet && proof && (
          <ProofView
            key={proof.id}
            proof={proof}
            run={runs[proof.id]}
            canRun={can(role, proof.requires)}
            onRun={(amount) =>
              void (proof.kind === 'scenario'
                ? runScenario(proof, wallet.id, amount)
                : runReconcile(proof, wallet.id))
            }
            onStop={() => stops.current[proof.id]?.abort()}
          />
        )}
        {wallet && view === 'tickets' && (
          <TicketsView api={api} wallet={wallet} onRefresh={refreshWallet} />
        )}
        {wallet && view === 'ledger' && (
          <LedgerView api={api} wallet={wallet} onRefresh={refreshWallet} />
        )}
      </main>
    </div>
  );
}
