// Monetary values travel as decimal strings with two places ("100.00"). Never convert them to floats.
const decimal = /^(0|[1-9]\d*)\.(\d{2})$/;
const signedDecimal = /^(-?)(0|[1-9]\d*)\.(\d{2})$/;

export function toMinor(amount: string): bigint {
  const match = signedDecimal.exec(amount);
  if (!match) throw new Error(`Valor monetário inválido: ${amount}`);
  return BigInt(`${match[1]}${match[2]}${match[3]}`);
}

export function fromMinor(minor: bigint): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(3, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/** "1234.50" -> "1.234,50" (pt-BR grouping, no currency symbol). */
export function formatAmount(amount: string): string {
  const negative = amount.startsWith('-');
  const [whole = '0', cents = '00'] = (negative ? amount.slice(1) : amount).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative ? '−' : ''}${grouped},${cents}`;
}

export function formatMoney(money: { amount: string; currency: string }): string {
  return money.currency === 'BRL'
    ? `R$ ${formatAmount(money.amount)}`
    : `${formatAmount(money.amount)} ${money.currency}`;
}

/**
 * Accepts what a pt-BR operator types ("20", "20,5", "20,50", "1.234,50", "20.50")
 * and returns the API's canonical decimal string, or undefined when it is not a valid amount.
 */
export function parseAmountInput(raw: string): string | undefined {
  const value = raw.trim().replace(/^R\$\s*/i, '');
  if (!value) return undefined;
  let normalized: string;
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(value))
    normalized = value.replace(/\./g, '').replace(',', '.');
  else if (/^\d+([.,]\d{1,2})?$/.test(value)) normalized = value.replace(',', '.');
  else return undefined;
  const [whole = '0', cents = ''] = normalized.split('.');
  const canonical = `${BigInt(whole).toString()}.${cents.padEnd(2, '0')}`;
  return decimal.test(canonical) ? canonical : undefined;
}
