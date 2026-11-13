import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../../config/infrastructure.module';
import type { AppConfig } from '../../../config/config';
import { apiError } from '../../../shared/rest/api-error';
import {
  restoreSubmissionReceipt,
  type SubmissionReceipt,
} from '../../wagering/domain/submission-receipt';
import type { DemoCommand, DemoSubmission } from '../demo-contract';

@Injectable()
export class DemoProviderClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async accessToken(provider: NonNullable<AppConfig['demoProvider']>) {
    let response: Response;
    try {
      response = await fetch(this.config.keycloakTokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: provider.clientId,
          client_secret: provider.secret,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw apiError(503, 'INFRASTRUCTURE_UNAVAILABLE');
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw apiError(503, 'INFRASTRUCTURE_UNAVAILABLE');
    }
    const token =
      body && typeof body === 'object' && 'access_token' in body &&
      typeof body.access_token === 'string'
        ? body.access_token
        : undefined;
    if (!response.ok || !token) throw apiError(503, 'INFRASTRUCTURE_UNAVAILABLE');
    return token;
  }

  async submit(
    port: number,
    token: string,
    command: DemoCommand,
    idempotencyKey: string,
  ): Promise<DemoSubmission> {
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${port}/wagering/transactions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw apiError(503, 'INFRASTRUCTURE_UNAVAILABLE');
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw apiError(503, 'INFRASTRUCTURE_UNAVAILABLE');
    }
    if (response.status >= 500 || response.status === 401 || response.status === 403)
      throw apiError(503, 'INFRASTRUCTURE_UNAVAILABLE');
    const hasTransactionId =
      body && typeof body === 'object' && 'transactionId' in body &&
      typeof body.transactionId === 'string';
    if (
      ![200, 202, 422].includes(response.status) ||
      (response.status === 422 && !hasTransactionId)
    ) {
      const code =
        body && typeof body === 'object' && 'code' in body &&
        typeof body.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(body.code)
          ? body.code
          : 'INVALID_PAYLOAD';
      throw apiError(response.status, code);
    }
    if (!hasTransactionId)
      throw apiError(503, 'INFRASTRUCTURE_UNAVAILABLE');
    try {
      const receipt = restoreSubmissionReceipt(
        response.status,
        body as SubmissionReceipt['body'],
      );
      return { httpStatus: receipt.httpStatus, originalReceipt: receipt };
    } catch {
      throw apiError(503, 'INFRASTRUCTURE_UNAVAILABLE');
    }
  }
}
