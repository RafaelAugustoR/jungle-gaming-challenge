import { useEffect, useRef, useState } from 'preact/hooks';
import { isAbort } from './api';
import type { Page } from './types';

export type FetchPage<T> = (cursor: string | null, signal: AbortSignal) => Promise<Page<T>>;

/**
 * A cursor-paginated list that restarts when `deps` change. Each load owns an AbortController, so a
 * response that arrives after the list moved on is dropped by the fetch itself, not by a counter.
 */
export function usePagedList<T>(fetchPage: FetchPage<T>, deps: unknown[]) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<Error>();
  const current = useRef<AbortController>();

  async function load(append: boolean) {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    setState('loading');
    try {
      const page = await fetchPage(append ? cursor : null, controller.signal);
      setItems((previous) => (append ? [...previous, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setState('ready');
    } catch (caught) {
      if (isAbort(caught)) return;
      setError(caught as Error);
      setState('error');
    }
  }

  useEffect(() => {
    setItems([]);
    void load(false);
    return () => current.current?.abort();
  }, deps);

  return {
    items,
    state,
    error,
    hasMore: cursor !== null,
    reload: () => load(false),
    loadMore: () => load(true),
  };
}
