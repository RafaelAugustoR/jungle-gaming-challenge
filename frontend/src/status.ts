// One place for what a transaction status means to the console. Typed against the backend unions,
// so a new status or failure code without a label does not compile.
import type { TransactionStatus, WagerFailureCode } from './types';

export const statusLabels: Readonly<Record<TransactionStatus, string>> = {
  PROCESSED: 'Processada',
  PENDING: 'Pendente',
  PENDING_REFERENCE: 'Aguardando referência',
  REJECTED: 'Recusada',
  FAILED: 'Falhou',
};

export const failureLabels: Readonly<Record<WagerFailureCode, string>> = {
  INSUFFICIENT_FUNDS: 'Saldo insuficiente',
  REVERSAL_INSUFFICIENT_FUNDS: 'Saldo insuficiente para estornar',
  AMOUNT_LIMIT_EXCEEDED: 'Limite de valor excedido',
  REFERENCE_REQUIRED: 'Referência obrigatória',
  REFERENCE_KIND_MISMATCH: 'Tipo incompatível com a referência',
  REFERENCE_CONTEXT_MISMATCH: 'Contexto diferente da referência',
  REFERENCE_AMOUNT_MISMATCH: 'Valor diferente da referência',
  REFERENCE_NOT_PROCESSED: 'Referência não processada',
  REFERENCE_NOT_FOUND: 'Referência não encontrada',
  REFERENCE_NOT_READY: 'Referência não ficou pronta no prazo',
  ALREADY_REVERSED: 'Já estornada',
};

export const isPendingStatus = (status: TransactionStatus) =>
  status === 'PENDING' || status === 'PENDING_REFERENCE';

export type Tone = 'held' | 'pending' | 'void' | 'none';
export function statusTone(status?: TransactionStatus): Tone {
  if (!status) return 'none';
  if (status === 'PROCESSED') return 'held';
  return isPendingStatus(status) ? 'pending' : 'void';
}
