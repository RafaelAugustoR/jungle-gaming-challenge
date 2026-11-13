function ipv4Number(address: string): number | undefined {
  const parts = address.replace(/^::ffff:/i, '').split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255))
    return undefined;
  return parts.reduce((value, part) => (value << 8) | Number(part), 0) >>> 0;
}

export function isMetricsPeerAllowed(address: string | undefined, cidr: string): boolean {
  if (!address || !cidr) return false;
  const [networkText, prefixText, ...rest] = cidr.split('/');
  if (rest.length || !networkText || !prefixText || !/^\d{1,2}$/.test(prefixText)) return false;
  const prefix = Number(prefixText);
  if (prefix < 0 || prefix > 32) return false;
  const network = ipv4Number(networkText);
  const peer = ipv4Number(address);
  if (network === undefined || peer === undefined) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (network & mask) === (peer & mask);
}
