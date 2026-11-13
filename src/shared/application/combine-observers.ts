/** Combine every implemented hook, retaining sync hooks and awaiting async hooks. */
export function combineObservers<T extends object>(...observers: (T | undefined)[]): T {
  const sources = observers.filter((observer): observer is T => observer !== undefined);
  const combined = {} as T;
  for (const key of new Set(sources.flatMap((source) => Object.keys(source)))) {
    const handlers = sources.flatMap((source) => {
      const handler = Reflect.get(source, key);
      return typeof handler === 'function'
        ? [(...args: unknown[]) => handler.apply(source, args)]
        : [];
    });
    if (!handlers.length) continue;
    Object.defineProperty(combined, key, {
      enumerable: true,
      value: (...args: unknown[]) => {
        const results = handlers.map((handler) => handler(...args));
        return results.some((result) => result instanceof Promise)
          ? Promise.all(results).then(() => undefined)
          : undefined;
      },
    });
  }
  return combined;
}
