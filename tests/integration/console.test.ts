import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { loadConfig } from '../../src/config/config';
import { createApplication } from '../../src/bootstrap/application';
import { disposableDatabase } from '../support/database';
const browserTest = process.env.BROWSER === '1' ? test : test.skip;
let base: string;
let app: Awaited<ReturnType<typeof createApplication>>;
let database: Awaited<ReturnType<typeof disposableDatabase>>;
let restoreConsoleClient: (() => Promise<void>) | undefined;

async function allowEphemeralRedirect(baseUrl: string) {
  const issuer = new URL(loadConfig().keycloakIssuer);
  const tokenResponse = await fetch(`${issuer.origin}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: 'admin',
      password: 'local-demo-only',
    }),
  });
  const { access_token: token } = (await tokenResponse.json()) as { access_token?: string };
  if (!tokenResponse.ok || !token) throw new Error('Could not authorize temporary browser callback.');
  const admin = `${issuer.origin}/admin/realms/${issuer.pathname.split('/').at(-1)}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const clientResponse = await fetch(`${admin}/clients?clientId=jungle-console`, { headers });
  const [client] = (await clientResponse.json()) as Array<{
    id: string;
    redirectUris: string[];
    webOrigins: string[];
    [key: string]: unknown;
  }>;
  if (!clientResponse.ok || !client) throw new Error('Could not load the console client.');
  const update = async (redirectUris: string[], webOrigins: string[]) => {
    const response = await fetch(`${admin}/clients/${client.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...client, redirectUris, webOrigins }),
    });
    if (!response.ok) throw new Error('Could not configure the temporary browser callback.');
  };
  const previousRedirects = client.redirectUris;
  const previousOrigins = client.webOrigins;
  await update([...previousRedirects, baseUrl], [...previousOrigins, baseUrl]);
  return async () => update(previousRedirects, previousOrigins);
}
beforeAll(async () => {
  if (process.env.BROWSER !== '1') return;
  database = await disposableDatabase();
  app = await createApplication(database.config);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  restoreConsoleClient = await allowEphemeralRedirect(base);
});
afterAll(async () => {
  try {
    await restoreConsoleClient?.();
  } finally {
    try {
      await app?.close();
    } finally {
      await database?.close();
    }
  }
});
browserTest(
  'demo operator reconciles through the authenticated console; viewer only reads',
  async () => {
    const browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || undefined,
      args: ['--no-sandbox'],
    });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(base);
      await page.getByRole('button', { name: 'Entrar' }).click();
      expect(new URL(page.url()).searchParams.get('code_challenge_method')).toBe('S256');
      await page.getByLabel('Username or email').fill('demo-operator');
      await page.getByLabel('Password', { exact: true }).fill('demo-only');
      await page.getByRole('button', { name: 'Sign In', exact: true }).click();
      await page.getByLabel('Jogador').fill(`browser-${crypto.randomUUID()}`);
      await page.getByLabel('Saldo inicial (BRL)').fill('123.45');
      await page.getByRole('button', { name: 'Criar wallet', exact: true }).click();
      await page.getByTestId('wallet-balance').filter({ hasText: '123.45' }).waitFor();
      await page.getByRole('cell', { name: 'OPENING', exact: true }).waitFor();
      const firstWalletId = await page.getByTestId('wallet-id').textContent();
      let releaseRequest!: () => void;
      let requestStarted!: () => void;
      const blockedResponse = new Promise<void>((resolve) => (releaseRequest = resolve));
      const reconciliationStarted = new Promise<void>((resolve) => (requestStarted = resolve));
      await page.route('**/wallets/*/reconciliation', async (route) => {
        requestStarted();
        await blockedResponse;
        await route.continue();
      });
      const reconciliationResponse = page.waitForResponse(
        (response) => response.url().includes('/reconciliation') && response.status() === 200,
      );
      await page.getByRole('button', { name: 'Reconciliar ledger' }).click();
      await reconciliationStarted;
      await page.getByLabel('Jogador').fill(`browser-${crypto.randomUUID()}`);
      await page.getByLabel('Saldo inicial (BRL)').fill('50.00');
      await page.getByRole('button', { name: 'Criar wallet', exact: true }).click();
      await page.getByTestId('wallet-balance').filter({ hasText: '50.00' }).waitFor();
      const id = await page.getByTestId('wallet-id').textContent();
      expect(id).not.toBe(firstWalletId);
      releaseRequest();
      await reconciliationResponse;
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
      expect(await page.locator('#reconciliation').isHidden()).toBe(true);
      await page.unroute('**/wallets/*/reconciliation');
      await page.getByRole('button', { name: 'Reconciliar ledger' }).click();
      await page.getByText('Saldo e ledger conferem.', { exact: true }).waitFor();
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(
        await page.evaluate(() => Object.keys(localStorage).some((key) => /token/i.test(key))),
      ).toBe(false);
      if (process.env.SCREENSHOTS === '1') {
        const evidenceDir = resolve('docs/evidence/issue-9');
        await mkdir(evidenceDir, { recursive: true });
        for (const width of [1440, 768, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await page.screenshot({
            path: `${evidenceDir}/console-${width}.png`,
            fullPage: true,
          });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
        }
      }
      await context.close();
      const viewerContext = await browser.newContext();
      const viewer = await viewerContext.newPage();
      await viewer.goto(base);
      await viewer.getByRole('button', { name: 'Entrar' }).click();
      await viewer.getByLabel('Username or email').fill('viewer');
      await viewer.getByLabel('Password', { exact: true }).fill('demo-only');
      await viewer.getByRole('button', { name: 'Sign In', exact: true }).click();
      await viewer.getByText('Acesso de consulta', { exact: true }).waitFor();
      expect(await viewer.getByRole('button', { name: 'Criar wallet', exact: true }).count()).toBe(
        0,
      );
      await viewer.getByLabel('ID da wallet').fill(id!);
      await viewer.getByRole('button', { name: 'Consultar', exact: true }).click();
      await viewer.getByTestId('wallet-balance').filter({ hasText: '50.00' }).waitFor();
      await viewer.getByRole('cell', { name: 'OPENING', exact: true }).waitFor();
      expect(await viewer.getByRole('button', { name: 'Reconciliar ledger' }).count()).toBe(0);
      await viewerContext.close();
    } finally {
      await browser.close();
    }
  },
  60000,
);
