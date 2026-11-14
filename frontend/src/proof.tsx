import { useEffect, useRef, useState } from 'preact/hooks';
import { AmountField, ErrorNote } from './fields';
import { Icon } from './icons';
import { formatMoney, parseAmountInput } from './money';
import type { Proof, ScenarioProof } from './proofs';
import type { ProofRun, ScenarioProgress } from './run';
import { ReconcileTicket, Stamp, Ticket } from './ticket';
import './proof.css';

function heading(run: ProofRun) {
  if (run.status === 'done') return run.verdict.headline;
  if (run.status === 'error') return 'A prova não pôde ser executada.';
  return run.watching
    ? 'Acompanhando o estado atual de cada bilhete…'
    : 'Enviando pelo endpoint dos provedores…';
}

function ScenarioEvidenceView({
  proof,
  progress,
  watching,
}: {
  proof: ScenarioProof;
  progress: ScenarioProgress;
  watching: boolean;
}) {
  const { before, after, result, views } = progress;
  return (
    <>
      {before && (
        <div class="balance-strip" aria-label="Saldo antes e depois">
          <div>
            <span>Saldo antes</span>
            <strong class="num">{formatMoney(before)}</strong>
          </div>
          <Icon name="arrow" />
          <div>
            <span>Saldo depois</span>
            <strong class="num">{after ? formatMoney(after) : '…'}</strong>
          </div>
        </div>
      )}
      {result && (
        <div class="tickets">
          {result.transactions.map((submission, index) => {
            const spec = proof.tickets[index];
            return (
              <Ticket
                key={index}
                label={spec?.label ?? `Operação ${index + 1}`}
                expected={spec && { kind: spec.kind, amount: result.amount }}
                submission={submission}
                view={views[index]}
                watching={watching}
              />
            );
          })}
        </div>
      )}
    </>
  );
}

/** One proof: the guarantee, how to run it, and the verdict with its evidence where it was run. */
export function ProofView({
  proof,
  run,
  canRun,
  onRun,
  onStop,
}: {
  proof: Proof;
  run?: ProofRun;
  canRun: boolean;
  onRun: (amount?: string) => void;
  onStop: () => void;
}) {
  const takesAmount = proof.kind === 'scenario' && proof.defaultAmount !== undefined;
  const [amount, setAmount] = useState(() =>
    proof.kind === 'scenario' ? (proof.defaultAmount ?? '').replace('.', ',') : '',
  );
  const [amountError, setAmountError] = useState<string>();
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const running = run?.status === 'running';
  const settled = run?.status === 'done' || run?.status === 'error';

  useEffect(() => {
    if (settled) resultHeading.current?.focus();
  }, [settled, run?.startedAt]);

  function submit(event: Event) {
    event.preventDefault();
    if (!takesAmount) return onRun();
    const parsed = parseAmountInput(amount);
    if (!parsed || parsed === '0.00') return setAmountError('Use um valor positivo, como 5,00.');
    setAmountError(undefined);
    onRun(parsed);
  }

  return (
    <div class="proof">
      <header class="stage-head">
        <h1>{proof.guarantee}</h1>
        <p class="lede">{proof.how}</p>
      </header>

      {proof.steps && (
        <ol class="steps">
          {proof.steps.map((step) => (
            <li key={step.text}>
              {step.text}
              {step.command && (
                <>
                  {' '}
                  <code>{step.command}</code>
                </>
              )}
            </li>
          ))}
        </ol>
      )}

      {canRun ? (
        <form class="run-bar" onSubmit={submit} noValidate>
          {takesAmount ? (
            <AmountField
              id={`amount-${proof.id}`}
              label="Valor por operação"
              value={amount}
              onInput={setAmount}
              error={amountError}
            />
          ) : (
            <p class="run-note">{proof.note}</p>
          )}
          <div class="run-actions">
            {run?.status === 'running' && run.watching && (
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
        <section class="result" aria-labelledby={`result-${proof.id}`}>
          <div class="verdict" aria-live="polite">
            <h2
              id={`result-${proof.id}`}
              ref={resultHeading}
              tabIndex={-1}
              class={run.status === 'done' ? undefined : 'pending-heading'}
            >
              {heading(run)}
            </h2>
            {run.status === 'done' && <Stamp outcome={run.verdict.outcome} key={run.startedAt} />}
            {run.status === 'done' && run.verdict.detail && (
              <p class="muted">{run.verdict.detail}</p>
            )}
            {run.status === 'error' && <ErrorNote error={run.error} />}
          </div>
          {proof.kind === 'scenario' && run.progress.kind === 'scenario' && (
            <ScenarioEvidenceView
              proof={proof}
              progress={run.progress}
              watching={run.status === 'running' && run.watching}
            />
          )}
          {run.progress.kind === 'reconcile' && run.progress.reconciliation && (
            <div class="tickets">
              <ReconcileTicket result={run.progress.reconciliation} />
            </div>
          )}
        </section>
      )}
    </div>
  );
}
