import type Keycloak from 'keycloak-js';
import { isPendingStatus } from './status';
import type { TransactionView } from './types';

const messages: Record<string, string> = {
  WALLET_ALREADY_EXISTS: 'Já existe uma wallet para esse jogador em BRL. Use outro identificador.',
  WALLET_NOT_FOUND: 'Nenhuma wallet com esse ID. Confira se copiou o ID inteiro.',
  FORBIDDEN: 'Seu perfil não permite esta ação.',
  UNAUTHORIZED: 'Sua sessão expirou. Entre novamente.',
  INVALID_PAYLOAD: 'A API recusou os dados enviados. Confira os campos.',
  AMOUNT_LIMIT_EXCEEDED: 'O valor ultrapassa o limite aceito pela API.',
  RACE_REQUIRES_POSITIVE_BALANCE: 'A disputa precisa de saldo positivo. Crie uma wallet com saldo.',
  INFRASTRUCTURE_UNAVAILABLE:
    'A API ou um serviço dela está indisponível. Tente de novo em instantes.',
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly correlationId?: string,
  ) {
    super(message);
  }
}

/** True when a request ended because its caller went away (wallet changed, run stopped). */
export const isAbort = (error: unknown) =>
  error instanceof DOMException && error.name === 'AbortError';

export interface RequestOptions {
  body?: unknown;
  signal?: AbortSignal;
  /** Context-specific messages for API error codes. */
  messages?: Record<string, string>;
}

export function createApi(identity: Keycloak) {
  async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { body, signal } = options;
    try {
      await identity.updateToken(30);
    } catch {
      throw new ApiError(messages.UNAUTHORIZED!, 'UNAUTHORIZED');
    }
    let response: Response;
    try {
      response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new ApiError('Sem conexão com a API. Confira se o ambiente está rodando.');
    }
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const code = typeof data.code === 'string' ? data.code : undefined;
      const correlationId = typeof data.correlationId === 'string' ? data.correlationId : undefined;
      throw new ApiError(
        (code && (options.messages?.[code] ?? messages[code])) ||
          `A API respondeu ${response.status}.`,
        code,
        correlationId,
      );
    }
    return data as T;
  }
  return { request };
}
export type Api = ReturnType<typeof createApi>;

/**
 * Polls GET until the transaction is terminal or the deadline passes. When `stop` fires it returns
 * the last view it saw; when `signal` fires the whole run is gone and it rejects with an AbortError.
 */
export async function followTransaction(
  api: Api,
  transactionId: string,
  options: {
    deadlineMs: number;
    signal: AbortSignal;
    stop?: AbortSignal;
    onUpdate?: (view: TransactionView) => void;
  },
): Promise<TransactionView | undefined> {
  const deadline = Date.now() + options.deadlineMs;
  let last: TransactionView | undefined;
  let wait = 250;
  for (;;) {
    options.signal.throwIfAborted();
    if (options.stop?.aborted) return last;
    last = await api.request<TransactionView>(
      `/wagering/transactions/${encodeURIComponent(transactionId)}`,
      { signal: options.signal },
    );
    options.onUpdate?.(last);
    if (!isPendingStatus(last.status) || Date.now() >= deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, wait));
    wait = Math.min(wait * 1.5, 2000);
  }
}
