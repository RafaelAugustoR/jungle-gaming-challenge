import { Icon } from './icons';
import { formatAmount } from './money';
import { proofs, type ProofId, type ViewId } from './proofs';
import { can, type Role } from './roles';
import { outcomeOf, type ProofRun } from './run';
import { CopyId, StateMark } from './ticket';
import type { Wallet } from './types';
import './rail.css';

const outcomeText = {
  held: ', garantia mantida',
  violated: ', garantia violada',
  inconclusive: ', inconclusiva',
} as const;

const evidenceViews = [
  ['tickets', 'Bilhetes', 'ticket'],
  ['ledger', 'Ledger', 'ledger'],
] as const;

export function Rail({
  wallet,
  view,
  role,
  runs,
  onView,
  onLeave,
}: {
  wallet?: Wallet;
  view: ViewId | 'start';
  role: Role;
  runs: Partial<Record<ProofId, ProofRun>>;
  onView: (view: ViewId) => void;
  onLeave: () => void;
}) {
  const proven = proofs.filter((proof) => outcomeOf(runs[proof.id]) === 'held').length;
  const showScore = !!wallet && can(role, 'demo-operator');
  const complete = showScore && proven === proofs.length;
  return (
    <aside class="rail" aria-label="Wallet e navegação">
      <section class="wallet-card" aria-labelledby="wallet-title">
        <h2 id="wallet-title" class="wallet-player">
          {wallet ? wallet.playerId : 'Nenhuma wallet aberta'}
        </h2>
        {wallet ? (
          <>
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
          <p class="balance balance-empty">
            <span class="currency">R$</span>
            <span class="num">—</span>
          </p>
        )}
      </section>

      <nav class="rail-nav" aria-label="Provas e evidências">
        <h2 class="rail-heading" id="nav-proofs">
          Provas
          {showScore && (
            <span
              class={`score num${complete ? ' score-complete' : ''}`}
              aria-label={`${proven} de ${proofs.length} garantias mantidas`}
            >
              {proven}/{proofs.length}
            </span>
          )}
        </h2>
        <ul aria-labelledby="nav-proofs">
          {proofs.map((proof) => {
            const run = runs[proof.id];
            const running = run?.status === 'running';
            const outcome = outcomeOf(run);
            const locked = !can(role, proof.requires);
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
                    {running ? ', executando' : outcome ? outcomeText[outcome] : ', não executada'}
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
          {evidenceViews.map(([id, label, icon]) => (
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
      {complete && (
        <p class="rail-complete" role="status">
          <StateMark tone="held" />
          <span>
            <strong>
              {proven} de {proofs.length} garantias mantidas
            </strong>
            <small>Todas provadas nesta wallet, com dados desta execução.</small>
          </span>
        </p>
      )}
      <p class="rail-foot">Sem dinheiro real. Os saldos e jogadores são fictícios.</p>
    </aside>
  );
}
