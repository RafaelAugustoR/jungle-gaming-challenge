// The proof table is the console's source of truth: everything a proof needs (copy, tickets, how
// long to follow, who may run it and how it is judged) lives in its definition. Judges are pure and
// only read what the API returned in this run.
import { formatMoney, fromMinor, toMinor } from './money';
import type { Role } from './roles';
import { isPendingStatus } from './status';
import type {
  DemoScenarioResult,
  Money,
  Reconciliation,
  TransactionKind,
  TransactionView,
} from './types';

export type Outcome = 'held' | 'violated' | 'inconclusive';
export interface Verdict {
  outcome: Outcome;
  headline: string;
  detail?: string;
}

/** Everything a scenario run produced: receipts, the last GET of each ticket and the balances. */
export interface ScenarioEvidence {
  result: DemoScenarioResult;
  views: (TransactionView | undefined)[];
  before: Money;
  after: Money;
  /** How long GETs kept observing a deferred reference as pending (0 when never). */
  pendingMs: number;
}

interface ProofBase {
  id: string;
  number: number;
  short: string;
  guarantee: string;
  how: string;
  requires: Role;
  /** Shown instead of an amount field, when the proof takes none. */
  note?: string;
  /** Manual steps the evaluator runs in a terminal around the proof. */
  steps?: readonly { text: string; command?: string }[];
}
export interface ScenarioProof extends ProofBase {
  kind: 'scenario';
  scenario: DemoScenarioResult['scenario'];
  tickets: readonly { label: string; kind: TransactionKind }[];
  followMs: number;
  defaultAmount?: string;
  judge: (evidence: ScenarioEvidence) => Verdict;
}
export interface ReconcileProof extends ProofBase {
  kind: 'reconcile';
  judge: (result: Reconciliation) => Verdict;
}
export type Proof = ScenarioProof | ReconcileProof;

/** Longer than the reference worker's normal retry cycle: a pending this long means it was down. */
export const RECOVERY_PENDING_MS = 5000;

const signed = (minor: bigint, currency: string) => {
  const sign = minor > 0n ? '+' : minor < 0n ? '−' : '±';
  return `${sign}${formatMoney({ amount: fromMinor(minor < 0n ? -minor : minor), currency })}`;
};
const change = ({ before, after }: ScenarioEvidence) =>
  toMinor(after.amount) - toMinor(before.amount);

/** Shared guard: a verdict needs the current state of every ticket. */
function unread(evidence: ScenarioEvidence): Verdict | undefined {
  if (evidence.views.every(Boolean)) return undefined;
  return {
    outcome: 'inconclusive',
    headline: 'Não foi possível consultar o estado atual de todos os bilhetes.',
    detail: 'Os recibos originais estão abaixo. Abra a aba Bilhetes para consultar de novo.',
  };
}

export function judgeRace(evidence: ScenarioEvidence): Verdict {
  const missing = unread(evidence);
  if (missing) return missing;
  const { result, views, before, after } = evidence;
  const delta = change(evidence);
  const text = signed(delta, result.amount.currency);
  const processed = views.filter((view) => view!.status === 'PROCESSED').length;
  const rejected = views.filter(
    (view) => view!.status === 'REJECTED' && view!.failureCode === 'INSUFFICIENT_FUNDS',
  ).length;
  const oneDebit = delta === -toMinor(result.amount.amount) && toMinor(after.amount) >= 0n;
  if (processed === 1 && rejected === 1 && oneDebit)
    return {
      outcome: 'held',
      headline: `Duas apostas de ${formatMoney(result.amount)} disputaram ${formatMoney(before)}: uma foi aceita, a outra recusada por saldo insuficiente.`,
      detail: `Um único débito (${text}). O saldo terminou em ${formatMoney(after)}, nunca abaixo de zero.`,
    };
  return {
    outcome: 'violated',
    headline: `Esperado: 1 aceita e 1 recusada com débito de ${formatMoney(result.amount)}. Observado: ${processed} aceita(s), ${rejected} recusada(s), saldo ${text}.`,
  };
}

export function judgeDuplicate(evidence: ScenarioEvidence): Verdict {
  const missing = unread(evidence);
  if (missing) return missing;
  const { result, views } = evidence;
  const delta = change(evidence);
  const text = signed(delta, result.amount.currency);
  const ids = new Set(result.transactions.map((t) => t.originalReceipt.body.transactionId));
  const replays = result.transactions.filter((t) => t.originalReceipt.body.idempotentReplay).length;
  const processed = views[0]!.status === 'PROCESSED';
  const expected = processed ? -toMinor(result.amount.amount) : 0n;
  if (ids.size === 1 && replays === 1 && delta === expected)
    return {
      outcome: 'held',
      headline: processed
        ? `Dois envios de ${formatMoney(result.amount)} com a mesma chave viraram uma transação e um débito só.`
        : 'Dois envios com a mesma chave viraram uma transação só, recusada uma vez, sem efeito duplicado.',
      detail: `O segundo recibo é um replay do primeiro (idempotentReplay: true). Saldo ${text}.`,
    };
  return {
    outcome: 'violated',
    headline: `Esperado: 1 transação e 1 replay. Observado: ${ids.size} transação(ões), ${replays} replay(s), saldo ${text}.`,
  };
}

/** REFUND first (it references the BET), then the BET: the refund must wait and then net to zero. */
export function judgeReference(evidence: ScenarioEvidence): Verdict {
  const missing = unread(evidence);
  if (missing) return missing;
  const { result, views } = evidence;
  const [refund] = result.transactions;
  const [refundView, betView] = views;
  const delta = change(evidence);
  const text = signed(delta, result.amount.currency);
  if (isPendingStatus(refundView!.status))
    return {
      outcome: 'inconclusive',
      headline: 'O REFUND segue pendente, aguardando o worker de referências.',
      detail:
        'O worker de referências pode estar parado. Use a prova 4 para acompanhar a recuperação.',
    };
  if (refund?.originalReceipt.body.status !== 'PENDING_REFERENCE')
    return {
      outcome: 'violated',
      headline: `O REFUND deveria ter sido aceito como pendente (202), mas o recibo diz ${refund?.originalReceipt.body.status}.`,
    };
  if (refundView!.status === 'PROCESSED' && betView!.status === 'PROCESSED' && delta === 0n)
    return {
      outcome: 'held',
      headline:
        'O REFUND chegou antes da BET, esperou como pendente e foi resolvido quando ela chegou.',
      detail: `Débito e estorno de ${formatMoney(result.amount)} se anulam: saldo ${text}.`,
    };
  return {
    outcome: 'violated',
    headline: `Esperado: REFUND e BET processados e saldo inalterado. Observado: REFUND ${refundView!.status}, BET ${betView!.status}, saldo ${text}.`,
  };
}

/** The reference rules, plus proof that the refund outlived the worker's normal cycle. */
export function judgeRecovery(evidence: ScenarioEvidence): Verdict {
  const base = judgeReference(evidence);
  const seconds = evidence.pendingMs / 1000;
  if (base.outcome === 'inconclusive')
    return {
      ...base,
      detail: 'Suba o worker de novo para ver a recuperação. O acompanhamento continua.',
    };
  if (base.outcome !== 'held') return base;
  if (evidence.pendingMs < RECOVERY_PENDING_MS)
    return {
      outcome: 'inconclusive',
      headline: `O REFUND foi resolvido em ${seconds.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s: o worker estava ativo, não houve falha para recuperar.`,
      detail: 'Derrube o reference-worker antes de executar para ver a pendência e a recuperação.',
    };
  return {
    outcome: 'held',
    headline: `O REFUND ficou pendente por ${Math.round(seconds)} s, esperou o worker voltar e foi processado. Nada se perdeu na queda.`,
    detail: base.detail,
  };
}

export function judgeReconciliation(result: Reconciliation): Verdict {
  return result.consistent
    ? {
        outcome: 'held',
        headline: `Os ${result.checkedEntries} lançamentos do ledger reconstroem exatamente o saldo registrado.`,
        detail: `Registrado ${formatMoney(result.storedBalance)} · reconstruído ${formatMoney(result.calculatedBalance)} · diferença ${formatMoney(result.difference)}.`,
      }
    : {
        outcome: 'violated',
        headline: `Divergência de ${formatMoney(result.difference)} entre o saldo registrado e o ledger.`,
        detail: 'Nenhum saldo foi alterado. A divergência fica registrada em log e métrica.',
      };
}

const outOfOrderTickets = [
  { label: 'Chega 1º · estorno', kind: 'REFUND' },
  { label: 'Chega 2º · aposta', kind: 'BET' },
] as const;

export const proofs = [
  {
    kind: 'scenario',
    id: 'race',
    number: 1,
    short: 'Disputa pelo saldo',
    guarantee: 'O saldo nunca fica negativo',
    how: 'Duas apostas de 80% do saldo chegam ao mesmo tempo, com chaves diferentes. Só uma pode caber.',
    note: 'O servidor calcula 80% do saldo atual para as duas apostas.',
    scenario: 'race',
    tickets: [
      { label: 'Aposta A', kind: 'BET' },
      { label: 'Aposta B', kind: 'BET' },
    ],
    followMs: 15_000,
    requires: 'demo-operator',
    judge: judgeRace,
  },
  {
    kind: 'scenario',
    id: 'duplicate',
    number: 2,
    short: 'Repetição idempotente',
    guarantee: 'Uma aposta repetida debita uma vez só',
    how: 'A mesma aposta é enviada duas vezes em paralelo, com a mesma chave de idempotência.',
    scenario: 'duplicate',
    tickets: [
      { label: '1º envio', kind: 'BET' },
      { label: '2º envio · mesma chave', kind: 'BET' },
    ],
    followMs: 15_000,
    defaultAmount: '5.00',
    requires: 'demo-operator',
    judge: judgeDuplicate,
  },
  {
    kind: 'scenario',
    id: 'out-of-order',
    number: 3,
    short: 'Referência fora de ordem',
    guarantee: 'Um estorno espera a aposta que ele referencia',
    how: 'Um REFUND chega antes da BET que ele estorna. Ele fica pendente e é resolvido quando a BET é processada.',
    scenario: 'out-of-order',
    tickets: outOfOrderTickets,
    followMs: 15_000,
    defaultAmount: '5.00',
    requires: 'demo-operator',
    judge: judgeReference,
  },
  {
    kind: 'scenario',
    id: 'recovery',
    number: 4,
    short: 'Recuperação após falha',
    guarantee: 'Trabalho pendente sobrevive à queda do worker',
    how: 'Com o reference-worker derrubado, o REFUND fica pendente. Quando o worker volta, ele retoma e processa.',
    steps: [
      {
        text: 'No terminal do ambiente local, derrube o worker:',
        command: 'docker compose kill reference-worker',
      },
      { text: 'Execute a prova. O estorno fica pendente e o console acompanha por GET.' },
      { text: 'Suba o worker de novo:', command: 'docker compose start reference-worker' },
    ],
    scenario: 'out-of-order',
    tickets: outOfOrderTickets,
    followMs: 10 * 60_000,
    defaultAmount: '5.00',
    requires: 'demo-operator',
    judge: judgeRecovery,
  },
  {
    kind: 'reconcile',
    id: 'reconcile',
    number: 5,
    short: 'Reconciliação',
    guarantee: 'O ledger reconstrói o saldo da wallet',
    how: 'O servidor soma todos os lançamentos imutáveis da wallet e compara com o saldo registrado.',
    note: 'A reconciliação só lê o ledger. Ela não altera saldo.',
    requires: 'operator',
    judge: judgeReconciliation,
  },
] as const satisfies readonly Proof[];

export type ProofId = (typeof proofs)[number]['id'];
export type EvidenceView = 'tickets' | 'ledger';
export type ViewId = ProofId | EvidenceView;

export const isProofId = (value: unknown): value is ProofId =>
  proofs.some((proof) => proof.id === value);
export const isViewId = (value: unknown): value is ViewId =>
  isProofId(value) || value === 'tickets' || value === 'ledger';
export type ProofEntry = (typeof proofs)[number];
export type ScenarioEntry = Extract<ProofEntry, { kind: 'scenario' }>;
export type ReconcileEntry = Extract<ProofEntry, { kind: 'reconcile' }>;
export const proofById = (id: ProofId): ProofEntry => proofs.find((proof) => proof.id === id)!;
