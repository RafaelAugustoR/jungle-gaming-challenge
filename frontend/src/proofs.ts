// Pure verdict logic: every verdict is computed from what the API returned in this run.
import { formatMoney, fromMinor, toMinor } from './money';
import type { DemoScenarioResult, Money, Reconciliation, TransactionView } from './types';

export type ProofId = 'race' | 'duplicate' | 'out-of-order' | 'recovery' | 'reconcile';
export type Outcome = 'held' | 'violated' | 'inconclusive';
export type EvidenceView = 'tickets' | 'ledger';
export type ViewId = ProofId | EvidenceView;

export interface ProofDefinition {
  id: ProofId;
  number: number;
  short: string;
  guarantee: string;
  how: string;
  scenario?: DemoScenarioResult['scenario'];
  takesAmount: boolean;
  defaultAmount?: string;
  requires: 'demo-operator' | 'operator';
}

export const proofs: readonly ProofDefinition[] = [
  {
    id: 'race',
    number: 1,
    short: 'Disputa pelo saldo',
    guarantee: 'O saldo nunca fica negativo',
    how: 'Duas apostas de 80% do saldo chegam ao mesmo tempo, com chaves diferentes. Só uma pode caber.',
    scenario: 'race',
    takesAmount: false,
    requires: 'demo-operator',
  },
  {
    id: 'duplicate',
    number: 2,
    short: 'Repetição idempotente',
    guarantee: 'Uma aposta repetida debita uma vez só',
    how: 'A mesma aposta é enviada duas vezes em paralelo, com a mesma chave de idempotência.',
    scenario: 'duplicate',
    takesAmount: true,
    defaultAmount: '5.00',
    requires: 'demo-operator',
  },
  {
    id: 'out-of-order',
    number: 3,
    short: 'Referência fora de ordem',
    guarantee: 'Um estorno espera a aposta que ele referencia',
    how: 'Um REFUND chega antes da BET que ele estorna. Ele fica pendente e é resolvido quando a BET é processada.',
    scenario: 'out-of-order',
    takesAmount: true,
    defaultAmount: '5.00',
    requires: 'demo-operator',
  },
  {
    id: 'recovery',
    number: 4,
    short: 'Recuperação após falha',
    guarantee: 'Trabalho pendente sobrevive à queda do worker',
    how: 'Com o reference-worker derrubado, o REFUND fica pendente. Quando o worker volta, ele retoma e processa.',
    scenario: 'out-of-order',
    takesAmount: true,
    defaultAmount: '5.00',
    requires: 'demo-operator',
  },
  {
    id: 'reconcile',
    number: 5,
    short: 'Reconciliação',
    guarantee: 'O ledger reconstrói o saldo da wallet',
    how: 'O servidor soma todos os lançamentos imutáveis da wallet e compara com o saldo registrado.',
    takesAmount: false,
    requires: 'operator',
  },
];

export const proofById = (id: ProofId) => proofs.find((proof) => proof.id === id)!;

export interface Verdict {
  outcome: Outcome;
  headline: string;
  detail?: string;
}

const terminal = (view?: TransactionView) =>
  !!view && !['PENDING', 'PENDING_REFERENCE'].includes(view.status);

function delta(before: Money, after: Money) {
  return toMinor(after.amount) - toMinor(before.amount);
}

function signed(minor: bigint, currency: string) {
  const sign = minor > 0n ? '+' : minor < 0n ? '−' : '±';
  const absolute = minor < 0n ? -minor : minor;
  return `${sign}${formatMoney({ amount: fromMinor(absolute), currency })}`;
}

/** Longer than the reference worker's normal retry cycle: a pending this long means the worker was down. */
export const RECOVERY_PENDING_MS = 5000;

export interface ScenarioEvidence {
  result: DemoScenarioResult;
  views: (TransactionView | undefined)[];
  before: Money;
  after: Money;
  /** For the recovery proof: how long GETs kept observing the refund as pending. */
  pendingMs?: number;
}

export function scenarioVerdict(proof: ProofId, evidence: ScenarioEvidence): Verdict {
  const { result, views, before, after } = evidence;
  const currency = result.amount.currency;
  const amount = formatMoney(result.amount);
  const change = delta(before, after);
  const changeText = signed(change, currency);
  if (views.some((view) => !view))
    return {
      outcome: 'inconclusive',
      headline: 'Não foi possível consultar o estado atual de todos os bilhetes.',
      detail: 'Os recibos originais estão abaixo. Abra a aba Bilhetes para consultar de novo.',
    };

  if (proof === 'race') {
    const processed = views.filter((view) => view!.status === 'PROCESSED').length;
    const rejected = views.filter(
      (view) => view!.status === 'REJECTED' && view!.failureCode === 'INSUFFICIENT_FUNDS',
    ).length;
    const expectedChange = -toMinor(result.amount.amount);
    if (
      processed === 1 &&
      rejected === 1 &&
      change === expectedChange &&
      toMinor(after.amount) >= 0n
    )
      return {
        outcome: 'held',
        headline: `Duas apostas de ${amount} disputaram ${formatMoney(before)}: uma foi aceita, a outra recusada por saldo insuficiente.`,
        detail: `Um único débito (${changeText}). O saldo terminou em ${formatMoney(after)}, nunca abaixo de zero.`,
      };
    return {
      outcome: 'violated',
      headline: `Esperado: 1 aceita e 1 recusada com débito de ${amount}. Observado: ${processed} aceita(s), ${rejected} recusada(s), saldo ${changeText}.`,
    };
  }

  if (proof === 'duplicate') {
    const ids = new Set(result.transactions.map((t) => t.originalReceipt.body.transactionId));
    const replays = result.transactions.filter(
      (t) => t.originalReceipt.body.idempotentReplay,
    ).length;
    const processed = views[0]!.status === 'PROCESSED';
    const expectedChange = processed ? -toMinor(result.amount.amount) : 0n;
    if (ids.size === 1 && replays === 1 && change === expectedChange)
      return {
        outcome: 'held',
        headline: processed
          ? `Dois envios de ${amount} com a mesma chave viraram uma transação e um débito só.`
          : `Dois envios com a mesma chave viraram uma transação só, recusada uma vez, sem efeito duplicado.`,
        detail: `O segundo recibo é um replay do primeiro (idempotentReplay: true). Saldo ${changeText}.`,
      };
    return {
      outcome: 'violated',
      headline: `Esperado: 1 transação e 1 replay. Observado: ${ids.size} transação(ões), ${replays} replay(s), saldo ${changeText}.`,
    };
  }

  // out-of-order and recovery: REFUND first (references the BET), then the BET.
  const [refund, bet] = result.transactions;
  const [refundView, betView] = views;
  const deferred = refund?.originalReceipt.body.status === 'PENDING_REFERENCE';
  if (!terminal(refundView))
    return {
      outcome: 'inconclusive',
      headline: 'O REFUND segue pendente, aguardando o worker de referências.',
      detail:
        proof === 'recovery'
          ? 'Suba o worker de novo para ver a recuperação. O acompanhamento continua.'
          : 'O worker de referências pode estar parado. Use a prova 4 para acompanhar a recuperação.',
    };
  const resolved = refundView!.status === 'PROCESSED' && betView?.status === 'PROCESSED';
  if (!deferred || !bet)
    return {
      outcome: 'violated',
      headline: `O REFUND deveria ter sido aceito como pendente (202), mas o recibo diz ${refund?.originalReceipt.body.status}.`,
    };
  if (
    proof === 'recovery' &&
    resolved &&
    change === 0n &&
    (evidence.pendingMs ?? 0) < RECOVERY_PENDING_MS
  )
    return {
      outcome: 'inconclusive',
      headline: `O REFUND foi resolvido em ${((evidence.pendingMs ?? 0) / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s: o worker estava ativo, não houve falha para recuperar.`,
      detail: 'Derrube o reference-worker antes de executar para ver a pendência e a recuperação.',
    };
  if (resolved && change === 0n)
    return {
      outcome: 'held',
      headline:
        proof === 'recovery'
          ? `O REFUND ficou pendente por ${Math.round((evidence.pendingMs ?? 0) / 1000)} s, esperou o worker voltar e foi processado. Nada se perdeu na queda.`
          : `O REFUND chegou antes da BET, esperou como pendente e foi resolvido quando ela chegou.`,
      detail: `Débito e estorno de ${amount} se anulam: saldo ${changeText}.`,
    };
  return {
    outcome: 'violated',
    headline: `Esperado: REFUND e BET processados e saldo inalterado. Observado: REFUND ${refundView!.status}, BET ${betView?.status ?? 'sem consulta'}, saldo ${changeText}.`,
  };
}

export function reconciliationVerdict(result: Reconciliation): Verdict {
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
