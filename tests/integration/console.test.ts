import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { createApplication } from '../../src/bootstrap/application';
import { disposableDatabase } from '../support/database';
import { allowConsoleRedirect } from '../support/keycloak';
import { referenceProcess } from '../support/reference-process';
const browserTest = process.env.BROWSER === '1' ? test : test.skip;
let base: string;
let app: Awaited<ReturnType<typeof createApplication>>;
let database: Awaited<ReturnType<typeof disposableDatabase>>;
let restoreConsoleClient: (() => Promise<void>) | undefined;
let referenceWorker: Awaited<ReturnType<typeof referenceProcess>> | undefined;
beforeAll(async () => {
  if (process.env.BROWSER !== '1') return;
  database = await disposableDatabase();
  app = await createApplication({
    ...database.config,
    demoProvider: {
      clientId: 'provider-a',
      providerId: 'provider-a',
      secret: 'provider-a-demo-only',
    },
  });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  referenceWorker = await referenceProcess(database.config);
  restoreConsoleClient = await allowConsoleRedirect(base);
});
afterAll(async () => {
  try {
    await restoreConsoleClient?.();
  } finally {
    try {
      await referenceWorker?.stop();
    } finally {
      try {
        await app?.close();
      } finally {
        await database?.close();
      }
    }
  }
});

async function login(page: Page, username: string, url = base) {
  await page.goto(url);
  const enter = page.getByRole('button', { name: 'Entrar', exact: true });
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(
      (b) => b.textContent?.trim() === 'Entrar' && !b.disabled,
    ),
  );
  await enter.click();
  expect(new URL(page.url()).searchParams.get('code_challenge_method')).toBe('S256');
  await page.getByLabel('Username or email').fill(username);
  await page.getByLabel('Password', { exact: true }).fill('demo-only');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.locator('.console').waitFor();
}

async function createWallet(page: Page, amount: string) {
  await page.getByLabel('Jogador').fill(`browser-${crypto.randomUUID()}`);
  await page.getByLabel('Saldo inicial').fill(amount);
  await page.getByRole('button', { name: 'Criar wallet', exact: true }).click();
  await page.getByRole('heading', { name: 'O saldo nunca fica negativo' }).waitFor();
  return (await page.getByTestId('wallet-id').locator('code').textContent())!;
}

async function runProof(page: Page, item: RegExp, amount?: string) {
  await page
    .getByRole('navigation', { name: 'Provas e evidências' })
    .getByRole('button', { name: item })
    .click();
  if (amount) await page.getByLabel('Valor por operação').fill(amount);
  await page.getByRole('button', { name: /Executar (prova|de novo)/ }).click();
  const stamp = page.locator('.result .stamp');
  await stamp.waitFor({ timeout: 20000 });
  return (await stamp.textContent())!.trim();
}

browserTest(
  'demo operator proves every guarantee through the console; viewer only reads',
  async () => {
    const browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH || undefined,
      args: ['--no-sandbox'],
    });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await login(page, 'demo-operator');

      // Validation stays in Portuguese and inline; nothing reaches the API.
      await page.getByLabel('Saldo inicial').fill('abc');
      await page.getByRole('button', { name: 'Criar wallet', exact: true }).click();
      await page.getByText('Use um valor como 100,00.').waitFor();

      // API errors land next to the action with the correlation reference.
      await page.route('**/wallets', (route) =>
        route.request().method() === 'POST'
          ? route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({
                code: 'INFRASTRUCTURE_UNAVAILABLE',
                correlationId: 'browser-error',
              }),
            })
          : route.continue(),
      );
      await page.getByLabel('Saldo inicial').fill('100,00');
      await page.getByRole('button', { name: 'Criar wallet', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'browser-error' }).waitFor();
      await page.unroute('**/wallets');

      const firstWalletId = await createWallet(page, '100,00');
      await page.getByTestId('wallet-balance').filter({ hasText: '100,00' }).waitFor();

      expect(await runProof(page, /Disputa pelo saldo/)).toBe('Garantia mantida');
      await page.getByTestId('wallet-balance').filter({ hasText: '20,00' }).waitFor();
      const raceStates = await page.locator('.result .validation .status code').allTextContents();
      expect(raceStates.sort()).toEqual(['PROCESSED', 'REJECTED']);

      expect(await runProof(page, /Repetição idempotente/, '5,00')).toBe('Garantia mantida');
      await page.locator('.result .replay-yes').waitFor();
      expect(await page.locator('.result .ticket').count()).toBe(2);
      await page.getByTestId('wallet-balance').filter({ hasText: '15,00' }).waitFor();

      expect(await runProof(page, /Referência fora de ordem/, '5,00')).toBe('Garantia mantida');
      const refund = page.locator('.result .ticket').first();
      await refund.locator('.stub').getByText('PENDING_REFERENCE').waitFor();
      await refund.locator('.validation').getByText('PROCESSED').waitFor();
      await refund.getByText('mudou desde o aceite').waitFor();
      await page.getByTestId('wallet-balance').filter({ hasText: '15,00' }).waitFor();

      // With the worker running, the recovery proof cannot observe a pending refund: it says so.
      expect(await runProof(page, /Recuperação após falha/, '1,00')).toBe('Inconclusiva');

      expect(await runProof(page, /Reconciliação/)).toBe('Garantia mantida');
      await page
        .getByText(/lançamentos do ledger reconstroem exatamente o saldo registrado/)
        .waitFor();

      await page.getByRole('button', { name: 'Ledger' }).click();
      await page.getByText('Fecha com o saldo da wallet').waitFor();
      await page.getByRole('button', { name: 'Bilhetes' }).click();
      await page
        .locator('.ticket')
        .filter({ hasText: 'OPENING' })
        .getByText('Não há recibo de provedor')
        .waitFor();

      if (process.env.SCREENSHOTS === '1') {
        const evidenceDir = resolve('docs/evidence/console');
        await mkdir(evidenceDir, { recursive: true });
        for (const width of [1440, 768, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await page.screenshot({ path: `${evidenceDir}/console-${width}.png`, fullPage: true });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
        }
        await page.setViewportSize({ width: 1280, height: 800 });
      }

      // A finished scenario must not restore its wallet after the user switches to another one.
      let releaseScenarioWallet!: () => void;
      let scenarioWalletStarted!: () => void;
      const held = new Promise<void>((done) => (releaseScenarioWallet = done));
      const started = new Promise<void>((done) => (scenarioWalletStarted = done));
      let walletReads = 0;
      await page.route(`**/wallets/${firstWalletId}`, async (route) => {
        // The first read is the "before" balance; hold the closing read.
        if (++walletReads < 2) return route.continue();
        const response = await route.fetch();
        scenarioWalletStarted();
        await held;
        await route.fulfill({ response });
      });
      await page
        .getByRole('navigation', { name: 'Provas e evidências' })
        .getByRole('button', { name: /Repetição idempotente/ })
        .click();
      await page.getByLabel('Valor por operação').fill('1,00');
      await page.getByRole('button', { name: /Executar (prova|de novo)/ }).click();
      await started;
      await page.getByRole('button', { name: 'Trocar de wallet' }).click();
      const secondWalletId = await createWallet(page, '60,00');
      releaseScenarioWallet();
      await page.waitForTimeout(300);
      expect(await page.getByTestId('wallet-id').locator('code').textContent()).toBe(
        secondWalletId,
      );
      await page.getByTestId('wallet-balance').filter({ hasText: '60,00' }).waitFor();
      expect(await page.locator('.result').count()).toBe(0);
      await page.unroute(`**/wallets/${firstWalletId}`);

      expect(
        await page.evaluate(() => Object.keys(localStorage).some((key) => /token/i.test(key))),
      ).toBe(false);
      await context.close();

      // Viewer: deep link straight to the ledger; no create, no runs, no reconciliation.
      const viewerContext = await browser.newContext();
      const viewer = await viewerContext.newPage();
      await login(viewer, 'viewer', `${base}/?wallet=${secondWalletId}&view=ledger`);
      await viewer.getByRole('heading', { name: 'Ledger da wallet' }).waitFor();
      await viewer.getByTestId('wallet-balance').filter({ hasText: '60,00' }).waitFor();
      await viewer.getByRole('cell', { name: 'OPENING' }).waitFor();
      expect(await viewer.getByRole('button', { name: 'Criar wallet', exact: true }).count()).toBe(
        0,
      );
      await viewer
        .getByRole('navigation', { name: 'Provas e evidências' })
        .getByRole('button', { name: /Disputa pelo saldo/ })
        .click();
      await viewer
        .getByText('Executar provas exige o perfil demo-operator.', { exact: false })
        .waitFor();
      expect(await viewer.getByRole('button', { name: /Executar prova/ }).count()).toBe(0);
      expect(await viewer.getByRole('button', { name: /Reconciliação/ }).count()).toBe(0);
      await viewerContext.close();
    } finally {
      await browser.close();
    }
  },
  90000,
);
