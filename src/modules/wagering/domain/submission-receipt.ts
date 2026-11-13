import type { MoneyProps } from '../../../shared/domain/money';
export type WagerFailureCode =
  | 'INSUFFICIENT_FUNDS'
  | 'REVERSAL_INSUFFICIENT_FUNDS'
  | 'AMOUNT_LIMIT_EXCEEDED'
  | 'REFERENCE_REQUIRED'
  | 'REFERENCE_KIND_MISMATCH'
  | 'REFERENCE_CONTEXT_MISMATCH'
  | 'REFERENCE_AMOUNT_MISMATCH'
  | 'REFERENCE_NOT_PROCESSED'
  | 'REFERENCE_NOT_FOUND'
  | 'REFERENCE_NOT_READY'
  | 'ALREADY_REVERSED';
export const wagerFailureMessages: Readonly<Record<WagerFailureCode, string>> = Object.freeze({
  INSUFFICIENT_FUNDS: 'Wallet balance is insufficient for this wager',
  REVERSAL_INSUFFICIENT_FUNDS: 'Wallet balance is insufficient to apply this reversal',
  AMOUNT_LIMIT_EXCEEDED: 'The operation would exceed the supported amount limit',
  REFERENCE_REQUIRED: 'A reference transaction is required',
  REFERENCE_KIND_MISMATCH: 'The reference transaction has an incompatible kind',
  REFERENCE_CONTEXT_MISMATCH: 'The reference transaction belongs to a different context',
  REFERENCE_AMOUNT_MISMATCH: 'The amount does not match the reference transaction',
  REFERENCE_NOT_PROCESSED: 'The reference transaction was not processed',
  REFERENCE_NOT_FOUND: 'The reference transaction was not found',
  REFERENCE_NOT_READY: 'The reference transaction did not become ready before the deadline',
  ALREADY_REVERSED: 'The reference transaction was already reversed by this kind',
});
interface ReceiptBody {
  transactionId: string;
  balance: MoneyProps;
  idempotentReplay: boolean;
}
export type SubmissionReceipt =
  | { httpStatus: 200; body: ReceiptBody & { status: 'PROCESSED' } }
  | { httpStatus: 202; body: ReceiptBody & { status: 'PENDING_REFERENCE' } }
  | {
      httpStatus: 422;
      body: ReceiptBody & {
        status: 'REJECTED';
        failureCode: WagerFailureCode;
        code: WagerFailureCode;
        message: string;
        correlationId: string;
      };
    };
