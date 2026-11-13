import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import { JsonLogger } from '../../observability/logger';
import { DomainError, type DomainErrorCategory } from '../domain/errors/domain-error';

export function apiError(status: number, code: string): HttpException {
  return new HttpException({ code, message: code }, status);
}
const categoryStatus: Record<DomainErrorCategory, number> = {
  invalid: 400,
  rejected: 422,
  forbidden: 403,
  conflict: 409,
  notFound: 404,
  unavailable: 503,
  internal: 500,
};
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    const correlationId = host.switchToHttp().getRequest().correlationId ?? crypto.randomUUID();
    let status = 500;
    let body: object = { code: 'INTERNAL_ERROR', message: 'Unexpected error' };
    if (error instanceof DomainError) {
      status = categoryStatus[error.category];
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
