function ipv4Number(address: string): number | undefined {
  const parts = address.replace(/^::ffff:/i, '').split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255))
    return undefined;
  return parts.reduce((value, part) => (value << 8) | Number(part), 0) >>> 0;
}

export interface ParsedMetricsCidr {
  network: number;
  mask: number;
}

export function parseMetricsCidr(cidr: string): ParsedMetricsCidr | undefined {
  const [networkText, prefixText, ...rest] = cidr.split('/');
  if (rest.length || !networkText || !prefixText || !/^\d{1,2}$/.test(prefixText)) return undefined;
  const prefix = Number(prefixText);
  if (prefix < 0 || prefix > 32) return undefined;
  const network = ipv4Number(networkText);
  if (network === undefined) return undefined;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { network: (network & mask) >>> 0, mask };
}

export function isMetricsPeerAllowed(
  address: string | undefined,
  cidr: ParsedMetricsCidr | undefined,
): boolean {
  if (!address || !cidr) return false;
  const peer = ipv4Number(address);
  if (peer === undefined) return false;
  return (cidr.network & cidr.mask) === (peer & cidr.mask);
}
