import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import { JsonLogger } from '../../observability/logger';
import { DomainError, type DomainErrorCode } from '../domain/errors/domain-error';

export function apiError(status: number, code: string): HttpException {
  return new HttpException({ code, message: code }, status);
}
const domainStatus: Record<DomainErrorCode, number> = {
  INVALID_PAYLOAD: 400,
  INSUFFICIENT_FUNDS: 422,
  INVALID_TRANSACTION_TRANSITION: 500,
  PLAYER_MISMATCH: 400,
  UNKNOWN_PROVIDER: 403,
  IDEMPOTENCY_CONFLICT: 409,
  EXTERNAL_TRANSACTION_CONFLICT: 409,
  TRANSACTION_NOT_FOUND: 404,
  AMOUNT_LIMIT_EXCEEDED: 400,
  CURRENCY_MISMATCH: 400,
  UNBALANCED_JOURNAL: 500,
  WALLET_ALREADY_EXISTS: 409,
  WALLET_NOT_FOUND: 404,
  INFRASTRUCTURE_UNAVAILABLE: 503,
};
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    const correlationId = host.switchToHttp().getRequest().correlationId ?? crypto.randomUUID();
    let status = 500;
    let body: object = { code: 'INTERNAL_ERROR', message: 'Unexpected error' };
    if (error instanceof DomainError) {
      status = domainStatus[error.code];
      body = { code: error.code, message: error.code };
    } else if (error instanceof BadRequestException) {
      status = 400;
      body = { code: 'INVALID_PAYLOAD', message: 'INVALID_PAYLOAD' };
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      const value = error.getResponse();
      // Preserve explicit transport contracts, including public health responses.
      body = typeof value === 'object' ? value : { message: value };
      if (!('code' in body)) {
        response.header('X-Correlation-Id', correlationId).status(status).json(body);
        return;
      }
    }
    if (status >= 500)
      new JsonLogger().error({
        event: 'request_failed',
        correlationId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    response
      .header('X-Correlation-Id', correlationId)
      .status(status)
      .json({ ...body, correlationId });
  }
}
