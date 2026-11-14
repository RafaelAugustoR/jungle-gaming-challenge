import { useState } from 'preact/hooks';
import { Icon } from './icons';
import { formatMoney } from './money';
import type { Outcome } from './proofs';
import type { DemoSubmission, Reconciliation, TransactionView } from './types';

const statusLabels: Record<string, string> = {
  PROCESSED: 'Processada',
  PENDING: 'Pendente',
  PENDING_REFERENCE: 'Aguardando referência',
  REJECTED: 'Recusada',
  FAILED: 'Falhou',
};
const failureLabels: Record<string, string> = {
  INSUFFICIENT_FUNDS: 'Saldo insuficiente',
  REVERSAL_INSUFFICIENT_FUNDS: 'Saldo insuficiente para estornar',
  REFERENCE_NOT_FOUND: 'Referência não encontrada',
  REFERENCE_NOT_READY: 'Referência não ficou pronta no prazo',
  ALREADY_REVERSED: 'Já estornada',
  AMOUNT_LIMIT_EXCEEDED: 'Limite de valor excedido',
};

export type Tone = 'held' | 'pending' | 'void' | 'none';
export function statusTone(status?: string): Tone {
  if (!status) return 'none';
  if (status === 'PROCESSED') return 'held';
  if (status === 'PENDING' || status === 'PENDING_REFERENCE') return 'pending';
  return 'void';
}

/** Fixed-cell state mark: filled holds, hollow waits, struck voids. Always paired with text. */
export function StateMark({
  tone,
  size = 'md',
}: {
  tone: Tone | Outcome | 'running';
  size?: 'sm' | 'md';
}) {
  const kind =
    tone === 'held'
      ? 'held'
      : tone === 'violated' || tone === 'void'
        ? 'void'
        : tone === 'none'
          ? 'none'
          : 'pending';
  return (
    <span
      class={`mark mark-${kind} mark-${size}${tone === 'running' ? ' mark-running' : ''}`}
      aria-hidden="true"
    >
      {kind === 'void' && <Icon name="strike" size={size === 'sm' ? 12 : 14} />}
    </span>
  );
}

export function Status({ status, failureCode }: { status?: string; failureCode?: string | null }) {
  if (!status) return <span class="status status-none">Consultando…</span>;
  return (
    <span class={`status status-${statusTone(status)}`}>
      <StateMark tone={statusTone(status)} size="sm" />
      <span>
        {statusLabels[status] ?? status}
        {failureCode ? ` · ${failureLabels[failureCode] ?? failureCode}` : ''}
      </span>
      <code>{status}</code>
    </span>
  );
}

export function CopyId({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span class="copy-id">
      <code title={value}>{value}</code>
      <button
        type="button"
        class="icon-button"
        aria-label={copied ? `${label} copiado` : `Copiar ${label}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          });
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} size={15} />
      </button>
    </span>
  );
}

const time = (iso?: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '—';

interface TicketProps {
  label: string;
  kind: string;
  amount: { amount: string; currency: string };
  externalId: string | null;
  submission?: DemoSubmission | null;
  view?: TransactionView;
  watching?: boolean;
  pendingSince?: number;
  now?: number;
}

/**
 * The signature object: the original receipt on the stub, the current state on the validation side,
 * separated by a perforation. The two halves never share a cell, so immutable and current cannot blur.
 */
export function Ticket({
  label,
  kind,
  amount,
  externalId,
  submission,
  view,
  watching,
  pendingSince,
  now,
}: TicketProps) {
  const receipt = submission?.originalReceipt ?? view?.originalReceipt ?? null;
  const body = receipt?.body;
  const changed = !!body && !!view && body.status !== view.status;
  const pendingFor = pendingSince && now ? Math.max(0, Math.round((now - pendingSince) / 1000)) : 0;
  return (
    <article
      class={`ticket tone-${statusTone(view?.status ?? body?.status)}`}
      aria-label={`${label}: ${kind} ${formatMoney(amount)}`}
    >
      <header class="ticket-head">
        <span class="ticket-label">{label}</span>
        <span class="ticket-kind">{kind}</span>
        <span class="ticket-amount">{formatMoney(amount)}</span>
        {externalId && <code class="ticket-serial">{externalId}</code>}
      </header>
      <div class="ticket-body">
        <section class="stub" aria-label="Recibo original">
          <h4>
            Recibo original <span>imutável</span>
          </h4>
          {receipt && body ? (
            <dl>
              <div>
                <dt>HTTP</dt>
                <dd class="num">{receipt.httpStatus}</dd>
              </div>
              <div>
                <dt>Aceite</dt>
                <dd>
                  <Status
                    status={body.status}
                    failureCode={body.status === 'REJECTED' ? body.failureCode : null}
                  />
                </dd>
              </div>
              <div>
                <dt>Replay</dt>
                <dd class={body.idempotentReplay ? 'replay-yes' : undefined}>
                  {body.idempotentReplay ? 'Sim, mesmo recibo' : 'Não'}
                </dd>
              </div>
              <div>
                <dt>Saldo no aceite</dt>
                <dd class="num">{formatMoney(body.balance)}</dd>
              </div>
            </dl>
          ) : (
            <p class="stub-empty">Abertura interna da wallet. Não há recibo de provedor.</p>
          )}
        </section>
        <div class="perforation" aria-hidden="true" />
        <section
          class="validation"
          aria-label="Estado atual"
          aria-live={watching ? 'polite' : undefined}
        >
          <h4>
            Estado atual <span>{watching ? 'acompanhando por GET' : 'consultado por GET'}</span>
          </h4>
          <dl>
            <div class={changed ? 'changed' : undefined}>
              <dt>Estado</dt>
              <dd>
                <Status status={view?.status} failureCode={view?.failureCode} />
                {changed && <em class="changed-note">mudou desde o aceite</em>}
              </dd>
            </div>
            <div>
              <dt>Saldo após</dt>
              <dd class="num">{view?.balance ? formatMoney(view.balance) : '—'}</dd>
            </div>
            <div>
              <dt>
                {view && statusTone(view.status) === 'pending' ? 'Pendente há' : 'Concluída às'}
              </dt>
              <dd class="num">
                {view && statusTone(view.status) === 'pending'
                  ? `${String(Math.floor(pendingFor / 60)).padStart(2, '0')}:${String(pendingFor % 60).padStart(2, '0')}`
                  : time(view?.processedAt)}
              </dd>
            </div>
            <div>
              <dt>ID interno</dt>
              <dd>
                {view ? (
                  <CopyId value={view.transactionId} label="ID da transação" />
                ) : body ? (
                  <CopyId value={body.transactionId} label="ID da transação" />
                ) : (
                  '—'
                )}
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </article>
  );
}

/** Reconciliation as a checked ticket: the ledger's sum on the stub, the stored balance on validation. */
export function ReconcileTicket({ result }: { result: Reconciliation }) {
  return (
    <article
      class={`ticket ${result.consistent ? 'tone-held' : 'tone-void'}`}
      aria-label="Bilhete de reconciliação"
    >
      <header class="ticket-head">
        <span class="ticket-label">Conferência do ledger</span>
        <span class="ticket-kind">RECONCILIAÇÃO</span>
        <span class="ticket-amount">{result.checkedEntries} lançamentos</span>
      </header>
      <div class="ticket-body">
        <section class="stub" aria-label="Reconstruído do ledger">
          <h4>
            Reconstruído <span>soma do journal imutável</span>
          </h4>
          <p class="ticket-figure num">{formatMoney(result.calculatedBalance)}</p>
        </section>
        <div class="perforation" aria-hidden="true" />
        <section class="validation" aria-label="Saldo registrado">
          <h4>
            Registrado <span>saldo materializado da wallet</span>
          </h4>
          <p class="ticket-figure num">{formatMoney(result.storedBalance)}</p>
          <p class={result.consistent ? 'difference' : 'difference changed-note'}>
            Diferença <strong class="num">{formatMoney(result.difference)}</strong>
          </p>
        </section>
      </div>
    </article>
  );
}

const stampText: Record<Outcome, string> = {
  held: 'Garantia mantida',
  violated: 'Garantia violada',
  inconclusive: 'Inconclusiva',
};

export function Stamp({ outcome }: { outcome: Outcome }) {
  return (
    <span class={`stamp stamp-${outcome}`}>
      <span>{stampText[outcome]}</span>
    </span>
  );
}
