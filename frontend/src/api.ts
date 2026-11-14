import type Keycloak from 'keycloak-js';
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

export function createApi(identity: Keycloak) {
  async function request<T>(path: string, body?: unknown, overrides: Record<string, string> = {}) {
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
      });
    } catch {
      throw new ApiError('Sem conexão com a API. Confira se o ambiente está rodando.');
    }
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const code = typeof data.code === 'string' ? data.code : undefined;
      const correlationId = typeof data.correlationId === 'string' ? data.correlationId : undefined;
      throw new ApiError(
        (code && (overrides[code] ?? messages[code])) || `A API respondeu ${response.status}.`,
        code,
        correlationId,
      );
    }
    return data as T;
  }
  return { request };
}
export type Api = ReturnType<typeof createApi>;

const isPending = (view: TransactionView) => ['PENDING', 'PENDING_REFERENCE'].includes(view.status);

/** Polls GET until the transaction is terminal, the deadline passes or the caller goes stale. */
export async function followTransaction(
  api: Api,
  transactionId: string,
  options: {
    deadlineMs: number;
    isCurrent: () => boolean;
    onUpdate?: (view: TransactionView) => void;
  },
): Promise<TransactionView | undefined> {
  const deadline = Date.now() + options.deadlineMs;
  let wait = 250;
  while (options.isCurrent()) {
    const view = await api.request<TransactionView>(
      `/wagering/transactions/${encodeURIComponent(transactionId)}`,
    );
    if (!options.isCurrent()) return undefined;
    options.onUpdate?.(view);
    if (!isPending(view) || Date.now() >= deadline) return view;
    await new Promise((resolve) => setTimeout(resolve, wait));
    wait = Math.min(wait * 1.5, 2000);
  }
  return undefined;
}
