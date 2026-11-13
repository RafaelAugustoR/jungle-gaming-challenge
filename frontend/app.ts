import Keycloak from 'keycloak-js';

type Wallet = {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
};
type Entry = {
  kind: string;
  externalTransactionId: string | null;
  direction: string;
  amount: string;
  balanceAfter: string;
  walletVersion: number;
};
type Reconciliation = {
  storedBalance: { amount: string; currency: string };
  calculatedBalance: { amount: string; currency: string };
  difference: { amount: string; currency: string };
  consistent: boolean;
  checkedEntries: number;
};
type TransactionView = {
  transactionId: string;
  providerId: string | null;
  externalTransactionId: string | null;
  playerId: string;
  walletId: string;
  roundId: string | null;
  gameId: string | null;
  kind: string;
  status: string;
  failureCode?: string;
  money: { amount: string; currency: string };
  balance?: { amount: string; currency: string };
  createdAt: string;
  processedAt: string | null;
  referenceExternalTransactionId?: string;
  originalReceipt: { httpStatus: number; body: Record<string, unknown> } | null;
};
const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const notice = (text: string, error = false) => {
  element('notice').textContent = text;
  element('notice').classList.toggle('error', error);
};
let identity: Keycloak;
let selected: Wallet | undefined;
let nextCursor: string | null = null;
let transactionPageCursor: string | null = null;
let transactionRequest = 0;
let detailRequest = 0;
const messages: Record<string, string> = {
  WALLET_ALREADY_EXISTS: 'Já existe uma wallet para esse jogador e moeda.',
  WALLET_NOT_FOUND: 'Wallet não encontrada. Confira o ID.',
  FORBIDDEN: 'Seu perfil não permite esta ação.',
  UNAUTHORIZED: 'Sua sessão expirou. Entre novamente.',
  INVALID_PAYLOAD: 'Confira o jogador, o ID e o valor informado.',
  AMOUNT_LIMIT_EXCEEDED: 'O valor ultrapassa o limite permitido.',
  INFRASTRUCTURE_UNAVAILABLE: 'O serviço está indisponível. Tente novamente.',
};
async function api(path: string, body?: unknown) {
  try {
    await identity.updateToken(30);
  } catch {
    throw new Error('Sua sessão expirou. Entre novamente.');
  }
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      `${messages[data.code] || 'Não foi possível concluir a solicitação.'}${data.correlationId ? ` Referência: ${data.correlationId}` : ''}`,
    );
  return data;
}
function clearWallet() {
  detailRequest++;
  element('transaction-detail').hidden = true;
  selected = undefined;
  nextCursor = null;
  element('wallet').hidden = true;
  element('empty').hidden = false;
  element('ledger-content').hidden = true;
  element('entries').replaceChildren();
  element('reconciliation').hidden = true;
  element('ledger-empty').hidden = false;
  element('ledger-empty').textContent = 'Selecione uma wallet para consultar os lançamentos.';
}
async function ledger(append = false) {
  if (!selected) return;
  const walletId = selected.id;
  const page = (await api(
    `/wallets/${walletId}/ledger${append && nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}` : ''}`,
  )) as { entries: Entry[]; nextCursor: string | null };
  if (selected?.id !== walletId) return;
  if (!append) element('entries').replaceChildren();
  for (const entry of page.entries) {
    const row = document.createElement('tr');
    const columns = [
      { value: entry.kind },
      { value: entry.externalTransactionId ?? '—' },
      { value: entry.direction },
      {
        value: entry.amount,
        className: entry.direction === 'CREDIT' ? 'number credit' : 'number',
      },
      { value: entry.balanceAfter, className: 'number' },
      { value: String(entry.walletVersion), className: 'number' },
    ];
    for (const column of columns) {
      const cell = document.createElement('td');
      cell.textContent = column.value;
      if (column.className) cell.classList.add(...column.className.split(' '));
      row.append(cell);
    }
    element('entries').append(row);
  }
  nextCursor = page.nextCursor;
  element('more').hidden = !nextCursor;
  element('ledger-content').hidden = element('entries').childElementCount === 0;
  element('ledger-empty').hidden = element('entries').childElementCount > 0;
  element('ledger-empty').textContent =
    'Nenhum lançamento. Uma abertura de 0.00 não movimenta o saldo.';
}
function transactionQuery(cursor?: string) {
  const query = new URLSearchParams({ limit: '50' });
  if (cursor) query.set('cursor', cursor);
  const walletId = element<HTMLInputElement>('filter-wallet').value.trim();
  const status = element<HTMLSelectElement>('filter-status').value;
  const kind = element<HTMLSelectElement>('filter-kind').value;
  if (walletId) query.set('walletId', walletId);
  if (status) query.set('status', status);
  if (kind) query.set('kind', kind);
  return query.toString();
}
function appendFields(target: HTMLDListElement, rows: Array<[string, string]>) {
  target.replaceChildren();
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = value || '—';
    row.append(term, description);
    target.append(row);
  }
}
function showTransactionRow(view: TransactionView) {
  const row = document.createElement('tr');
  for (const value of [
    `${view.kind} · ${view.externalTransactionId ?? view.transactionId}`,
    view.walletId,
    view.status,
    `${view.money.amount} ${view.money.currency}`,
    new Date(view.createdAt).toLocaleString('pt-BR'),
  ]) {
    const cell = document.createElement('td');
    cell.textContent = value;
    row.append(cell);
  }
  row.children[3]?.classList.add('number');
  const actionCell = document.createElement('td');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Detalhes';
  button.setAttribute(
    'aria-label',
    `Detalhes da transação ${view.externalTransactionId ?? view.transactionId}`,
  );
  button.addEventListener('click', () => void showTransaction(view.transactionId));
  actionCell.append(button);
  row.append(actionCell);
  element('transactions-rows').append(row);
}
async function loadTransactions(append = false) {
  const request = ++transactionRequest;
  const cursor = append ? transactionPageCursor : undefined;
  element('transactions-state').textContent = append
    ? 'Carregando mais transações…'
    : 'Carregando transações…';
  element('transactions-more').hidden = true;
  try {
    const page = (await api(`/wagering/transactions?${transactionQuery(cursor ?? undefined)}`)) as {
      transactions: TransactionView[];
      nextCursor: string | null;
    };
    if (request !== transactionRequest) return;
    if (!append) element('transactions-rows').replaceChildren();
    for (const transaction of page.transactions) showTransactionRow(transaction);
    transactionPageCursor = page.nextCursor;
    element('transactions-table-wrap').hidden = page.transactions.length === 0 && !append;
    const count = element('transactions-rows').childElementCount;
    element('transactions-state').textContent = count
      ? `${count} transação(ões) carregadas.`
      : 'Nenhuma transação corresponde aos filtros.';
    element('transactions-more').hidden = !page.nextCursor;
  } catch (error) {
    if (request !== transactionRequest) return;
    element('transactions-table-wrap').hidden = true;
    element('transactions-state').textContent =
      error instanceof Error ? error.message : 'Não foi possível carregar as transações.';
  }
}
async function showTransaction(transactionId: string) {
  const request = ++detailRequest;
  const section = element('transaction-detail');
  section.hidden = false;
  element('transaction-detail-state').textContent = 'Consultando estado atual…';
  try {
    const view = (await api(
      `/wagering/transactions/${encodeURIComponent(transactionId)}`,
    )) as TransactionView;
    if (request !== detailRequest) return;
    appendFields(element('transaction-fields'), [
      ['ID', view.transactionId],
      ['ID externo', view.externalTransactionId ?? '—'],
      ['Tipo', view.kind],
      ['Jogador', view.playerId],
      ['Wallet', view.walletId],
      ['Provedor', view.providerId ?? '—'],
      ['Referência', view.referenceExternalTransactionId ?? '—'],
      ['Falha', view.failureCode ?? '—'],
      [
        'Saldo resultante da operação',
        view.balance ? `${view.balance.amount} ${view.balance.currency}` : '—',
      ],
    ]);
    const receipt = view.originalReceipt?.body ?? {};
    appendFields(element('receipt-fields'), [
      ['HTTP', view.originalReceipt ? String(view.originalReceipt.httpStatus) : '—'],
      ['Estado de aceite', String(receipt.status ?? 'Não se aplica')],
      [
        'Saldo no aceite',
        receipt.balance && typeof receipt.balance === 'object'
          ? `${(receipt.balance as { amount?: string; currency?: string }).amount ?? '—'} ${(receipt.balance as { currency?: string }).currency ?? ''}`
          : '—',
      ],
      ['Replay', String(receipt.idempotentReplay ?? false)],
      ['Código', String(receipt.failureCode ?? receipt.code ?? '—')],
    ]);
    appendFields(element('current-fields'), [
      ['Estado consultado', view.status],
      ['Criada em', new Date(view.createdAt).toLocaleString('pt-BR')],
      ['Concluída em', view.processedAt ? new Date(view.processedAt).toLocaleString('pt-BR') : '—'],
      ['Falha atual', view.failureCode ?? '—'],
      ['Valor', `${view.money.amount} ${view.money.currency}`],
    ]);
    element('transaction-detail-state').textContent = 'Consulta atualizada agora.';
  } catch (error) {
    if (request === detailRequest)
      element('transaction-detail-state').textContent =
        error instanceof Error ? error.message : 'Falha ao consultar a transação.';
  }
}
async function reconcile() {
  if (!selected) return;
  const walletId = selected.id;
  const button = element<HTMLButtonElement>('reconcile');
  button.disabled = true;
  notice('Conferindo saldo e lançamentos…');
  try {
    const result = (await api(`/wallets/${walletId}/reconciliation`, {})) as Reconciliation;
    if (selected?.id !== walletId) return;
    element('reconciliation').hidden = false;
    element('reconciliation-status').textContent = result.consistent
      ? 'Saldo e ledger conferem.'
      : 'Divergência encontrada. Nenhum saldo foi alterado.';
    element('reconciliation-status').classList.toggle('error', !result.consistent);
    element('reconciliation-stored').textContent =
      `${result.storedBalance.amount} ${result.storedBalance.currency}`;
    element('reconciliation-calculated').textContent =
      `${result.calculatedBalance.amount} ${result.calculatedBalance.currency}`;
    element('reconciliation-difference').textContent =
      `${result.difference.amount} ${result.difference.currency}`;
    element('reconciliation-entries').textContent = String(result.checkedEntries);
    notice('Reconciliação concluída.');
  } catch (error) {
    if (selected?.id === walletId)
      notice(error instanceof Error ? error.message : 'Falha de conexão. Tente novamente.', true);
  } finally {
    if (selected?.id === walletId) button.disabled = false;
  }
}
async function showWallet(wallet: Wallet) {
  if (selected?.id !== wallet.id) {
    detailRequest++;
    element('transaction-detail').hidden = true;
  }
  selected = wallet;
  element<HTMLButtonElement>('reconcile').disabled = false;
  element('wallet').hidden = false;
  element('empty').hidden = true;
  element('wallet-player').textContent = wallet.playerId;
  element('wallet-id').textContent = wallet.id;
  element('version').textContent = String(wallet.version);
  element('balance').textContent = wallet.balance.amount;
  element('reconciliation').hidden = true;
  element<HTMLInputElement>('wallet-lookup').value = wallet.id;
  try {
    await ledger();
  } catch (error) {
    element('ledger-empty').textContent =
      'Não foi possível carregar o ledger. Consulte a wallet novamente.';
    throw error;
  }
}
async function action(form: HTMLFormElement, task: () => Promise<void>) {
  const button = form.querySelector('button')!;
  button.disabled = true;
  notice('Carregando…');
  try {
    await task();
    notice('Consulta atualizada.');
  } catch (error) {
    notice(error instanceof Error ? error.message : 'Falha de conexão. Tente novamente.', true);
  } finally {
    button.disabled = false;
  }
}
element<HTMLFormElement>('lookup').addEventListener('submit', (event) => {
  event.preventDefault();
  void action(event.currentTarget as HTMLFormElement, async () => {
    clearWallet();
    await showWallet(
      await api(
        `/wallets/${encodeURIComponent(element<HTMLInputElement>('wallet-lookup').value.trim())}`,
      ),
    );
  });
});
element<HTMLFormElement>('create').addEventListener('submit', (event) => {
  event.preventDefault();
  void action(event.currentTarget as HTMLFormElement, async () => {
    const wallet = await api('/wallets', {
      playerId: element<HTMLInputElement>('player').value.trim(),
      initialBalance: { amount: element<HTMLInputElement>('initial').value, currency: 'BRL' },
    });
    clearWallet();
    await showWallet(wallet);
    transactionPageCursor = null;
    await loadTransactions();
  });
});
element('more').addEventListener('click', async () => {
  const button = element<HTMLButtonElement>('more');
  button.disabled = true;
  try {
    await ledger(true);
  } catch (error) {
    notice(String(error), true);
  } finally {
    button.disabled = false;
  }
});
element('reconcile').addEventListener('click', () => void reconcile());
element<HTMLFormElement>('scenario').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  void action(form, async () => {
    const walletId = selected?.id;
    if (!walletId) throw new Error('Consulte ou crie uma wallet antes de executar o cenário.');
    const result = (await api('/demo/scenarios', {
      scenario: element<HTMLSelectElement>('scenario-kind').value,
      walletId,
      amount: element<HTMLInputElement>('scenario-amount').value,
    })) as { transactions: Array<{ originalReceipt: { transactionId: string } }> };
    await loadTransactions();
    if (selected?.id !== walletId) return;
    await showWallet(await api(`/wallets/${walletId}`));
    const first = result.transactions[0]?.originalReceipt.transactionId;
    if (first) await showTransaction(first);
    notice('Cenário concluído. Veja o recibo original e o estado atual da transação.');
  });
});
element<HTMLFormElement>('transaction-filters').addEventListener('submit', (event) => {
  event.preventDefault();
  transactionPageCursor = null;
  void loadTransactions();
});
element('refresh-transactions').addEventListener('click', () => {
  transactionPageCursor = null;
  void loadTransactions();
});
element('transactions-more').addEventListener('click', () => void loadTransactions(true));
element('close-detail').addEventListener('click', () => {
  detailRequest++;
  element('transaction-detail').hidden = true;
});
async function start() {
  const response = await fetch('/console-config');
  if (!response.ok) throw new Error('Configuração do console indisponível.');
  const config = await response.json();
  identity = new Keycloak(config);
  const authenticated = await identity.init({
    pkceMethod: 'S256',
    checkLoginIframe: false,
    responseMode: 'query',
  });
  const session = element<HTMLButtonElement>('session');
  session.disabled = false;
  session.addEventListener('click', () => {
    void (identity.authenticated
      ? identity.logout({ redirectUri: location.origin })
      : identity.login({ redirectUri: location.origin }));
  });
  identity.onTokenExpired = () => {
    void identity.updateToken(30).catch(() => {
      notice('Sua sessão expirou. Entre novamente.', true);
    });
  };
  if (!authenticated) {
    notice('Entre para acessar as wallets de demonstração.');
    return;
  }
  session.textContent = 'Sair';
  element('identity').textContent = identity.tokenParsed?.preferred_username ?? 'Usuário';
  element('welcome').hidden = true;
  if (!identity.hasRealmRole('viewer')) {
    notice('Seu perfil não tem acesso ao console.', true);
    return;
  }
  element('workspace').hidden = false;
  element('transactions-section').hidden = false;
  const canCreate = identity.hasRealmRole('demo-operator');
  const canReconcile = identity.hasRealmRole('operator');
  element('create').hidden = !canCreate;
  element('scenario').hidden = !canCreate;
  element('read-only').hidden = canCreate;
  element('reconcile').hidden = !canReconcile;
  notice(canCreate ? 'Crie uma wallet ou consulte uma existente.' : 'Acesso de consulta');
  void loadTransactions();
}
void start().catch(() => {
  notice('Não foi possível conectar ao login. Recarregue a página para tentar novamente.', true);
});
