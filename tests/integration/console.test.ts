import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
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
      let releaseTransactionRead!: () => void;
      let transactionReadStarted!: () => void;
      const blockedTransactionRead = new Promise<void>(
        (resolve) => (releaseTransactionRead = resolve),
      );
      const transactionReadStartedSignal = new Promise<void>(
        (resolve) => (transactionReadStarted = resolve),
      );
      await page.route('**/wagering/transactions?*', async (route) => {
        transactionReadStarted();
        await blockedTransactionRead;
        await route.continue();
      });
      await page.goto(base);
      await page.getByRole('button', { name: 'Entrar' }).click();
      expect(new URL(page.url()).searchParams.get('code_challenge_method')).toBe('S256');
      await page.getByLabel('Username or email').fill('demo-operator');
      await page.getByLabel('Password', { exact: true }).fill('demo-only');
      await page.getByRole('button', { name: 'Sign In', exact: true }).click();
      await transactionReadStartedSignal;
      await page.getByText('Carregando transações…').waitFor();
      releaseTransactionRead();
      await page.getByText('Nenhuma transação corresponde aos filtros.').waitFor();
      await page.unroute('**/wagering/transactions?*');
      await page.route('**/wagering/transactions?*', (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'INFRASTRUCTURE_UNAVAILABLE',
            correlationId: 'browser-error',
          }),
        }),
      );
      await page.getByRole('button', { name: 'Atualizar' }).click();
      await page.getByText(/O serviço está indisponível/).waitFor();
      await page.unroute('**/wagering/transactions?*');
      await page.getByRole('button', { name: 'Atualizar' }).click();
      await page.getByText('Nenhuma transação corresponde aos filtros.').waitFor();
      await page.getByLabel('Jogador').fill(`browser-${crypto.randomUUID()}`);
      await page.getByLabel('Saldo inicial (BRL)').fill('123.45');
      await page.getByRole('button', { name: 'Criar wallet', exact: true }).click();
      await page.getByTestId('wallet-balance').filter({ hasText: '123.45' }).waitFor();
      await page.getByRole('cell', { name: 'OPENING', exact: true }).waitFor();
      const firstWalletId = await page.getByTestId('wallet-id').textContent();
      await page.getByLabel('Comportamento').selectOption('out-of-order');
      await page.getByLabel('Valor (BRL)').last().fill('7.25');
      await page.getByRole('button', { name: 'Executar cenário' }).click();
      await page.locator('#receipt-fields').getByText('PENDING_REFERENCE').waitFor();
      await page.locator('#current-fields').getByText('PROCESSED').waitFor();
      await page.waitForFunction(
        () => document.querySelectorAll('#demo-results-list li').length === 2,
      );
      const outOfOrderRows = await page.locator('#demo-results-list li').allTextContents();
      expect(outOfOrderRows.some((text) => text.includes('recibo PENDING_REFERENCE'))).toBe(true);
      expect(outOfOrderRows.every((text) => text.includes('estado atual PROCESSED'))).toBe(true);
      await page
        .getByRole('button', { name: /Detalhes da transação/ })
        .first()
        .waitFor();
      const originalTransactionId = await page
        .locator('#transaction-fields dd')
        .nth(0)
        .textContent();
      const originalExternalId = await page.locator('#transaction-fields dd').nth(1).textContent();
      let releaseStaleDetail!: () => void;
      let staleDetailStarted!: () => void;
      const staleDetail = new Promise<void>((resolve) => (releaseStaleDetail = resolve));
      const staleStarted = new Promise<void>((resolve) => (staleDetailStarted = resolve));
      await page.route(`**/wagering/transactions/${originalTransactionId}`, async (route) => {
        staleDetailStarted();
        await staleDetail;
        await route.continue();
      });
      await page
        .getByRole('button', { name: `Detalhes da transação ${originalExternalId}` })
        .click();
      await staleStarted;
      const detailLabels = await page
        .locator('#transactions-rows button')
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') ?? ''));
      const otherDetailIndex = detailLabels.findIndex(
        (label) => !label.endsWith(originalExternalId ?? ''),
      );
      await page.locator('#transactions-rows button').nth(otherDetailIndex).click();
      await page.waitForFunction(
        (oldId) => document.querySelector('#transaction-fields dd')?.textContent !== oldId,
        originalTransactionId,
      );
      const selectedTransactionId = await page
        .locator('#transaction-fields dd')
        .nth(0)
        .textContent();
      expect(selectedTransactionId).not.toBe(originalTransactionId);
      releaseStaleDetail();
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
      expect(await page.locator('#transaction-fields dd').nth(0).textContent()).toBe(
        selectedTransactionId,
      );
      await page.unroute(`**/wagering/transactions/${originalTransactionId}`);
      await page
        .getByRole('button', { name: `Detalhes da transação ${originalExternalId}` })
        .click();
      await page.locator('#receipt-fields').getByText('PENDING_REFERENCE').waitFor();
      await page.getByLabel('Comportamento').selectOption('duplicate');
      await page.getByLabel('Valor (BRL)').last().fill('4.00');
      await page.getByRole('button', { name: 'Executar cenário' }).click();
      await page
        .locator('#demo-results-list')
        .getByText(/replay true/)
        .waitFor();
      await page.getByText('Todas as operações têm estado terminal confirmado por GET.').waitFor();
      const duplicateRows = await page.locator('#demo-results-list li').allTextContents();
      expect(duplicateRows).toHaveLength(2);
      expect(duplicateRows.some((text) => text.includes('replay false'))).toBe(true);
      expect(duplicateRows.some((text) => text.includes('replay true'))).toBe(true);
      await page.getByLabel('Comportamento').selectOption('race');
      expect(await page.getByLabel('Valor (BRL)').last().isDisabled()).toBe(true);
      await page.getByRole('button', { name: 'Executar cenário' }).click();
      await page
        .locator('#demo-results-list')
        .getByText(/estado atual REJECTED/)
        .waitFor();
      await page.getByText('Todas as operações têm estado terminal confirmado por GET.').waitFor();
      const raceRows = await page.locator('#demo-results-list li').allTextContents();
      expect(raceRows).toHaveLength(2);
      expect(raceRows.some((text) => text.includes('estado atual PROCESSED'))).toBe(true);
      expect(raceRows.some((text) => text.includes('estado atual REJECTED'))).toBe(true);
      if (process.env.SCREENSHOTS === '1') {
        const evidenceDir = resolve('docs/evidence/issue-10');
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
      // A completed scenario must not restore its wallet after the user selects another one.
      let releaseScenarioWallet!: () => void;
      let scenarioWalletStarted!: () => void;
      const scenarioWalletHeld = new Promise<void>((resolve) => (releaseScenarioWallet = resolve));
      const scenarioWalletReady = new Promise<void>((resolve) => (scenarioWalletStarted = resolve));
      await page.route(`**/wallets/${firstWalletId}`, async (route) => {
        const response = await route.fetch();
        scenarioWalletStarted();
        await scenarioWalletHeld;
        await route.fulfill({ response });
      });
      await page.getByLabel('Comportamento').selectOption('duplicate');
      await page.getByLabel('Valor (BRL)').last().fill('1.00');
      await page.getByRole('button', { name: 'Executar cenário' }).click();
      await scenarioWalletReady;
      await page.getByLabel('Jogador').fill(`browser-${crypto.randomUUID()}`);
      await page.getByLabel('Saldo inicial (BRL)').fill('60.00');
      await page.getByRole('button', { name: 'Criar wallet', exact: true }).click();
      await page.getByTestId('wallet-balance').filter({ hasText: '60.00' }).waitFor();
      const selectedAfterScenario = await page.getByTestId('wallet-id').textContent();
      releaseScenarioWallet();
      await page.waitForFunction(
        () => !document.querySelector<HTMLButtonElement>('#scenario button')!.disabled,
      );
      expect(await page.getByTestId('wallet-id').textContent()).toBe(selectedAfterScenario);
      expect(await page.locator('#transaction-detail').isHidden()).toBe(true);
      await page.unroute(`**/wallets/${firstWalletId}`);

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
      expect(
        await viewer.getByRole('button', { name: 'Executar cenário', exact: true }).count(),
      ).toBe(0);
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
