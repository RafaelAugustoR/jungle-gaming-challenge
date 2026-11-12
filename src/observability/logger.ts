import type { LoggerService } from '@nestjs/common';

export function safeMessage(value: unknown): string {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  return text.replace(/(?:postgres(?:ql)?|https?):\/\/[^\s]+/gi, '[redacted-url]')
    .replace(/(password|secret|token|authorization)([=:]\s*)[^\s,;]+/gi, '$1$2[redacted]');
}
export class JsonLogger implements LoggerService {
  log(message: unknown) { this.write('info', message); }
  error(message: unknown) { this.write('error', message); }
  warn(message: unknown) { this.write('warn', message); }
  debug(message: unknown) { this.write('debug', message); }
  verbose(message: unknown) { this.write('debug', message); }
  private write(level: string, message: unknown) {
    console.log(JSON.stringify({ level, message: safeMessage(message) }));
  }
}
