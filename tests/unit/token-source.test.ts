import { expect, test } from 'bun:test';
import { tokenSource } from '../support/keycloak';

test('token source refreshes in the background and keeps the last token when refresh fails', async () => {
  const tokens = ['first', 'second'];
  const errors: unknown[] = [];
  let calls = 0;
  const source = await tokenSource(
    async () => {
      const token = tokens[calls++];
      if (!token) throw new Error('keycloak down');
      return token;
    },
    { refreshMs: 5, onError: (error) => errors.push(error) },
  );
  try {
    expect(source.current()).toBe('first');
    await Bun.sleep(30);
    expect(source.current()).toBe('second');
    expect(errors.length).toBeGreaterThan(0);
    expect((errors[0] as Error).message).toBe('keycloak down');
  } finally {
    source.close();
  }
  const settled = calls;
  await Bun.sleep(20);
  expect(calls).toBe(settled);
});
