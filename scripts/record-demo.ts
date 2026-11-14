// Records the narrated demo video (docs/demo-script.md) against a LOCAL Compose stack.
// Failures are injected only with `docker compose kill` on this machine; the app exposes no such endpoint.
//
// Pipeline (see docs/demo-script.md):
//   bun scripts/demo/voice.ts <outDir>     narration clips + voice/manifest.json (edge-tts)
//   bun scripts/record-demo.ts <outDir>    drives the console, paced by the clips -> demo.webm, timeline.json
//   bun scripts/demo/mix.ts <outDir>       voice + video -> demo.mp4 with subtitles
// Without voice/manifest.json the recorder still runs, pacing each line by its length (silent draft).
import { existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { chromium, type Locator, type Page } from 'playwright';
import { loadConfig } from '../src/config/config';
import { createSqsClient } from '../src/config/sqs';
import type { DemoScenarioResult } from '../src/modules/demo/demo-contract';
import type { TransactionView } from '../src/modules/wagering/application/wagering-store';
import type { Wallets } from '../src/modules/wallets/application/wallets';
import type { walletResponse } from '../src/modules/wallets/rest/wallet-contract';
import { commandEnvelope, type CommandEnvelope } from '../tests/support/command-fixture';
import { consoleLogin } from '../tests/support/keycloak';
import { narration } from './demo/narration';
import type { VoiceClip } from './demo/voice';

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
export interface TimelineEntry {
  id: string;
  startMs: number;
  durationMs: number;
  caption: string;
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

const manifestPath = resolve(outDir, 'voice/manifest.json');
const clips = new Map<string, VoiceClip>(
  existsSync(manifestPath)
    ? ((await Bun.file(manifestPath).json()) as { clips: VoiceClip[] }).clips.map((clip) => [
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
const cuts: { startMs: number; endMs: number }[] = [];
let t0 = 0;

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

/* ---------- On-screen production layer: cursor, terminal, title cards ---------- */

const productionLayer = () => {
  const install = () => {
    if (document.getElementById('demo-cursor')) return;
    const style = document.createElement('style');
    style.textContent = `
      #demo-cursor{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;
        transform:translate(var(--x,640px),var(--y,420px));transition:transform 650ms cubic-bezier(.16,1,.3,1),opacity 200ms;opacity:0}
      #demo-cursor.on{opacity:1}
      #demo-cursor svg{filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}
      #demo-cursor.press::after{content:'';position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;
        border:2px solid #ffd23f;animation:demo-ring 520ms cubic-bezier(.16,1,.3,1) forwards}
      @keyframes demo-ring{from{transform:scale(.4);opacity:1}to{transform:scale(1.6);opacity:0}}
      #demo-terminal{position:fixed;right:28px;bottom:28px;width:600px;z-index:2147483646;background:#14121c;color:#e0f3e8;
        box-shadow:0 18px 50px rgba(10,4,30,.45);font:14px/1.55 'JetBrains Mono',ui-monospace,monospace;
        opacity:0;transform:translateY(12px);transition:opacity 280ms ease-out,transform 280ms cubic-bezier(.16,1,.3,1)}
      #demo-terminal.on{opacity:1;transform:none}
      #demo-terminal header{display:flex;gap:8px;align-items:center;padding:8px 14px;background:#24164f;color:#bdb4e6;
        font:600 12px/1 Archivo,system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase}
      #demo-terminal header i{width:8px;height:8px;background:#ffd23f;display:inline-block}
      #demo-terminal pre{margin:0;padding:14px 16px 16px;white-space:pre-wrap;word-break:break-word}
      #demo-terminal b{color:#ffd23f;font-weight:500}
      .demo-card{position:fixed;inset:0;z-index:2147483645;display:grid;place-content:center;gap:22px;padding:80px;
        background:#24164f;color:#f3f0ff;font-family:Archivo,system-ui,sans-serif;transition:opacity 700ms ease-out}
      .demo-card h1{margin:0;font-size:96px;font-stretch:72%;font-weight:750;letter-spacing:-.03em;line-height:1}
      .demo-card p{margin:0;font-size:26px;color:#bdb4e6;max-width:30ch}
      .demo-card .mark{display:flex;gap:16px;align-items:center}
      .demo-card .kind{align-self:start;justify-self:start;padding:4px 10px;background:#ffd23f;color:#2e2200;
        font-size:15px;font-weight:800;font-stretch:70%;letter-spacing:.08em}
      .demo-card ul{margin:8px 0 0;padding:0;list-style:none;display:grid;gap:10px;font:20px/1.4 'JetBrains Mono',monospace;color:#e0f3e8}
      .demo-card li::before{content:'$ ';color:#ffd23f}
    `;
    document.documentElement.append(style);
    const cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    cursor.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l15 8.5-6.5 1.6L8 18.5z" fill="#14121c" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    document.documentElement.append(cursor);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
};

let cursor = { x: 640, y: 420 };
async function moveTo(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) return;
  cursor = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.evaluate(({ x, y }) => {
    const el = document.getElementById('demo-cursor');
    el?.classList.add('on');
    el?.style.setProperty('--x', `${x}px`);
    el?.style.setProperty('--y', `${y}px`);
  }, cursor);
  await page.waitForTimeout(700);
}
async function restoreCursor(page: Page) {
  await page.evaluate(({ x, y }) => {
    const el = document.getElementById('demo-cursor');
    el?.style.setProperty('transition', 'none');
    if (location.protocol !== 'about:') el?.classList.add('on');
    el?.style.setProperty('--x', `${x}px`);
    el?.style.setProperty('--y', `${y}px`);
    requestAnimationFrame(() => el?.style.removeProperty('transition'));
  }, cursor);
}
async function click(page: Page, target: Locator) {
  await moveTo(page, target);
  await page.evaluate(() => {
    const el = document.getElementById('demo-cursor');
    el?.classList.remove('press');
    void el?.offsetWidth;
    el?.classList.add('press');
  });
  await page.waitForTimeout(160);
  await target.click();
}
async function type(page: Page, target: Locator, text: string) {
  await click(page, target);
  await target.fill('');
  await target.pressSequentially(text, { delay: 55 });
}
async function reveal(page: Page, target: Locator, block: 'start' | 'center' | 'end' = 'start') {
  await target.evaluate((el, where) => {
    const top = el.getBoundingClientRect().top + window.scrollY;
    const offset =
      where === 'start'
        ? 72
        : where === 'center'
          ? innerHeight / 2 - el.clientHeight / 2
          : innerHeight - el.clientHeight - 40;
    window.scrollTo({ top: Math.max(0, top - offset), behavior: 'smooth' });
  }, block);
  await page.waitForTimeout(900);
}

/** A terminal panel that types the command, then prints the real output. */
async function terminal(page: Page, command: string, output: string, holdMs = 2600) {
  await page.evaluate((cmd) => {
    document.getElementById('demo-terminal')?.remove();
    const box = document.createElement('div');
    box.id = 'demo-terminal';
    box.innerHTML =
      '<header><i></i>terminal · ambiente local</header><pre><b>$</b> <span></span></pre>';
    document.documentElement.append(box);
    requestAnimationFrame(() => box.classList.add('on'));
    const target = box.querySelector('span')!;
    let index = 0;
    const tick = () => {
      target.textContent = cmd.slice(0, ++index);
      if (index < cmd.length) setTimeout(tick, 28);
    };
    setTimeout(tick, 250);
  }, command);
  await page.waitForTimeout(400 + command.length * 28);
  await page.evaluate((out) => {
    const pre = document.querySelector('#demo-terminal pre');
    if (pre) pre.append(`\n${out}`);
  }, output);
  await page.waitForTimeout(holdMs);
}
async function closeTerminal(page: Page) {
  await page.evaluate(() => {
    const box = document.getElementById('demo-terminal');
    box?.classList.remove('on');
    setTimeout(() => box?.remove(), 300);
  });
}

const titleCard = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><link rel="stylesheet" href="${base}/style.css"></head>
<body style="margin:0"><div class="demo-card" style="position:fixed;inset:0;display:grid;place-content:center;gap:22px;padding:96px;background:#24164f;color:#f3f0ff;font-family:Archivo,system-ui,sans-serif">
<span style="align-self:start;justify-self:start;padding:4px 10px;background:#ffd23f;color:#2e2200;font-size:15px;font-weight:800;font-stretch:70%;letter-spacing:.08em">DESAFIO DE BACKEND · PROCESSADOR DE APOSTAS</span>
<h1 style="margin:0;font-size:120px;font-stretch:72%;font-weight:750;letter-spacing:-.03em;line-height:1">Lastro</h1>
<p style="margin:0;font-size:30px;color:#bdb4e6;max-width:26ch">Cada garantia, provada com os dados da execução.</p>
<p style="margin:12px 0 0;font:16px/1.5 'JetBrains Mono',monospace;color:#bdb4e6">API · workers · PostgreSQL · SQS · Keycloak — stack local real</p>
</div></body></html>`;

async function outroCard(page: Page) {
  await page.evaluate(() => {
    const card = document.createElement('div');
    card.className = 'demo-card';
    card.style.opacity = '0';
    card.innerHTML = `<span class="kind">5 DE 5 GARANTIAS MANTIDAS</span>
      <h1>Lastro</h1>
      <p>Disputa, idempotência, referência fora de ordem, recuperação e reconciliação, com os dados desta execução.</p>
      <ul><li>bun run test:concurrency</li><li>bun run test:recovery</li><li>bun run test:browser</li></ul>`;
    document.documentElement.append(card);
    document.getElementById('demo-cursor')?.classList.remove('on');
    requestAnimationFrame(() => (card.style.opacity = '1'));
  });
}

/* ---------- Console helpers ---------- */

const nav = (page: Page) => page.getByRole('navigation', { name: 'Provas e evidências' });
const runButton = (page: Page) => page.getByRole('button', { name: /Executar (prova|de novo)/ });
const brl = (amount: string) => amount.replace('.', ',');

async function runProof(page: Page) {
  const response = page.waitForResponse((r) => r.url().endsWith('/demo/scenarios'));
  await click(page, runButton(page));
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
  recordVideo: { dir: outDir, size: { width: 1920, height: 1200 } },
});
await context.addInitScript(productionLayer);
const page = await context.newPage();
t0 = Date.now();
page.on('load', () => void restoreCursor(page).catch(() => {}));
try {
  await page.setContent(titleCard, { waitUntil: 'networkidle' });
  await say('intro');

  await page.goto(base);
  const enter = page.getByRole('button', { name: 'Entrar', exact: true });
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(
      (b) => b.textContent?.trim() === 'Entrar' && !b.disabled,
    ),
  );
  run.health = await sh('curl', '-fsS', `${base}/health/ready`);
  await say('stack', () => terminal(page, `curl -fsS ${base}/health/ready`, run.health!, 3500));
  await closeTerminal(page);

  await say('login', async () => {
    await click(page, enter);
    await type(page, page.locator('#username'), 'demo-operator');
    await type(page, page.locator('#password'), password);
    await click(page, page.locator('#kc-login'));
    await page.locator('.console').waitFor();
  });

  const playerId = `video-${crypto.randomUUID().slice(0, 8)}`;
  await say('wallet', async () => {
    await type(page, page.getByLabel('Jogador'), playerId);
    await moveTo(page, page.getByLabel('Saldo inicial'));
    await page.waitForTimeout(900);
    await click(page, page.getByRole('button', { name: 'Criar wallet', exact: true }));
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
    await moveTo(page, page.locator('.result .stamp'));
    await page.waitForTimeout(2500);
    await reveal(page, page.locator('.result .tickets'));
    await moveTo(page, page.locator('.result .ticket').nth(1).locator('.validation .status'));
  });
  await say('ticket', async () => {
    const first = page.locator('.result .ticket').first();
    await moveTo(page, first.locator('.stub h4'));
    await page.waitForTimeout(3600);
    await moveTo(page, first.locator('.perforation'));
    await page.waitForTimeout(1200);
    await moveTo(page, first.locator('.validation h4'));
  });

  // Proof 2 — idempotent replay.
  await say('duplicate-intro', async () => {
    await click(page, nav(page).getByRole('button', { name: /Repetição idempotente/ }));
    await page.waitForTimeout(2600);
    run.duplicate = (await runProof(page)).transactions;
    await stamp(page);
  });
  await page.getByTestId('wallet-balance').filter({ hasText: '15,00' }).waitFor();
  await say('duplicate-result', async () => {
    await reveal(page, page.locator('.result .tickets'));
    await moveTo(page, page.locator('.result .replay-yes'));
  });

  // Proof 3 — out-of-order reference, worker alive.
  await say('order-intro', async () => {
    await click(page, nav(page).getByRole('button', { name: /Referência fora de ordem/ }));
    await page.waitForTimeout(800);
    run.outOfOrderProof = (await runProof(page)).transactions;
    await stamp(page);
  });
  await say('order-result', async () => {
    const refund = page.locator('.result .ticket').first();
    await reveal(page, refund);
    await moveTo(page, refund.locator('.stub .status'));
    await page.waitForTimeout(3800);
    await moveTo(page, refund.locator('.changed-note'));
  });

  // Proof 4 — process failure and recovery.
  await say('recovery-intro', async () => {
    await click(page, nav(page).getByRole('button', { name: /Recuperação após falha/ }));
    await page.waitForTimeout(1500);
    run.killReferenceWorker = await sh('docker', 'compose', 'kill', 'reference-worker');
    await terminal(
      page,
      'docker compose kill reference-worker',
      run.killReferenceWorker || 'Container reference-worker Killed',
      2200,
    );
  });
  await closeTerminal(page);
  let refundId = '';
  await say('recovery-pending', async () => {
    const result = await runProof(page);
    run.outOfOrder = result.transactions;
    const refund = result.transactions.find((t) => t.httpStatus === 202);
    if (!refund) throw new Error('Recovery proof returned no 202 PENDING_REFERENCE receipt');
    refundId = refund.originalReceipt.body.transactionId;
    await page.locator('.result .ticket').first().waitFor();
    await page.waitForTimeout(900);
    await reveal(page, page.locator('.result .ticket').first());
    await moveTo(page, page.locator('.result .ticket').first().locator('.validation .status'));
    run.refundWhileWorkerDown = await transaction(refundId);
  });
  await say('recovery-restart', async () => {
    run.startReferenceWorker = await sh('docker', 'compose', 'start', 'reference-worker');
    await terminal(
      page,
      'docker compose start reference-worker',
      run.startReferenceWorker || 'Container reference-worker Started',
      1200,
    );
  });
  await idle(() => stamp(page, 90000), 1400);
  await closeTerminal(page);
  run.refundAfterRestart = await transaction(refundId);
  await say('recovery-result', async () => {
    await reveal(page, page.locator('.result'));
    await moveTo(page, page.locator('.verdict h2'));
  });

  // The command queue: consumer down, message waits, redelivery does not double-debit.
  const externalId = `sqs-${crypto.randomUUID().slice(0, 8)}`;
  await say('sqs-intro', async () => {
    await click(page, nav(page).getByRole('button', { name: 'Bilhetes' }));
    run.killCommandConsumer = await sh('docker', 'compose', 'kill', 'command-consumer');
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
      `${run.killCommandConsumer || 'Container command-consumer Killed'}\nmessageId=${first.body.messageId}\nna fila (visíveis + em voo): ${first.queueDepth}`,
      1500,
    );
  });
  await closeTerminal(page);
  run.startCommandConsumer = await sh('docker', 'compose', 'start', 'command-consumer');
  await terminal(
    page,
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
    await closeTerminal(page);
    await click(page, page.getByRole('button', { name: 'Atualizar' }));
    await page.getByTestId('wallet-balance').filter({ hasText: '5,00' }).waitFor();
    await moveTo(page, page.locator('.ticket').first().locator('.ticket-head'));
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
    await terminal(
      page,
      'reenvio da mesma operação (delivery-2)',
      `saldo ${brl(afterSecond.balance.amount)} · versão ${afterSecond.version} (inalterados)`,
      1800,
    );
  });
  await closeTerminal(page);
  await say('ledger', async () => {
    await click(page, nav(page).getByRole('button', { name: 'Ledger' }));
    await page.getByText('Fecha com o saldo da wallet').waitFor();
    await reveal(page, page.locator('table.ledger tfoot'), 'end');
    await moveTo(page, page.locator('table.ledger tfoot td'));
  });

  // Proof 5 — reconciliation.
  await say('reconcile-intro', async () => {
    await click(page, nav(page).getByRole('button', { name: /Reconciliação/ }));
    await page.waitForTimeout(3800);
    const reconciliationResponse = page.waitForResponse((r) => r.url().endsWith('/reconciliation'));
    await click(page, runButton(page));
    run.reconciliation = (await (await reconciliationResponse).json()) as ReconciliationBody;
    await stamp(page);
  });
  await say('reconcile-result', async () => {
    await moveTo(page, page.locator('.result .ticket .validation'));
    await page.waitForTimeout(3600);
    await moveTo(page, page.locator('.rail-complete'));
  });
  await say('outro', () => outroCard(page));
  await page.waitForTimeout(1500);
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
  await Bun.write(resolve(outDir, 'timeline.json'), JSON.stringify(timeline, null, 2) + '\n');
  await Bun.write(resolve(outDir, 'cuts.json'), JSON.stringify(cuts, null, 2) + '\n');
  console.log(`Demo video, timeline and run data: ${outDir}`);
}
