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
interface ReceiptBody {
  transactionId: string;
  balance: MoneyProps;
  idempotentReplay: boolean;
}
export type SubmissionReceipt =
  | { httpStatus: 200; body: ReceiptBody & { status: 'PROCESSED' } }
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
