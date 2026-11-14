// Records the demo video (docs/demo-script.md) against a LOCAL Compose stack.
// Failures are injected only with `docker compose kill` on this machine; the app exposes no such endpoint.
// Usage: CONSOLE_URL=http://localhost:3000 bun scripts/record-demo.ts [outDir]
import { mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { chromium, type Page } from 'playwright';
import { loadConfig } from '../src/config/config';
import { createSqsClient } from '../src/config/sqs';
import type { DemoScenarioResult } from '../src/modules/demo/demo-contract';
import type { TransactionView } from '../src/modules/wagering/application/wagering-store';
import type { Wallets } from '../src/modules/wallets/application/wallets';
import type { walletResponse } from '../src/modules/wallets/rest/wallet-contract';
import { commandEnvelope, type CommandEnvelope } from '../tests/support/command-fixture';
import { consoleLogin } from '../tests/support/keycloak';

type WalletBody = ReturnType<typeof walletResponse>;
type ReconciliationBody = Awaited<ReturnType<Wallets['reconcile']>>;
interface DemoRun {
  startedAt: string;
  consoleUrl: string;
  finishedAt: string;
  health: string;
  wallet: { walletId: string; playerId: string; opening: string };
  race: DemoScenarioResult['transactions'];
  duplicate: DemoScenarioResult['transactions'];
  killReferenceWorker: string;
  outOfOrder: DemoScenarioResult['transactions'];
  refundWhileWorkerDown: TransactionView;
  startReferenceWorker: string;
  refundAfterRestart: TransactionView;
  killCommandConsumer: string;
  sqsFirst: { messageId: string; queueDepth: number };
  startCommandConsumer: string;
  sqsProcessed: TransactionView;
  sqsSecond: { messageId: string };
  walletAfterSqs: { afterFirst: WalletBody; afterSecond: WalletBody };
  reconciliation: ReconciliationBody;
}

const base = (process.env.CONSOLE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const outDir = resolve(
  process.argv[2] ?? `artifacts/demo/${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
const password = process.env.DEMO_PASSWORD ?? 'demo-only';
const pace = Number(process.env.DEMO_PACE_MS ?? 2200);
const run: Partial<DemoRun> = { startedAt: new Date().toISOString(), consoleUrl: base };
const config = loadConfig();
const sqs = createSqsClient(config);

async function sh(...args: string[]) {
  const child = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${args.join(' ')} failed: ${err}`);
  return (out + err).trim();
}

async function caption(page: Page, text: string, hold = pace) {
  await page.evaluate((value) => {
    let bar = document.getElementById('demo-caption');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'demo-caption';
      bar.style.cssText =
        'position:fixed;left:324px;right:24px;bottom:20px;z-index:9999;padding:14px 18px;' +
        'background:rgba(25,14,58,.95);color:#f3f0ff;border-top:3px solid #ffd23f;' +
        'font:600 17px/1.45 Archivo,system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25)';
      document.body.append(bar);
    }
    bar.textContent = value;
  }, text);
  await page.waitForTimeout(hold);
}

async function terminal(page: Page, command: string, output: string, hold = pace * 1.5) {
  await page.evaluate(
    ([cmd, out]) => {
      const box = document.createElement('pre');
      box.id = 'demo-terminal';
      box.style.cssText =
        'position:fixed;top:90px;right:24px;width:560px;max-height:60vh;overflow:hidden;z-index:9999;margin:0;padding:16px;' +
        "background:#14121c;color:#e0f3e8;font:13px/1.5 'JetBrains Mono',ui-monospace,monospace;white-space:pre-wrap;" +
        'box-shadow:0 10px 30px rgba(0,0,0,.35)';
      box.textContent = `$ ${cmd}\n${out}`;
      document.body.append(box);
    },
    [command, output],
  );
  await page.waitForTimeout(hold);
  await page.evaluate(() => document.getElementById('demo-terminal')?.remove());
}

async function openProof(page: Page, name: RegExp) {
  await page
    .getByRole('navigation', { name: 'Provas e evidências' })
    .getByRole('button', { name })
    .click();
}

async function proof(page: Page, name: RegExp, amount?: string, waitStamp = true) {
  await openProof(page, name);
  if (amount) await page.getByLabel('Valor por operação').fill(amount.replace('.', ','));
  const response = page.waitForResponse((r) => r.url().endsWith('/demo/scenarios'));
  await page.getByRole('button', { name: /Executar (prova|de novo)/ }).click();
  const body = (await (await response).json()) as DemoScenarioResult;
  if (waitStamp) await page.locator('.result .stamp').waitFor({ timeout: 30000 });
  return body;
}

async function sendCommand(
  walletId: string,
  playerId: string,
  externalId: string,
  messageId: string,
  amount: string,
) {
  const { QueueUrl } = await sqs.send(
    new GetQueueUrlCommand({
      QueueName: process.env.COMMAND_QUEUE_NAME ?? 'wager-transactions.fifo',
    }),
  );
  const body: CommandEnvelope = commandEnvelope(
    {
      providerId: 'provider-a',
      externalTransactionId: externalId,
      idempotencyKey: `provider-a:${externalId}`,
      playerId,
      walletId,
      roundId: `demo-video-${externalId}`,
      gameId: 'jungle-demo',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    },
    messageId,
  );
  await sqs.send(
    new SendMessageCommand({
      QueueUrl,
      MessageBody: JSON.stringify(body),
      MessageGroupId: walletId,
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );
  const attributes = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  const visible = Number(attributes.Attributes?.ApproximateNumberOfMessages ?? 0);
  const inFlight = Number(attributes.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
  return { queueDepth: visible + inFlight, body };
}

async function showEvidence(page: Page, view: 'Bilhetes' | 'Ledger', balance: string) {
  await page
    .getByRole('navigation', { name: 'Provas e evidências' })
    .getByRole('button', { name: view })
    .click();
  await page
    .getByTestId('wallet-balance')
    .filter({ hasText: brl(balance) })
    .waitFor();
}

/** "15.00" -> "15,00", as the console renders money. */
const brl = (amount: string) => amount.replace('.', ',');

await mkdir(outDir, { recursive: true });
const viewerToken = await consoleLogin(base, 'viewer', password);
async function api<T>(path: string): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${viewerToken}` },
  });
  if (!response.ok) throw new Error(`GET ${path} failed (${response.status})`);
  return (await response.json()) as T;
}
const transaction = (id: string) => api<TransactionView>(`/wagering/transactions/${id}`);
const wallet = (id: string) => api<WalletBody>(`/wallets/${id}`);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: outDir, size: { width: 1280, height: 800 } },
});
const page = await context.newPage();
try {
  await page.goto(base);
  await page.getByRole('button', { name: 'Entrar' }).waitFor();
  await caption(
    page,
    'Lastro — console de prova do processador de apostas. Stack local real: API, workers, PostgreSQL, SQS (LocalStack) e Keycloak.',
  );
  run.health = await sh('curl', '-fsS', `${base}/health/ready`);
  await terminal(page, `curl ${base}/health/ready`, run.health, pace);
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(
      (b) => b.textContent?.trim() === 'Entrar' && !b.disabled,
    ),
  );
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.locator('#username').fill('demo-operator');
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
  await page.locator('.console').waitFor();
  await caption(
    page,
    'Login via Keycloak (Authorization Code + PKCE) como demo-operator. Criando uma wallet fictícia com R$ 100,00.',
  );

  const playerId = `video-${crypto.randomUUID().slice(0, 8)}`;
  await page.getByLabel('Jogador').fill(playerId);
  await page.getByLabel('Saldo inicial').fill('100,00');
  await page.getByRole('button', { name: 'Criar wallet', exact: true }).click();
  await page.getByTestId('wallet-balance').filter({ hasText: '100,00' }).waitFor();
  const walletId = (await page.getByTestId('wallet-id').locator('code').textContent())?.trim();
  if (!walletId) throw new Error('Console did not show the created wallet ID');
  run.wallet = { walletId, playerId, opening: '100.00' };

  await caption(
    page,
    'Prova 1 — disputa de saldo: duas BETs de 80% do saldo, ao mesmo tempo, pelo endpoint real do provedor.',
  );
  const race = await proof(page, /Disputa pelo saldo/);
  run.race = race.transactions;
  await page.getByTestId('wallet-balance').filter({ hasText: '20,00' }).waitFor();
  await caption(
    page,
    'Uma aceita (200), outra recusada por saldo insuficiente (422). Um único débito: o saldo nunca fica negativo.',
    pace * 2,
  );

  await caption(
    page,
    'Prova 2 — replay idempotente: a mesma aposta, com a mesma chave, enviada duas vezes em paralelo.',
  );
  const duplicate = await proof(page, /Repetição idempotente/, '5.00');
  run.duplicate = duplicate.transactions;
  await page.getByTestId('wallet-balance').filter({ hasText: '15,00' }).waitFor();
  await caption(
    page,
    'Mesmo transactionId; o segundo recibo é um replay (idempotentReplay: true). Um débito só.',
    pace * 2,
  );

  await caption(
    page,
    'Prova 3 — referência fora de ordem: o REFUND chega antes da BET que ele estorna.',
  );
  await proof(page, /Referência fora de ordem/, '5.00');
  await caption(
    page,
    'Canhoto: 202 PENDING_REFERENCE. Validação: PROCESSED, resolvido quando a BET chegou. Saldo inalterado.',
    pace * 2,
  );

  await openProof(page, /Recuperação após falha/);
  await caption(
    page,
    'Prova 4 — falha: derrubamos o reference-worker com SIGKILL, só no ambiente local.',
  );
  run.killReferenceWorker = await sh('docker', 'compose', 'kill', 'reference-worker');
  await terminal(
    page,
    'docker compose kill reference-worker',
    run.killReferenceWorker || 'Container reference-worker Killed',
  );
  const outOfOrder = await proof(page, /Recuperação após falha/, '5.00', false);
  run.outOfOrder = outOfOrder.transactions;
  const refund = outOfOrder.transactions.find((t) => t.httpStatus === 202);
  if (!refund) throw new Error('Recovery proof returned no 202 PENDING_REFERENCE receipt');
  const refundId = refund.originalReceipt.body.transactionId;
  await caption(
    page,
    'Com o worker fora do ar, o REFUND segue pendente: a agenda de retry está no PostgreSQL, não na memória do processo.',
    Math.max(pace * 2, 7000),
  );
  run.refundWhileWorkerDown = await transaction(refundId);
  run.startReferenceWorker = await sh('docker', 'compose', 'start', 'reference-worker');
  await terminal(
    page,
    'docker compose start reference-worker',
    run.startReferenceWorker || 'Container reference-worker Started',
  );
  await page.locator('.result .stamp').waitFor({ timeout: 90000 });
  run.refundAfterRestart = await transaction(refundId);
  await caption(
    page,
    'O worker voltou e retomou o REFUND. O recibo original (202) segue no canhoto, imutável.',
    pace * 2,
  );

  await caption(
    page,
    'Falha do consumidor SQS: derrubamos o command-consumer e enviamos uma BET de 10,00 pela fila.',
  );
  run.killCommandConsumer = await sh('docker', 'compose', 'kill', 'command-consumer');
  const externalId = `sqs-${crypto.randomUUID().slice(0, 8)}`;
  await showEvidence(page, 'Bilhetes', '15.00');
  const first = await sendCommand(
    walletId,
    playerId,
    externalId,
    `${externalId}:delivery-1`,
    '10.00',
  );
  run.sqsFirst = { messageId: first.body.messageId, queueDepth: first.queueDepth };
  await terminal(
    page,
    'docker compose kill command-consumer && aws sqs send-message … wager-transactions.fifo',
    `${run.killCommandConsumer || 'Container command-consumer Killed'}\nmessageId=${first.body.messageId}\nmensagens na fila (visíveis + em voo)=${first.queueDepth}`,
  );
  run.startCommandConsumer = await sh('docker', 'compose', 'start', 'command-consumer');
  let processed: TransactionView | undefined;
  for (const until = Date.now() + 60000; Date.now() < until; await Bun.sleep(500)) {
    const response = await fetch(
      `${base}/providers/provider-a/wagering/transactions/${externalId}`,
      {
        headers: { Authorization: `Bearer ${viewerToken}` },
      },
    );
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`SQS transaction lookup failed (${response.status})`);
    processed = (await response.json()) as TransactionView;
    if (processed.status !== 'PENDING') break;
  }
  if (!processed) throw new Error(`SQS command ${externalId} was not processed within 60 s`);
  run.sqsProcessed = processed;
  const afterFirst = await wallet(walletId);
  await page.getByRole('button', { name: 'Atualizar' }).click();
  await page
    .getByTestId('wallet-balance')
    .filter({ hasText: brl(afterFirst.balance.amount) })
    .waitFor();
  await terminal(
    page,
    'docker compose start command-consumer',
    `${run.startCommandConsumer || 'Container command-consumer Started'}\ntransação ${externalId}: ${processed.status}\nsaldo ${afterFirst.balance.amount} · versão ${afterFirst.version}`,
  );
  await caption(
    page,
    'Reentrega com OUTRO messageId para a mesma operação: inbox e idempotência persistentes não repetem o débito.',
  );
  const second = await sendCommand(
    walletId,
    playerId,
    externalId,
    `${externalId}:delivery-2`,
    '10.00',
  );
  run.sqsSecond = { messageId: second.body.messageId };
  await Bun.sleep(4000);
  const afterSecond = await wallet(walletId);
  run.walletAfterSqs = { afterFirst, afterSecond };
  await terminal(
    page,
    'reenvio da mesma operação (delivery-2)',
    `saldo ${afterSecond.balance.amount} · versão ${afterSecond.version} (inalterados)`,
  );
  await showEvidence(page, 'Ledger', afterSecond.balance.amount);
  await page.getByText('Fecha com o saldo da wallet').waitFor();
  await caption(
    page,
    'O ledger tem um débito de 10,00 só, e o saldo corrente fecha com o saldo da wallet.',
    pace * 1.5,
  );

  await caption(
    page,
    'Prova 5 — reconciliação: o servidor reconstrói o saldo somando o ledger imutável.',
  );
  await openProof(page, /Reconciliação/);
  const reconciliationResponse = page.waitForResponse((r) => r.url().endsWith('/reconciliation'));
  await page.getByRole('button', { name: /Executar (prova|de novo)/ }).click();
  const reconciliation = (await (await reconciliationResponse).json()) as ReconciliationBody;
  run.reconciliation = reconciliation;
  await page.locator('.result .stamp').waitFor();
  await caption(
    page,
    `Registrado ${brl(reconciliation.storedBalance.amount)} = reconstruído ${brl(reconciliation.calculatedBalance.amount)}, ${reconciliation.checkedEntries} lançamentos. Nada é corrigido em silêncio.`,
    pace * 2.5,
  );
  await caption(
    page,
    'Morte após commit e antes do ack, publishers concorrentes e quedas isoladas são provados pelo harness: bun run test:recovery.',
    pace * 2,
  );
} finally {
  // Never leave the local stack degraded, even when a scene fails midway.
  await sh('docker', 'compose', 'start', 'reference-worker', 'command-consumer').catch(() => {});
  run.finishedAt = new Date().toISOString();
  const video = page.video();
  await context.close();
  await browser.close();
  sqs.destroy();
  if (video) await rename(await video.path(), resolve(outDir, 'demo.webm'));
  await Bun.write(resolve(outDir, 'demo-run.json'), JSON.stringify(run, null, 2) + '\n');
  console.log(`Demo video and run data: ${outDir}`);
}
