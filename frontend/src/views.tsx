import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, type Api } from './api';
import { Icon } from './icons';
import { formatMoney, parseAmountInput } from './money';
import { proofById, type ProofId, type Verdict } from './proofs';
import { ReconcileTicket, Stamp, Ticket } from './ticket';
import type {
  DemoScenarioResult,
  LedgerEntry,
  LedgerPage,
  Money,
  Reconciliation,
  TransactionPage,
  TransactionView,
  Wallet,
} from './types';

export interface ProofRun {
  status: 'running' | 'done' | 'error';
  startedAt: number;
  before?: Money;
  after?: Money;
  result?: DemoScenarioResult;
  views: (TransactionView | undefined)[];
  pendingSince?: number;
  watching?: boolean;
  reconciliation?: Reconciliation;
  verdict?: Verdict;
  error?: ApiError;
}

export function ErrorNote({ error }: { error: ApiError | Error }) {
  return (
    <p class="error-note" role="alert">
      <Icon name="alert" />
      <span>
        {error.message}
        {error instanceof ApiError && error.correlationId && (
          <>
            {' '}
            <span class="muted">
              Referência <code>{error.correlationId}</code>
            </span>
          </>
        )}
      </span>
    </p>
  );
}

function AmountField({
  id,
  label,
  value,
  onInput,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onInput: (v: string) => void;
  error?: string;
}) {
  return (
    <div class="field">
      <label for={id}>{label}</label>
      <div class={`money-input${error ? ' invalid' : ''}`}>
        <span aria-hidden="true">R$</span>
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          value={value}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? `${id}-error` : `${id}-help`}
          onInput={(event) => onInput(event.currentTarget.value)}
        />
      </div>
      {error ? (
        <small id={`${id}-error`} class="field-error">
          {error}
        </small>
      ) : (
        <small id={`${id}-help`}>Em reais, com vírgula nos centavos.</small>
      )}
    </div>
  );
}

/* ---------- Start: create or open a wallet ---------- */

export function StartView({
  api,
  canCreate,
  onWallet,
}: {
  api: Api;
  canCreate: boolean;
  onWallet: (wallet: Wallet, created: boolean) => void;
}) {
  const [player, setPlayer] = useState(() => `avaliador-${Math.random().toString(36).slice(2, 6)}`);
  const [initial, setInitial] = useState('100,00');
  const [walletId, setWalletId] = useState('');
  const [busy, setBusy] = useState<'create' | 'open' | undefined>();
  const [error, setError] = useState<{ form: 'create' | 'open'; error: Error }>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function create(event: Event) {
    event.preventDefault();
    const amount = parseAmountInput(initial);
    const errors: Record<string, string> = {};
    if (!player.trim()) errors.player = 'Informe um identificador para o jogador.';
    if (!amount) errors.initial = 'Use um valor como 100,00.';
    setFieldErrors(errors);
    if (Object.keys(errors).length) return;
    setBusy('create');
    setError(undefined);
    try {
      const wallet = await api.request<Wallet>('/wallets', {
        playerId: player.trim(),
        initialBalance: { amount, currency: 'BRL' },
      });
      onWallet(wallet, true);
    } catch (caught) {
      setError({ form: 'create', error: caught as Error });
    } finally {
      setBusy(undefined);
    }
  }

  async function open(event: Event) {
    event.preventDefault();
    const id = walletId.trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      setFieldErrors({ walletId: 'Cole o ID completo da wallet (UUID com 36 caracteres).' });
      return;
    }
    setFieldErrors({});
    setBusy('open');
    setError(undefined);
    try {
      onWallet(
        await api.request<Wallet>(`/wallets/${encodeURIComponent(id)}`, undefined, {
          INVALID_PAYLOAD: 'Esse não é um ID de wallet válido.',
        }),
        false,
      );
    } catch (caught) {
      setError({ form: 'open', error: caught as Error });
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div class="start">
      <header class="stage-head">
        <h1>{canCreate ? 'Comece por uma wallet' : 'Abra uma wallet'}</h1>
        <p class="lede">
          {canCreate
            ? 'Toda prova roda contra uma wallet de demonstração. Crie uma com saldo fictício ou abra uma existente pelo ID.'
            : 'Seu perfil consulta bilhetes e ledger. Abra uma wallet pelo ID para conferir as evidências.'}
        </p>
      </header>
      <div class="start-forms">
        {canCreate && (
          <form class="sheet" onSubmit={create} noValidate>
            <h2>Criar wallet de demonstração</h2>
            <p class="muted">O saldo inicial entra no ledger como lançamento de abertura.</p>
            <div class="field">
              <label for="player">Jogador</label>
              <input
                id="player"
                value={player}
                maxLength={128}
                autoComplete="off"
                aria-invalid={fieldErrors.player ? 'true' : undefined}
                aria-describedby={fieldErrors.player ? 'player-error' : undefined}
                onInput={(event) => setPlayer(event.currentTarget.value)}
              />
              {fieldErrors.player && (
                <small id="player-error" class="field-error">
                  {fieldErrors.player}
                </small>
              )}
            </div>
            <AmountField
              id="initial"
              label="Saldo inicial"
              value={initial}
              onInput={setInitial}
              error={fieldErrors.initial}
            />
            {error?.form === 'create' && <ErrorNote error={error.error} />}
            <button class="primary" type="submit" disabled={!!busy}>
              <Icon name="plus" />
              {busy === 'create' ? 'Criando…' : 'Criar wallet'}
            </button>
          </form>
        )}
        <form class="sheet" onSubmit={open} noValidate>
          <h2>Abrir wallet existente</h2>
          <p class="muted">
            Cole o ID. Ele também pode vir no link: <code>?wallet=…</code>
          </p>
          <div class="field">
            <label for="wallet-id">ID da wallet</label>
            <input
              id="wallet-id"
              value={walletId}
              autoComplete="off"
              spellcheck={false}
              placeholder="00000000-0000-0000-0000-000000000000"
              aria-invalid={fieldErrors.walletId ? 'true' : undefined}
              aria-describedby={fieldErrors.walletId ? 'wallet-id-error' : undefined}
              onInput={(event) => setWalletId(event.currentTarget.value)}
            />
            {fieldErrors.walletId && (
              <small id="wallet-id-error" class="field-error">
                {fieldErrors.walletId}
              </small>
            )}
          </div>
          {error?.form === 'open' && <ErrorNote error={error.error} />}
          <button type="submit" disabled={!!busy}>
            <Icon name="search" />
            {busy === 'open' ? 'Abrindo…' : 'Abrir wallet'}
          </button>
        </form>
      </div>
    </div>
  );
}

/* ---------- A proof ---------- */

const ticketLabels: Record<string, string[]> = {
  race: ['Aposta A', 'Aposta B'],
  duplicate: ['1º envio', '2º envio · mesma chave'],
  'out-of-order': ['Chega 1º · estorno', 'Chega 2º · aposta'],
};

export function ProofView({
  proofId,
  run,
  canRun,
  onRun,
  onStop,
}: {
  proofId: ProofId;
  run?: ProofRun;
  canRun: boolean;
  onRun: (amount?: string) => void;
  onStop: () => void;
}) {
  const proof = proofById(proofId);
  const [amount, setAmount] = useState(() => (proof.defaultAmount ?? '').replace('.', ','));
  const [amountError, setAmountError] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const running = run?.status === 'running';

  useEffect(() => {
    if (!run?.watching) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run?.watching]);

  const settled = run?.status === 'done' || run?.status === 'error';
  useEffect(() => {
    if (settled) resultHeading.current?.focus();
  }, [settled, run?.startedAt]);

  function submit(event: Event) {
    event.preventDefault();
    if (!proof.takesAmount) return onRun();
    const parsed = parseAmountInput(amount);
    if (!parsed || parsed === '0.00') {
      setAmountError('Use um valor positivo, como 5,00.');
      return;
    }
    setAmountError(undefined);
    onRun(parsed);
  }

  const labels = proof.scenario ? (ticketLabels[proof.scenario] ?? []) : [];
  return (
    <div class="proof">
      <header class="stage-head">
        <h1>{proof.guarantee}</h1>
        <p class="lede">{proof.how}</p>
      </header>

      {proofId === 'recovery' && (
        <ol class="steps">
          <li>
            No terminal do ambiente local, derrube o worker:{' '}
            <code>docker compose kill reference-worker</code>
          </li>
          <li>Execute a prova. O estorno fica pendente e o console acompanha por GET.</li>
          <li>
            Suba o worker de novo: <code>docker compose start reference-worker</code>
          </li>
        </ol>
      )}

      {canRun ? (
        <form class="run-bar" onSubmit={submit} noValidate>
          {proof.takesAmount ? (
            <AmountField
              id={`amount-${proofId}`}
              label="Valor por operação"
              value={amount}
              onInput={setAmount}
              error={amountError}
            />
          ) : (
            <p class="run-note">
              {proofId === 'race'
                ? 'O servidor calcula 80% do saldo atual para as duas apostas.'
                : 'A reconciliação só lê o ledger. Ela não altera saldo.'}
            </p>
          )}
          <div class="run-actions">
            {run?.watching && (
              <button type="button" onClick={onStop}>
                <Icon name="stop" />
                Parar de acompanhar
              </button>
            )}
            <button class="primary run" type="submit" disabled={running}>
              <Icon name={running ? 'clock' : 'arrow'} />
              {running ? 'Executando…' : run ? 'Executar de novo' : 'Executar prova'}
            </button>
          </div>
        </form>
      ) : (
        <p class="locked">
          <Icon name="lock" />
          {proof.requires === 'demo-operator'
            ? 'Executar provas exige o perfil demo-operator. Você pode conferir as evidências em Bilhetes e Ledger.'
            : 'A reconciliação exige o perfil operator.'}
        </p>
      )}

      {run && (
        <section class="result" aria-labelledby={`result-${proofId}`}>
          <div class="verdict" aria-live="polite">
            <h2
              id={`result-${proofId}`}
              ref={resultHeading}
              tabIndex={-1}
              class={run.verdict && run.status === 'done' ? undefined : 'pending-heading'}
            >
              {run.status === 'done' && run.verdict
                ? run.verdict.headline
                : run.error
                  ? 'A prova não pôde ser executada.'
                  : run.watching
                    ? 'Acompanhando o estado atual de cada bilhete…'
                    : 'Enviando pelo endpoint dos provedores…'}
            </h2>
            {run.verdict && run.status === 'done' && (
              <Stamp outcome={run.verdict.outcome} key={run.startedAt} />
            )}
            {run.verdict?.detail && <p class="muted">{run.verdict.detail}</p>}
            {run.error && <ErrorNote error={run.error} />}
          </div>

          {run.before && (
            <div class="balance-strip" aria-label="Saldo antes e depois">
              <div>
                <span>Saldo antes</span>
                <strong class="num">{formatMoney(run.before)}</strong>
              </div>
              <Icon name="arrow" />
              <div>
                <span>Saldo depois</span>
                <strong class="num">{run.after ? formatMoney(run.after) : '…'}</strong>
              </div>
            </div>
          )}

          {run.reconciliation && (
            <div class="tickets">
              <ReconcileTicket result={run.reconciliation} />
            </div>
          )}

          {run.result && (
            <div class="tickets">
              {run.result.transactions.map((submission, index) => (
                <Ticket
                  key={`${run.startedAt}-${index}`}
                  label={labels[index] ?? `Operação ${index + 1}`}
                  kind={
                    proofId === 'race' || proofId === 'duplicate'
                      ? 'BET'
                      : index === 0
                        ? 'REFUND'
                        : 'BET'
                  }
                  amount={run.result!.amount}
                  externalId={run.views[index]?.externalTransactionId ?? null}
                  submission={submission}
                  view={run.views[index]}
                  watching={run.watching}
                  pendingSince={run.pendingSince}
                  now={now}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/* ---------- Evidence: tickets of the wallet ---------- */

export function TicketsView({
  api,
  wallet,
  onRefresh,
}: {
  api: Api;
  wallet: Wallet;
  onRefresh: () => void;
}) {
  const [items, setItems] = useState<TransactionView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<Error>();
  const epoch = useRef(0);

  async function load(append: boolean) {
    const current = ++epoch.current;
    setState('loading');
    try {
      const query = new URLSearchParams({ walletId: wallet.id, limit: '20' });
      if (append && cursor) query.set('cursor', cursor);
      const page = await api.request<TransactionPage>(`/wagering/transactions?${query}`);
      if (current !== epoch.current) return;
      setItems((previous) => (append ? [...previous, ...page.transactions] : page.transactions));
      setCursor(page.nextCursor);
      setState('ready');
    } catch (caught) {
      if (current !== epoch.current) return;
      setError(caught as Error);
      setState('error');
    }
  }
  useEffect(() => {
    setItems([]);
    void load(false);
  }, [wallet.id, wallet.version]);

  return (
    <div class="evidence">
      <header class="stage-head stage-head-row">
        <div>
          <h1>Bilhetes da wallet</h1>
          <p class="lede">
            Cada operação com o recibo original no canhoto e o estado atual na validação. Mais
            recentes primeiro.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            onRefresh();
            void load(false);
          }}
          disabled={state === 'loading'}
        >
          <Icon name="refresh" />
          Atualizar
        </button>
      </header>
      {state === 'error' && error && <ErrorNote error={error} />}
      {state === 'ready' && items.length === 0 && (
        <p class="empty">Nenhuma operação nesta wallet ainda.</p>
      )}
      <div class="tickets" aria-busy={state === 'loading'}>
        {items.map((view) => (
          <Ticket
            key={view.transactionId}
            label={new Date(view.createdAt).toLocaleString('pt-BR', {
              dateStyle: 'short',
              timeStyle: 'medium',
            })}
            kind={view.kind}
            amount={view.money}
            externalId={view.externalTransactionId}
            view={view}
          />
        ))}
      </div>
      {state === 'loading' && <p class="muted loading">Carregando bilhetes…</p>}
      {cursor && state === 'ready' && (
        <button type="button" class="more" onClick={() => void load(true)}>
          Carregar mais bilhetes
        </button>
      )}
    </div>
  );
}

/* ---------- Evidence: ledger ---------- */

export function LedgerView({
  api,
  wallet,
  onRefresh,
}: {
  api: Api;
  wallet: Wallet;
  onRefresh: () => void;
}) {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<Error>();
  const epoch = useRef(0);

  async function load(append: boolean) {
    const current = ++epoch.current;
    setState('loading');
    try {
      const page = await api.request<LedgerPage>(
        `/wallets/${wallet.id}/ledger${append && cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      if (current !== epoch.current) return;
      setEntries((previous) => (append ? [...previous, ...page.entries] : page.entries));
      setCursor(page.nextCursor);
      setState('ready');
    } catch (caught) {
      if (current !== epoch.current) return;
      setError(caught as Error);
      setState('error');
    }
  }
  useEffect(() => {
    setEntries([]);
    void load(false);
  }, [wallet.id, wallet.version]);

  const last = entries.at(-1);
  const closes = !cursor && last ? last.balanceAfter === wallet.balance.amount : undefined;
  const currency = wallet.balance.currency;
  return (
    <div class="evidence">
      <header class="stage-head stage-head-row">
        <div>
          <h1>Ledger da wallet</h1>
          <p class="lede">
            Lançamentos imutáveis em ordem de versão. O saldo corrente precisa fechar com o saldo da
            wallet.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            onRefresh();
            void load(false);
          }}
          disabled={state === 'loading'}
        >
          <Icon name="refresh" />
          Atualizar
        </button>
      </header>
      {state === 'error' && error && <ErrorNote error={error} />}
      {state === 'ready' && entries.length === 0 && (
        <p class="empty">Nenhum lançamento. Uma abertura de 0,00 não movimenta o saldo.</p>
      )}
      {entries.length > 0 && (
        <div class="table-wrap">
          <table class="ledger">
            <caption class="sr-only">Lançamentos do ledger da wallet {wallet.playerId}</caption>
            <thead>
              <tr>
                <th scope="col" class="num">
                  Versão
                </th>
                <th scope="col">Operação</th>
                <th scope="col">ID externo</th>
                <th scope="col" class="num">
                  Débito
                </th>
                <th scope="col" class="num">
                  Crédito
                </th>
                <th scope="col" class="num">
                  Saldo após
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td class="num" data-label="Versão">
                    {entry.walletVersion}
                  </td>
                  <td data-label="Operação">
                    <span class="kind-tag">{entry.kind}</span>
                  </td>
                  <td class="ext" data-label="ID externo">
                    {entry.externalTransactionId ? (
                      <code>{entry.externalTransactionId}</code>
                    ) : (
                      <span class="muted">abertura interna</span>
                    )}
                  </td>
                  <td class="num debit" data-label="Débito">
                    {entry.direction === 'DEBIT'
                      ? `−${formatMoney({ amount: entry.amount, currency })}`
                      : ''}
                  </td>
                  <td class="num credit" data-label="Crédito">
                    {entry.direction === 'CREDIT'
                      ? `+${formatMoney({ amount: entry.amount, currency })}`
                      : ''}
                  </td>
                  <td class="num running" data-label="Saldo após">
                    {formatMoney({ amount: entry.balanceAfter, currency })}
                  </td>
                </tr>
              ))}
            </tbody>
            {closes !== undefined && (
              <tfoot>
                <tr class={closes ? 'closes' : 'diverges'}>
                  <th scope="row" colSpan={5}>
                    {closes ? 'Fecha com o saldo da wallet' : 'Não fecha com o saldo da wallet'}
                  </th>
                  <td class="num">{formatMoney(wallet.balance)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {state === 'loading' && <p class="muted loading">Carregando lançamentos…</p>}
      {cursor && state === 'ready' && (
        <button type="button" class="more" onClick={() => void load(true)}>
          Carregar mais lançamentos
        </button>
      )}
    </div>
  );
}
