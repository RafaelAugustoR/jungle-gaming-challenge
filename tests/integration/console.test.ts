import { expect, test } from 'bun:test';
import { chromium } from 'playwright';
const browserTest = process.env.BROWSER === '1' ? test : test.skip;
const base = process.env.CONSOLE_URL ?? 'http://localhost:3000';
browserTest(
  'demo operator logs in using PKCE, opens a wallet and reads its opening; viewer only reads',
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
      const id = await page.getByTestId('wallet-id').textContent();
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(
        await page.evaluate(() => Object.keys(localStorage).some((key) => /token/i.test(key))),
      ).toBe(false);
      if (process.env.SCREENSHOTS === '1') {
        for (const width of [1440, 768, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await page.screenshot({
            path: `docs/evidence/issue-3/console-${width}.png`,
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
      await viewer.getByTestId('wallet-balance').filter({ hasText: '123.45' }).waitFor();
      await viewer.getByRole('cell', { name: 'OPENING', exact: true }).waitFor();
      await viewerContext.close();
    } finally {
      await browser.close();
    }
  },
  60000,
);
