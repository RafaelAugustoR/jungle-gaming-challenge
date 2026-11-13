export function integer(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  max: number,
  min = 1,
): number {
  const value = env[key] ?? String(fallback);
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max)
    throw new Error(`Invalid ${key}`);
  return Number(value);
}
