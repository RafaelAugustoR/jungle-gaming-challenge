import { useState } from 'preact/hooks';
import type { Api } from './api';
import { AmountField, ErrorNote } from './fields';
import { Icon } from './icons';
import { parseAmountInput } from './money';
import type { Wallet } from './types';
import './start.css';

/** First step of every proof: create a demo wallet or open one by ID. */
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
  const [busy, setBusy] = useState<'create' | 'open'>();
  const [error, setError] = useState<{ form: 'create' | 'open'; error: Error }>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(form: 'create' | 'open', task: () => Promise<void>) {
    setBusy(form);
    setError(undefined);
    try {
      await task();
    } catch (caught) {
      setError({ form, error: caught as Error });
    } finally {
      setBusy(undefined);
    }
  }

  function create(event: Event) {
    event.preventDefault();
    const amount = parseAmountInput(initial);
    const errors: Record<string, string> = {};
    if (!player.trim()) errors.player = 'Informe um identificador para o jogador.';
    if (!amount) errors.initial = 'Use um valor como 100,00.';
    setFieldErrors(errors);
    if (Object.keys(errors).length) return;
    void submit('create', async () => {
      const body = { playerId: player.trim(), initialBalance: { amount, currency: 'BRL' } };
      onWallet(await api.request<Wallet>('/wallets', { body }), true);
    });
  }

  function open(event: Event) {
    event.preventDefault();
    const id = walletId.trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      setFieldErrors({ walletId: 'Cole o ID completo da wallet (UUID com 36 caracteres).' });
      return;
    }
    setFieldErrors({});
    void submit('open', async () => {
      const wallet = await api.request<Wallet>(`/wallets/${encodeURIComponent(id)}`, {
        messages: { INVALID_PAYLOAD: 'Esse não é um ID de wallet válido.' },
      });
      onWallet(wallet, false);
    });
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
