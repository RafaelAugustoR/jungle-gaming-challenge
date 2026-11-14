import Keycloak from 'keycloak-js';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, createApi, followTransaction, type Api } from './api';
import { Icon, Mark } from './icons';
import { formatAmount } from './money';
import {
  proofById,
  proofs,
  reconciliationVerdict,
  scenarioVerdict,
  type Outcome,
  type ProofId,
  type ViewId,
} from './proofs';
import { CopyId, StateMark } from './ticket';
import type { DemoScenarioResult, Reconciliation, Role, TransactionView, Wallet } from './types';
import { ErrorNote, LedgerView, ProofView, StartView, TicketsView, type ProofRun } from './views';

interface Session {
  identity: Keycloak;
  api: Api;
  username: string;
  role: Role | undefined;
}

const roleLabel: Record<Role, string> = {
  'demo-operator': 'executa provas',
  operator: 'consulta e reconcilia',
  viewer: 'só consulta',
};

function readUrl() {
  const params = new URLSearchParams(location.search);
  return { wallet: params.get('wallet') ?? undefined, view: params.get('view') ?? undefined };
}
function writeUrl(wallet?: string, view?: string) {
  const params = new URLSearchParams();
  if (wallet) params.set('wallet', wallet);
  if (wallet && view) params.set('view', view);
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}`);
}

/* ---------- Shell pieces ---------- */

function TopBar({ session, onLogout }: { session?: Session; onLogout?: () => void }) {
  return (
    <header class="topbar">
      <a class="brand" href="/" aria-label="Lastro, início">
        <Mark />
        <span>
          Lastro <span class="brand-sub">Console de prova</span>
        </span>
      </a>
      <div class="topbar-end">
        <span class="env">Dados fictícios · BRL</span>
        {session && (
          <>
            <span class="who">
              <strong>{session.username}</strong>
              {session.role && <span>{roleLabel[session.role]}</span>}
            </span>
            <button type="button" class="ghost" onClick={onLogout}>
              <Icon name="logout" />
              Sair
            </button>
          </>
        )}
      </div>
    </header>
  );
}

function Landing({
  onLogin,
  state,
}: {
  onLogin: () => void;
  state: 'connecting' | 'ready' | 'error';
}) {
  return (
    <div class="landing">
      <section class="landing-copy">
        <h1>Cada garantia do processador de apostas, provada com os dados da execução.</h1>
        <p class="lede">
          O console dispara cenários reais pelo mesmo endpoint e com a mesma identidade de máquina
          dos provedores. Cada operação vira um bilhete: o recibo original no canhoto, o estado
          atual na via de validação.
        </p>
        <button class="primary large" type="button" onClick={onLogin} disabled={state !== 'ready'}>
          {state === 'connecting' ? 'Conectando ao login…' : 'Entrar'}
          <Icon name="arrow" />
        </button>
        {state === 'error' && (
          <ErrorNote
            error={
              new Error(
                'Não foi possível conectar ao serviço de login. Recarregue a página para tentar de novo.',
              )
            }
          />
        )}
        <dl class="profiles">
          <div>
            <dt>demo-operator</dt>
            <dd>cria wallets e executa as provas</dd>
          </div>
          <div>
            <dt>operator</dt>
            <dd>consulta e reconcilia</dd>
          </div>
          <div>
            <dt>viewer</dt>
            <dd>só consulta bilhetes e ledger</dd>
          </div>
        </dl>
      </section>
      <section class="landing-list" aria-labelledby="landing-proofs">
        <div class="landing-ticket">
          <header class="ticket-head">
            <h2 id="landing-proofs" class="ticket-label">
              O que você vai provar
            </h2>
            <span class="ticket-kind">5 GARANTIAS</span>
          </header>
          <ol>
            {proofs.map((proof) => (
              <li key={proof.id}>
                <StateMark tone="none" />
                <span class="landing-n num">{proof.number}</span>
                <span>
                  <strong>{proof.guarantee}</strong>
                  <span class="muted">{proof.short}</span>
                </span>
              </li>
            ))}
          </ol>
          <div class="perforation perforation-h" aria-hidden="true" />
          <p class="landing-stub">
            Canhoto: cada garantia recebe seu carimbo no console, com os recibos e o ledger daquela
            execução.
          </p>
        </div>
      </section>
    </div>
  );
}

function Rail({
  wallet,
  view,
  role,
  outcomes,
  runs,
  onView,
  onLeave,
}: {
  wallet?: Wallet;
  view: ViewId | 'start';
  role: Role | undefined;
  outcomes: Partial<Record<ProofId, Outcome>>;
  runs: Partial<Record<ProofId, ProofRun>>;
  onView: (view: ViewId) => void;
  onLeave: () => void;
}) {
  const canProve = role === 'demo-operator';
  const visible = proofs.filter((proof) => proof.id !== 'reconcile' || role !== 'viewer');
  const proven = proofs.filter((proof) => outcomes[proof.id] === 'held').length;
  return (
    <aside class="rail" aria-label="Wallet e navegação">
      <section class="wallet-card" aria-labelledby="wallet-title">
        {wallet ? (
          <>
            <h2 id="wallet-title" class="wallet-player">
              {wallet.playerId}
            </h2>
            <p
              class="balance"
              data-testid="wallet-balance"
              aria-label={`Saldo R$ ${formatAmount(wallet.balance.amount)}`}
            >
              <span class="currency">R$</span>
              <span class="num">{formatAmount(wallet.balance.amount)}</span>
            </p>
            <dl class="wallet-meta">
              <div>
                <dt>Versão</dt>
                <dd class="num">{wallet.version}</dd>
              </div>
              <div>
                <dt>ID</dt>
                <dd data-testid="wallet-id">
                  <CopyId value={wallet.id} label="ID da wallet" />
                </dd>
              </div>
            </dl>
            <button type="button" class="rail-link" onClick={onLeave}>
              Trocar de wallet
            </button>
          </>
        ) : (
          <>
            <h2 id="wallet-title" class="wallet-player">
              Nenhuma wallet aberta
            </h2>
            <p class="balance balance-empty">
              <span class="currency">R$</span>
              <span class="num">—</span>
            </p>
          </>
        )}
      </section>

      <nav class="rail-nav" aria-label="Provas e evidências">
        <h2 class="rail-heading" id="nav-proofs">
          Provas
          {wallet && canProve && (
            <span
              class={`score num${proven === visible.length ? ' score-complete' : ''}`}
              aria-label={`${proven} de ${visible.length} garantias mantidas`}
            >
              {proven}/{visible.length}
            </span>
          )}
        </h2>
        <ul aria-labelledby="nav-proofs">
          {visible.map((proof) => {
            const running = runs[proof.id]?.status === 'running';
            const outcome = outcomes[proof.id];
            const locked = proof.requires === 'demo-operator' ? !canProve : role === 'viewer';
            return (
              <li key={proof.id}>
                <button
                  type="button"
                  class="rail-item"
                  aria-current={view === proof.id ? 'page' : undefined}
                  disabled={!wallet}
                  onClick={() => onView(proof.id)}
                >
                  <StateMark tone={running ? 'running' : (outcome ?? 'none')} />
                  <span class="rail-n num">{proof.number}</span>
                  <span class="rail-label">{proof.short}</span>
                  {locked && <Icon name="lock" size={14} class="rail-lock" />}
                  <span class="sr-only">
                    {running
                      ? ', executando'
                      : outcome === 'held'
                        ? ', garantia mantida'
                        : outcome === 'violated'
                          ? ', garantia violada'
                          : outcome === 'inconclusive'
                            ? ', inconclusiva'
                            : ', não executada'}
                    {locked ? ', somente leitura' : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <h2 class="rail-heading" id="nav-evidence">
          Evidências
        </h2>
        <ul aria-labelledby="nav-evidence">
          {(
            [
              ['tickets', 'Bilhetes', 'ticket'],
              ['ledger', 'Ledger', 'ledger'],
            ] as const
          ).map(([id, label, icon]) => (
            <li key={id}>
              <button
                type="button"
                class="rail-item"
                aria-current={view === id ? 'page' : undefined}
                disabled={!wallet}
                onClick={() => onView(id)}
              >
                <Icon name={icon} />
                <span class="rail-label">{label}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      {wallet && canProve && proven === visible.length && (
        <p class="rail-complete" role="status">
          <StateMark tone="held" />
          <span>
            <strong>
              {proven} de {visible.length} garantias mantidas
            </strong>
            <small>Todas provadas nesta wallet, com dados desta execução.</small>
          </span>
        </p>
      )}
      <p class="rail-foot">Sem dinheiro real. Os saldos e jogadores são fictícios.</p>
    </aside>
  );
}

/* ---------- The console ---------- */

function Console({ session }: { session: Session }) {
  const { api, role } = session;
  const [wallet, setWallet] = useState<Wallet>();
  const [view, setView] = useState<ViewId | 'start'>('start');
  const [runs, setRuns] = useState<Partial<Record<ProofId, ProofRun>>>({});
  const [outcomes, setOutcomes] = useState<Partial<Record<ProofId, Outcome>>>({});
  const [boot, setBoot] = useState<'loading' | 'ready'>('loading');
  const [bootError, setBootError] = useState<Error>();
  const epoch = useRef(0);
  const cancels = useRef<Partial<Record<ProofId, () => void>>>({});
  const stage = useRef<HTMLElement>(null);
  const canProve = role === 'demo-operator';
  const canReconcile = role === 'demo-operator' || role === 'operator';

  function openWallet(next: Wallet, created: boolean) {
    epoch.current++;
    Object.values(cancels.current).forEach((cancel) => cancel?.());
    cancels.current = {};
    setRuns({});
    setOutcomes({});
    setWallet(next);
    const firstView: ViewId = created && canProve ? 'race' : 'tickets';
    setView(firstView);
    writeUrl(next.id, firstView);
  }

  useEffect(() => {
    const { wallet: walletId, view: requested } = readUrl();
    if (!walletId) {
      setBoot('ready');
      return;
    }
    api
      .request<Wallet>(`/wallets/${encodeURIComponent(walletId)}`)
      .then((loaded) => {
        openWallet(loaded, false);
        const allowed = [...proofs.map((proof) => proof.id), 'tickets', 'ledger'] as string[];
        if (requested && allowed.includes(requested)) {
          setView(requested as ViewId);
          writeUrl(loaded.id, requested);
        }
      })
      .catch((caught) => setBootError(caught as Error))
      .finally(() => setBoot('ready'));
  }, []);

  function refreshWallet() {
    if (!wallet) return;
    const current = epoch.current;
    api
      .request<Wallet>(`/wallets/${wallet.id}`)
      .then((fresh) => current === epoch.current && setWallet(fresh))
      .catch(() => undefined);
  }

  function go(next: ViewId | 'start') {
    if (next === 'tickets' || next === 'ledger') refreshWallet();
    setView(next);
    writeUrl(next === 'start' ? undefined : wallet?.id, next === 'start' ? undefined : next);
    stage.current?.scrollTo?.({ top: 0 });
    window.scrollTo({ top: 0 });
  }

  function patch(proof: ProofId, current: number, update: Partial<ProofRun>) {
    if (current !== epoch.current) return;
    setRuns((previous) => ({ ...previous, [proof]: { ...previous[proof]!, ...update } }));
  }

  async function runScenario(proofId: ProofId, amount?: string) {
    if (!wallet) return;
    const proof = proofById(proofId);
    const current = epoch.current;
    const startedAt = Date.now();
    let cancelled = false;
    cancels.current[proofId]?.();
    cancels.current[proofId] = () => (cancelled = true);
    const live = () => !cancelled && current === epoch.current;
    setRuns((previous) => ({
      ...previous,
      [proofId]: { status: 'running', startedAt, views: [] },
    }));
    try {
      const fresh = await api.request<Wallet>(`/wallets/${wallet.id}`);
      if (current !== epoch.current) return;
      setWallet(fresh);
      patch(proofId, current, { before: fresh.balance });
      const result = await api.request<DemoScenarioResult>('/demo/scenarios', {
        scenario: proof.scenario,
        walletId: wallet.id,
        ...(amount ? { amount } : {}),
      });
      const views: (TransactionView | undefined)[] = result.transactions.map(() => undefined);
      const pendingReceipt = result.transactions.some(
        (t) => t.originalReceipt.body.status === 'PENDING_REFERENCE',
      );
      let pendingMs = 0;
      const submittedAt = Date.now();
      patch(proofId, current, {
        result,
        views: [...views],
        watching: true,
        pendingSince: pendingReceipt ? Date.now() : undefined,
      });
      const deadlineMs = proofId === 'recovery' ? 10 * 60_000 : 15_000;
      await Promise.all(
        result.transactions.map((submission, index) =>
          followTransaction(api, submission.originalReceipt.body.transactionId, {
            deadlineMs,
            isCurrent: live,
            onUpdate: (update) => {
              if (update.status === 'PENDING_REFERENCE') pendingMs = Date.now() - submittedAt;
              views[index] = update;
              patch(proofId, current, { views: [...views] });
            },
          }).catch(() => undefined),
        ),
      );
      if (current !== epoch.current) return;
      const after = await api.request<Wallet>(`/wallets/${wallet.id}`);
      if (current !== epoch.current) return;
      setWallet(after);
      const verdict = scenarioVerdict(proofId, {
        result,
        views,
        before: fresh.balance,
        after: after.balance,
        pendingMs,
      });
      patch(proofId, current, { status: 'done', watching: false, after: after.balance, verdict });
      setOutcomes((previous) => ({ ...previous, [proofId]: verdict.outcome }));
    } catch (caught) {
      patch(proofId, current, {
        status: 'error',
        watching: false,
        error: caught instanceof ApiError ? caught : new ApiError((caught as Error).message),
      });
    } finally {
      if (current === epoch.current) delete cancels.current[proofId];
    }
  }

  async function runReconcile() {
    if (!wallet) return;
    const current = epoch.current;
    const startedAt = Date.now();
    setRuns((previous) => ({
      ...previous,
      reconcile: { status: 'running', startedAt, views: [] },
    }));
    try {
      const reconciliation = await api.request<Reconciliation>(
        `/wallets/${wallet.id}/reconciliation`,
        {},
      );
      const verdict = reconciliationVerdict(reconciliation);
      patch('reconcile', current, { status: 'done', reconciliation, verdict });
      if (current === epoch.current)
        setOutcomes((previous) => ({ ...previous, reconcile: verdict.outcome }));
    } catch (caught) {
      patch('reconcile', current, { status: 'error', error: caught as ApiError });
    }
  }

  if (boot === 'loading') return <p class="booting">Abrindo a wallet do link…</p>;

  const isProof = view !== 'start' && view !== 'tickets' && view !== 'ledger';
  return (
    <div class="console">
      <Rail
        wallet={wallet}
        view={view}
        role={role}
        outcomes={outcomes}
        runs={runs}
        onView={go}
        onLeave={() => {
          epoch.current++;
          setWallet(undefined);
          setRuns({});
          setOutcomes({});
          go('start');
        }}
      />
      <main class="stage" ref={stage} id="conteudo">
        {bootError && view === 'start' && <ErrorNote error={bootError} />}
        {(!wallet || view === 'start') && (
          <StartView api={api} canCreate={canProve} onWallet={openWallet} />
        )}
        {wallet && isProof && (
          <ProofView
            key={view}
            proofId={view as ProofId}
            run={runs[view as ProofId]}
            canRun={view === 'reconcile' ? canReconcile : canProve}
            onRun={(amount) =>
              void (view === 'reconcile' ? runReconcile() : runScenario(view as ProofId, amount))
            }
            onStop={() => cancels.current[view as ProofId]?.()}
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

/* ---------- Boot ---------- */

function App() {
  const [identity, setIdentity] = useState<Keycloak>();
  const [session, setSession] = useState<Session>();
  const [state, setState] = useState<'connecting' | 'ready' | 'error' | 'no-access'>('connecting');

  useEffect(() => {
    (async () => {
      const response = await fetch('/console-config');
      if (!response.ok) throw new Error('config');
      const keycloak = new Keycloak(await response.json());
      const authenticated = await keycloak.init({
        onLoad: 'check-sso',
        pkceMethod: 'S256',
        checkLoginIframe: false,
        responseMode: 'query',
      });
      setIdentity(keycloak);
      if (!authenticated) return setState('ready');
      if (!keycloak.hasRealmRole('viewer')) return setState('no-access');
      const role: Role = keycloak.hasRealmRole('demo-operator')
        ? 'demo-operator'
        : keycloak.hasRealmRole('operator')
          ? 'operator'
          : 'viewer';
      setSession({
        identity: keycloak,
        api: createApi(keycloak),
        username: keycloak.tokenParsed?.preferred_username ?? 'usuário',
        role,
      });
      setState('ready');
    })().catch(() => setState('error'));
  }, []);

  const logout = () => void identity?.logout({ redirectUri: location.origin });
  return (
    <>
      <a class="skip" href="#conteudo">
        Pular para o conteúdo
      </a>
      <TopBar session={session} onLogout={logout} />
      {session ? (
        <Console session={session} />
      ) : state === 'no-access' ? (
        <main class="landing" id="conteudo">
          <section class="landing-copy">
            <h1>Seu usuário não tem acesso ao console.</h1>
            <p class="lede">
              Entre com um dos perfis de demonstração: viewer, operator ou demo-operator.
            </p>
            <button class="primary" type="button" onClick={logout}>
              Sair e trocar de usuário
            </button>
          </section>
        </main>
      ) : (
        <main id="conteudo">
          <Landing
            state={state === 'connecting' ? 'connecting' : state === 'error' ? 'error' : 'ready'}
            onLogin={() => void identity?.login({ redirectUri: location.href })}
          />
        </main>
      )}
    </>
  );
}

render(<App />, document.getElementById('app')!);
