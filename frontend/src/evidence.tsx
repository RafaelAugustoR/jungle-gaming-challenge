import type { ComponentChildren } from 'preact';
import type { Api } from './api';
import { ErrorNote } from './fields';
import { Icon } from './icons';
import { formatMoney } from './money';
import { usePagedList, type FetchPage } from './paged-list';
import { Ticket } from './ticket';
import type { LedgerEntry, Page, TransactionView, Wallet } from './types';
import './evidence.css';

/** Shared frame of an evidence page: title, refresh, and the list's loading/empty/error/more states. */
function EvidencePage<T>({
  title,
  lede,
  empty,
  more,
  list,
  onRefresh,
  children,
}: {
  title: string;
  lede: string;
  empty: string;
  more: string;
  list: ReturnType<typeof usePagedList<T>>;
  onRefresh: () => void;
  children: ComponentChildren;
}) {
  return (
    <div class="evidence">
      <header class="stage-head stage-head-row">
        <div>
          <h1>{title}</h1>
          <p class="lede">{lede}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            onRefresh();
            void list.reload();
          }}
          disabled={list.state === 'loading'}
        >
          <Icon name="refresh" />
          Atualizar
        </button>
      </header>
      {list.state === 'error' && list.error && <ErrorNote error={list.error} />}
      {list.state === 'ready' && list.items.length === 0 && <p class="empty">{empty}</p>}
      {list.items.length > 0 && children}
      {list.state === 'loading' && <p class="muted loading">Carregando…</p>}
      {list.hasMore && list.state === 'ready' && (
        <button type="button" class="more" onClick={() => void list.loadMore()}>
          {more}
        </button>
      )}
    </div>
  );
}

interface EvidenceProps {
  api: Api;
  wallet: Wallet;
  onRefresh: () => void;
}

export function TicketsView({ api, wallet, onRefresh }: EvidenceProps) {
  const fetchPage: FetchPage<TransactionView> = async (cursor, signal) => {
    const query = new URLSearchParams({ walletId: wallet.id, limit: '20' });
    if (cursor) query.set('cursor', cursor);
    const page = await api.request<{ transactions: TransactionView[]; nextCursor: string | null }>(
      `/wagering/transactions?${query}`,
      { signal },
    );
    return {
      items: page.transactions,
      nextCursor: page.nextCursor,
    } satisfies Page<TransactionView>;
  };
  const list = usePagedList(fetchPage, [wallet.id, wallet.version]);
  return (
    <EvidencePage
      title="Bilhetes da wallet"
      lede="Cada operação com o recibo original no canhoto e o estado atual na validação. Mais recentes primeiro."
      empty="Nenhuma operação nesta wallet ainda."
      more="Carregar mais bilhetes"
      list={list}
      onRefresh={onRefresh}
    >
      <div class="tickets">
        {list.items.map((view) => (
          <Ticket
            key={view.transactionId}
            label={new Date(view.createdAt).toLocaleString('pt-BR', {
              dateStyle: 'short',
              timeStyle: 'medium',
            })}
            view={view}
          />
        ))}
      </div>
    </EvidencePage>
  );
}

export function LedgerView({ api, wallet, onRefresh }: EvidenceProps) {
  const fetchPage: FetchPage<LedgerEntry> = async (cursor, signal) => {
    const page = await api.request<{ entries: LedgerEntry[]; nextCursor: string | null }>(
      `/wallets/${wallet.id}/ledger${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      { signal },
    );
    return { items: page.entries, nextCursor: page.nextCursor };
  };
  const list = usePagedList(fetchPage, [wallet.id, wallet.version]);
  const last = list.items.at(-1);
  const closes = !list.hasMore && last ? last.balanceAfter === wallet.balance.amount : undefined;
  const money = (amount: string) => formatMoney({ amount, currency: wallet.balance.currency });
  return (
    <EvidencePage
      title="Ledger da wallet"
      lede="Lançamentos imutáveis em ordem de versão. O saldo corrente precisa fechar com o saldo da wallet."
      empty="Nenhum lançamento. Uma abertura de 0,00 não movimenta o saldo."
      more="Carregar mais lançamentos"
      list={list}
      onRefresh={onRefresh}
    >
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
            {list.items.map((entry) => (
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
                  {entry.direction === 'DEBIT' ? `−${money(entry.amount)}` : ''}
                </td>
                <td class="num credit" data-label="Crédito">
                  {entry.direction === 'CREDIT' ? `+${money(entry.amount)}` : ''}
                </td>
                <td class="num running" data-label="Saldo após">
                  {money(entry.balanceAfter)}
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
    </EvidencePage>
  );
}
