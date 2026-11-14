export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** Minimal text-exposition parser for the counters the load report compares before/after. */
export function parsePrometheus(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/);
    if (!match) continue;
    const labels: Record<string, string> = {};
    for (const [, key, value] of (match[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g))
      labels[key!] = value!;
    samples.push({ name: match[1]!, labels, value: Number(match[3]) });
  }
  return samples;
}

export function sumMetric(samples: Sample[], name: string, filter: Record<string, string> = {}) {
  return samples
    .filter(
      (s) =>
        s.name === name && Object.entries(filter).every(([key, value]) => s.labels[key] === value),
    )
    .reduce((total, s) => total + s.value, 0);
}
