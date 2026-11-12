import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { JsonLogger } from '../../observability/logger';

export function apiError(status: number, code: string): HttpException {
  return new HttpException({ code, message: code }, status);
}
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    const correlationId = host.switchToHttp().getRequest().correlationId ?? crypto.randomUUID();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    if (status >= 500)
      new JsonLogger().error({
        event: 'request_failed',
        correlationId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    const body =
      error instanceof HttpException
        ? error.getResponse()
        : { code: 'INTERNAL_ERROR', message: 'Unexpected error' };
    response
      .header('X-Correlation-Id', correlationId)
      .status(status)
      .json({
        ...(typeof body === 'object' ? body : { code: 'INVALID_PAYLOAD', message: body }),
        correlationId,
      });
  }
}
