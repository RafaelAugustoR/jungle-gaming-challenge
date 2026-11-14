// Records the narrated demo video (docs/demo-script.md) against a LOCAL Compose stack.
// Failures are injected only with `docker compose kill` on this machine; the app exposes no such endpoint.
//
// Pipeline (see docs/demo-script.md):
//   bun scripts/demo/voice.ts <outDir>     narration clips + voice/manifest.json (edge-tts)
//   bun scripts/record-demo.ts <outDir>    drives the console, paced by the clips -> demo-video.mp4, timeline.json
//   bun scripts/demo/mix.ts <outDir>       voice + video -> demo.mp4 with subtitles
// Without voice/manifest.json the recorder still runs, pacing each line by its length (silent draft).
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
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
import { narration } from './demo/narration';
import {
  demoPaths,
  exec,
  type Cut,
  type TimelineEntry,
  type VoiceClip,
  type VoiceManifest,
} from './demo/artifacts';
import { createOverlay, showTitleCard } from './demo/overlay';
import { startScreencast } from './demo/screencast';

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
  outOfOrderProof: DemoScenarioResult['transactions'];
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
const gapMs = Number(process.env.DEMO_GAP_MS ?? 450);
const run: Partial<DemoRun> = { startedAt: new Date().toISOString(), consoleUrl: base };
const config = loadConfig();
const sqs = createSqsClient(config);

const paths = demoPaths(outDir);
const clips = new Map<string, VoiceClip>(
  existsSync(paths.manifest)
    ? ((await Bun.file(paths.manifest).json()) as VoiceManifest).clips.map((clip) => [
        clip.id,
        clip,
      ])
    : narration.map((line) => [
        line.id,
        {
          id: line.id,
          file: '',
          caption: line.caption,
          durationMs: 1200 + line.caption.length * 55,
        },
      ]),
);
const timeline: TimelineEntry[] = [];
/** Silent waits for the stack (a consumer restart, a retry backoff) that the edit removes. */
const cuts: Cut[] = [];
let t0 = 0;

/** Plays one narration line: the scene's actions run while it speaks; the scene lasts at least the line. */
async function say(id: string, during?: () => Promise<unknown>) {
  const clip = clips.get(id);
  if (!clip) throw new Error(`Narration line ${id} has no clip`);
  timeline.push({
    id,
    startMs: Date.now() - t0,
    durationMs: clip.durationMs,
    caption: clip.caption,
  });
  await Promise.all([Bun.sleep(clip.durationMs + gapMs), during?.()]);
}

/** Waits on the stack without narration; anything longer than a beat is marked to be cut in the edit. */
async function idle(task: () => Promise<unknown>, keepMs = 900) {
  const start = Date.now() - t0;
  await task();
  const end = Date.now() - t0;
  if (end - start > keepMs * 2 + 500) cuts.push({ startMs: start + keepMs, endMs: end - keepMs });
}

/* ---------- Console helpers ---------- */

const nav = (page: Page) => page.getByRole('navigation', { name: 'Provas e evidências' });
const runButton = (page: Page) => page.getByRole('button', { name: /Executar (prova|de novo)/ });
const brl = (amount: string) => amount.replace('.', ',');

async function runProof(page: Page) {
  const response = page.waitForResponse((r) => r.url().endsWith('/demo/scenarios'));
  await ui.click(runButton(page));
  return (await (await response).json()) as DemoScenarioResult;
}
async function stamp(page: Page, timeout = 30000) {
  await page.locator('.result .stamp').waitFor({ timeout });
  await page.waitForTimeout(600);
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
      gameId: 'lastro-demo',
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
  deviceScaleFactor: 1.5,
});
const page = await context.newPage();
// 1280×800 CSS at 1.5x: the screencast captures the real 1920×1200 device pixels.
const screencast = await startScreencast(page, outDir, { width: 1920, height: 1200 });
t0 = screencast.startedAt;
const ui = await createOverlay(page);
try {
  await showTitleCard(page, base);
  await say('intro');

  await page.goto(base);
  const enter = page.getByRole('button', { name: 'Entrar', exact: true });
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(
      (b) => b.textContent?.trim() === 'Entrar' && !b.disabled,
    ),
  );
  run.health = await exec('curl', '-fsS', `${base}/health/ready`);
  await say('stack', () => ui.terminal(`curl -fsS ${base}/health/ready`, run.health!, 3500));
  await ui.closeTerminal();

  await say('login', async () => {
    await ui.click(enter);
    await ui.type(page.locator('#username'), 'demo-operator');
    await ui.type(page.locator('#password'), password);
    await ui.click(page.locator('#kc-login'));
    await page.locator('.console').waitFor();
  });

  const playerId = `video-${crypto.randomUUID().slice(0, 8)}`;
  await say('wallet', async () => {
    await ui.type(page.getByLabel('Jogador'), playerId);
    await ui.moveTo(page.getByLabel('Saldo inicial'));
    await page.waitForTimeout(900);
    await ui.click(page.getByRole('button', { name: 'Criar wallet', exact: true }));
    await page.getByTestId('wallet-balance').filter({ hasText: '100,00' }).waitFor();
  });
  const walletId = (await page.getByTestId('wallet-id').locator('code').textContent())?.trim();
  if (!walletId) throw new Error('Console did not show the created wallet ID');
  run.wallet = { walletId, playerId, opening: '100.00' };

  // Proof 1 — race for the balance.
  await say('race-intro', async () => {
    await page.waitForTimeout(5200);
    run.race = (await runProof(page)).transactions;
    await stamp(page);
  });
  await page.getByTestId('wallet-balance').filter({ hasText: '20,00' }).waitFor();
  await say('race-result', async () => {
    await ui.moveTo(page.locator('.result .stamp'));
    await page.waitForTimeout(2500);
    await ui.reveal(page.locator('.result .tickets'));
    await ui.moveTo(page.locator('.result .ticket').nth(1).locator('.validation .status'));
  });
  await say('ticket', async () => {
    const first = page.locator('.result .ticket').first();
    await ui.moveTo(first.locator('.stub h4'));
    await page.waitForTimeout(3600);
    await ui.moveTo(first.locator('.perforation'));
    await page.waitForTimeout(1200);
    await ui.moveTo(first.locator('.validation h4'));
  });

  // Proof 2 — idempotent replay.
  await say('duplicate-intro', async () => {
    await ui.click(nav(page).getByRole('button', { name: /Repetição idempotente/ }));
    await page.waitForTimeout(2600);
    run.duplicate = (await runProof(page)).transactions;
    await stamp(page);
  });
  await page.getByTestId('wallet-balance').filter({ hasText: '15,00' }).waitFor();
  await say('duplicate-result', async () => {
    await ui.reveal(page.locator('.result .tickets'));
    await ui.moveTo(page.locator('.result .replay-yes'));
  });

  // Proof 3 — out-of-order reference, worker alive.
  await say('order-intro', async () => {
    await ui.click(nav(page).getByRole('button', { name: /Referência fora de ordem/ }));
    await page.waitForTimeout(800);
    run.outOfOrderProof = (await runProof(page)).transactions;
    await stamp(page);
  });
  await say('order-result', async () => {
    const refund = page.locator('.result .ticket').first();
    await ui.reveal(refund);
    await ui.moveTo(refund.locator('.stub .status'));
    await page.waitForTimeout(3800);
    await ui.moveTo(refund.locator('.changed-note'));
  });

  // Proof 4 — process failure and recovery.
  await say('recovery-intro', async () => {
    await ui.click(nav(page).getByRole('button', { name: /Recuperação após falha/ }));
    await page.waitForTimeout(1500);
    run.killReferenceWorker = await exec('docker', 'compose', 'kill', 'reference-worker');
    await ui.terminal(
      'docker compose kill reference-worker',
      run.killReferenceWorker || 'Container reference-worker Killed',
      2200,
    );
  });
  await ui.closeTerminal();
  let refundId = '';
  await say('recovery-pending', async () => {
    const result = await runProof(page);
    run.outOfOrder = result.transactions;
    const refund = result.transactions.find((t) => t.httpStatus === 202);
    if (!refund) throw new Error('Recovery proof returned no 202 PENDING_REFERENCE receipt');
    refundId = refund.originalReceipt.body.transactionId;
    await page.locator('.result .ticket').first().waitFor();
    await page.waitForTimeout(900);
    await ui.reveal(page.locator('.result .ticket').first());
    await ui.moveTo(page.locator('.result .ticket').first().locator('.validation .status'));
    run.refundWhileWorkerDown = await transaction(refundId);
  });
  await say('recovery-restart', async () => {
    run.startReferenceWorker = await exec('docker', 'compose', 'start', 'reference-worker');
    await ui.terminal(
      'docker compose start reference-worker',
      run.startReferenceWorker || 'Container reference-worker Started',
      1200,
    );
  });
  await idle(() => stamp(page, 90000), 1400);
  await ui.closeTerminal();
  run.refundAfterRestart = await transaction(refundId);
  await say('recovery-result', async () => {
    await ui.reveal(page.locator('.result'));
    await ui.moveTo(page.locator('.verdict h2'));
  });

  // The command queue: consumer down, message waits, redelivery does not double-debit.
  const externalId = `sqs-${crypto.randomUUID().slice(0, 8)}`;
  await say('sqs-intro', async () => {
    await ui.click(nav(page).getByRole('button', { name: 'Bilhetes' }));
    run.killCommandConsumer = await exec('docker', 'compose', 'kill', 'command-consumer');
    const first = await sendCommand(
      walletId,
      playerId,
      externalId,
      `${externalId}:delivery-1`,
      '10.00',
    );
    run.sqsFirst = { messageId: first.body.messageId, queueDepth: first.queueDepth };
    await ui.terminal(
      'docker compose kill command-consumer && aws sqs send-message … wager-transactions.fifo',
      `${run.killCommandConsumer || 'Container command-consumer Killed'}\nmessageId=${first.body.messageId}\nna fila (visíveis + em voo): ${first.queueDepth}`,
      1500,
    );
  });
  await ui.closeTerminal();
  run.startCommandConsumer = await exec('docker', 'compose', 'start', 'command-consumer');
  await ui.terminal(
    'docker compose start command-consumer',
    run.startCommandConsumer || 'Container command-consumer Started',
    600,
  );
  await idle(async () => {
    for (const until = Date.now() + 90000; Date.now() < until; await Bun.sleep(500)) {
      const response = await fetch(
        `${base}/providers/provider-a/wagering/transactions/${externalId}`,
        {
          headers: { Authorization: `Bearer ${viewerToken}` },
        },
      );
      if (response.status === 404) continue;
      if (!response.ok) throw new Error(`SQS transaction lookup failed (${response.status})`);
      run.sqsProcessed = (await response.json()) as TransactionView;
      if (run.sqsProcessed.status !== 'PENDING') return;
    }
    throw new Error(`SQS command ${externalId} was not processed within 90 s`);
  });
  await say('sqs-result', async () => {
    await ui.closeTerminal();
    await ui.click(page.getByRole('button', { name: 'Atualizar' }));
    await page.getByTestId('wallet-balance').filter({ hasText: '5,00' }).waitFor();
    await ui.moveTo(page.locator('.ticket').first().locator('.ticket-head'));
  });
  const afterFirst = await wallet(walletId);
  await say('sqs-redelivery', async () => {
    const second = await sendCommand(
      walletId,
      playerId,
      externalId,
      `${externalId}:delivery-2`,
      '10.00',
    );
    run.sqsSecond = { messageId: second.body.messageId };
    await Bun.sleep(3500);
    const afterSecond = await wallet(walletId);
    run.walletAfterSqs = { afterFirst, afterSecond };
    await ui.terminal(
      'reenvio da mesma operação (delivery-2)',
      `saldo ${brl(afterSecond.balance.amount)} · versão ${afterSecond.version} (inalterados)`,
      1800,
    );
  });
  await ui.closeTerminal();
  await say('ledger', async () => {
    await ui.click(nav(page).getByRole('button', { name: 'Ledger' }));
    await page.getByText('Fecha com o saldo da wallet').waitFor();
    await ui.reveal(page.locator('table.ledger tfoot'), 'end');
    await ui.moveTo(page.locator('table.ledger tfoot td'));
  });

  // Proof 5 — reconciliation.
  await say('reconcile-intro', async () => {
    await ui.click(nav(page).getByRole('button', { name: /Reconciliação/ }));
    await page.waitForTimeout(3800);
    const reconciliationResponse = page.waitForResponse((r) => r.url().endsWith('/reconciliation'));
    await ui.click(runButton(page));
    run.reconciliation = (await (await reconciliationResponse).json()) as ReconciliationBody;
    await stamp(page);
  });
  await say('reconcile-result', async () => {
    await ui.moveTo(page.locator('.result .ticket .validation'));
    await page.waitForTimeout(3600);
    await ui.moveTo(page.locator('.rail-complete'));
  });
  await say('outro', () => ui.outroCard());
  await page.waitForTimeout(1500);
} finally {
  // Never leave the local stack degraded, even when a scene fails midway.
  await exec('docker', 'compose', 'start', 'reference-worker', 'command-consumer').catch(() => {});
  run.finishedAt = new Date().toISOString();
  await screencast.stop(paths.video);
  await context.close();
  await browser.close();
  sqs.destroy();
  await Bun.write(paths.run, JSON.stringify(run, null, 2) + '\n');
  await Bun.write(paths.timeline, JSON.stringify(timeline, null, 2) + '\n');
  await Bun.write(paths.cuts, JSON.stringify(cuts, null, 2) + '\n');
  console.log(`Demo video, timeline and run data: ${outDir}`);
}
