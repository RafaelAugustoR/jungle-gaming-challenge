import type { LoggerService } from '@nestjs/common';

export function safeMessage(value: unknown): string {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  return text.replace(/(?:postgres(?:ql)?|https?):\/\/[^\s]+/gi, '[redacted-url]')
    .replace(/(password|secret|token|authorization)([=:]\s*)[^\s,;]+/gi, '$1$2[redacted]')
    .replace(/("?(?:money|amount|balance|payload|body|originalBody)"?\s*[:=]\s*)("(?:\\.|[^"\\])*"|\{[^}]*\}|\[[^\]]*\]|[^\s,;]+)/gi, '$1[redacted]');
}

const sensitiveField = /password|secret|token|authorization|payload|body|money|amount|balance/i;

function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return safeMessage(value);
  if (value instanceof Error) return { name: value.name, message: safeMessage(value.message), stack: safeMessage(value.stack ?? '') };
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.map(item => sanitize(item, seen));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      sensitiveField.test(key) ? '[redacted]' : sanitize(item, seen)]));
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
