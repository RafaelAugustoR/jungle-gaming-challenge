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
const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const notice = (text: string, error = false) => {
  element('notice').textContent = text;
  element('notice').classList.toggle('error', error);
};
let identity: Keycloak;
let selected: Wallet | undefined;
let nextCursor: string | null = null;
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
  const page = (await api(
    `/wallets/${selected.id}/ledger${append && nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}` : ''}`,
  )) as { entries: Entry[]; nextCursor: string | null };
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
    element('reconciliation-stored').textContent = `${result.storedBalance.amount} ${result.storedBalance.currency}`;
    element('reconciliation-calculated').textContent = `${result.calculatedBalance.amount} ${result.calculatedBalance.currency}`;
    element('reconciliation-difference').textContent = `${result.difference.amount} ${result.difference.currency}`;
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
  const canCreate = identity.hasRealmRole('demo-operator');
  const canReconcile = identity.hasRealmRole('operator');
  element('create').hidden = !canCreate;
  element('read-only').hidden = canCreate;
  element('reconcile').hidden = !canReconcile;
  notice(canCreate ? 'Crie uma wallet ou consulte uma existente.' : 'Acesso de consulta');
}
void start().catch(() => {
  notice('Não foi possível conectar ao login. Recarregue a página para tentar novamente.', true);
});
