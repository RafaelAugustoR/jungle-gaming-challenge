import type { LoggerService } from '@nestjs/common';

export function safeMessage(value: unknown): string {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  return text.replace(/(?:postgres(?:ql)?|https?):\/\/[^\s]+/gi, '[redacted-url]')
    .replace(/(password|secret|token|authorization)([=:]\s*)[^\s,;]+/gi, '$1$2[redacted]')
    .replace(/("?(?:money|amount|balance|payload|body|originalBody)"?\s*[:=]\s*)("(?:\\.|[^"\\])*"|\{[^}]*\}|\[[^\]]*\]|[^\s,;]+)/gi, '$1[redacted]');
}

const sensitiveField = /password|secret|token|authorization|payload|body|money|amount|balance/i;

/** Code-shaped messages (`INSUFFICIENT_FUNDS`, `INVALID_INTEGRATION_EVENT`) carry no data. */
const codeMessage = /^[A-Z][A-Z0-9_]{0,63}$/;
const sqlState = /^[0-9A-Z]{5}$/;
const identifier = /^[a-z_][a-z0-9_.]{0,127}$/i;

/**
 * Database driver errors embed the failed statement with its bound values in message and
 * stack (MikroORM: "insert into ... values ('17.23', ...) - <reason>"), so no text redaction
 * can make them safe. They are recognised structurally and reduced to an allowlist.
 */
function isDatabaseError(error: Error): boolean {
  const fields = error as Error & { code?: unknown; sqlState?: unknown; severity?: unknown };
  return (
    'sqlState' in fields ||
    typeof fields.severity === 'string' ||
    (typeof fields.code === 'string' && sqlState.test(fields.code)) ||
    /(?:Driver|Server|Constraint|Connection|Syntax|Database)\w*Exception$/.test(error.name)
  );
}

/** Keeps the call frames of a stack; its header line repeats the (possibly unsafe) message. */
function stackFrames(stack: string, header: string): string {
  const frames = stack.split('\n').filter((line) => /^\s+at\s/.test(line)).map(safeMessage);
  return [header, ...frames].join('\n');
}

function stackHeader(line: string): string {
  const match = /^([\w$.]*(?:Error|Exception)): ?(.*)$/.exec(line);
  if (!match) return '[stack]';
  return codeMessage.test(match[2]!) ? `${match[1]}: ${match[2]}` : match[1]!;
}

/** Allowlisted view of an error: never the driver's SQL text, bound values or `detail`. */
export function serializeError(error: Error): Record<string, unknown> {
  if (isDatabaseError(error)) {
    const fields = error as Error & { code?: unknown; constraint?: unknown; table?: unknown };
    return {
      name: error.name,
      ...(typeof fields.code === 'string' && sqlState.test(fields.code) ? { sqlState: fields.code } : {}),
      ...(typeof fields.constraint === 'string' && identifier.test(fields.constraint) ? { constraint: fields.constraint } : {}),
      ...(typeof fields.table === 'string' && identifier.test(fields.table) ? { table: fields.table } : {}),
      stack: stackFrames(error.stack ?? '', error.name),
    };
  }
  const message = codeMessage.test(error.message) ? error.message : safeMessage(error.message);
  return {
    name: error.name,
    message,
    stack: stackFrames(error.stack ?? '', `${error.name}: ${message}`),
  };
}

function sanitize(value: unknown, seen = new WeakSet<object>(), key?: string): unknown {
  if (typeof value === 'string') {
    // Stack strings handed over by Nest (`error(message, stack)`) may come from a driver error.
    if (key === 'stack') return stackFrames(value, stackHeader(value.split('\n')[0] ?? ''));
    return safeMessage(value);
  }
  if (value instanceof Error) return serializeError(value);
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.map(item => sanitize(item, seen));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      sensitiveField.test(key) ? '[redacted]' : sanitize(item, seen, key)]));
  }
  return typeof value === 'bigint' ? value.toString() : value;
}

export class JsonLogger implements LoggerService {
  log(message: unknown, ...optionalParams: unknown[]) { this.nest('info', message, optionalParams); }
  error(message: unknown, ...optionalParams: unknown[]) { this.nest('error', message, optionalParams); }
  warn(message: unknown, ...optionalParams: unknown[]) { this.nest('warn', message, optionalParams); }
  debug(message: unknown, ...optionalParams: unknown[]) { this.nest('debug', message, optionalParams); }
  verbose(message: unknown, ...optionalParams: unknown[]) { this.nest('debug', message, optionalParams); }

  write(level: string, message: unknown, fields: Record<string, unknown> = {}) {
    const data = message instanceof Error ? { error: message } :
      message !== null && typeof message === 'object' ? message : { message };
    console.log(JSON.stringify(sanitize({ ...data, ...fields, level })));
  }

  private nest(level: string, message: unknown, params: unknown[]) {
    const fields: Record<string, unknown> = {};
    if (level === 'error' && params.length >= 2) {
      fields.stack = params[0];
      fields.context = params[1];
    } else if (params.length) {
      const last = params[params.length - 1];
      if (level === 'error' && typeof last === 'string' && /\n|^\w*Error:/.test(last)) fields.stack = last;
      else fields.context = last;
    }
    this.write(level, message, fields);
  }
}
