// Records the demo video (docs/demo-script.md) against a LOCAL Compose stack.
// Failures are injected only with `docker compose kill` on this machine; the app exposes no such endpoint.
// Usage: CONSOLE_URL=http://localhost:3000 bun scripts/record-demo.ts [outDir]
import { createHash } from 'node:crypto';
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

const base = (process.env.CONSOLE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const outDir = resolve(
  process.argv[2] ?? `artifacts/demo/${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
const password = process.env.DEMO_PASSWORD ?? 'demo-only';
const pace = Number(process.env.DEMO_PACE_MS ?? 2200);
const run: Record<string, unknown> = { startedAt: new Date().toISOString(), consoleUrl: base };
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

async function apiToken() {
  const consoleConfig = (await (await fetch(`${base}/console-config`)).json()) as {
    url: string;
    realm: string;
  };
  const issuer = `${consoleConfig.url}/realms/${consoleConfig.realm}`;
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const query = new URLSearchParams({
    client_id: 'jungle-console',
    redirect_uri: `${base}/`,
    response_type: 'code',
    scope: 'openid',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: crypto.randomUUID(),
  });
  const login = await fetch(`${issuer}/protocol/openid-connect/auth?${query}`, {
    redirect: 'manual',
  });
  const cookies = login.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
  const action = (await login.text()).match(/action="([^"]+)"/)![1]!.replaceAll('&amp;', '&');
  const submit = await fetch(action, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookies, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'viewer', password, credentialId: '' }),
  });
  const code = new URL(submit.headers.get('location')!).searchParams.get('code')!;
  const token = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: 'jungle-console',
      code,
      redirect_uri: `${base}/`,
      code_verifier: verifier,
    }),
  });
  return ((await token.json()) as { access_token: string }).access_token;
}

async function caption(page: Page, text: string, hold = pace) {
  await page.evaluate((value) => {
    let bar = document.getElementById('demo-caption');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'demo-caption';
      bar.style.cssText =
        'position:fixed;left:24px;right:24px;bottom:20px;z-index:9999;padding:14px 18px;border-radius:10px;' +
        'background:rgba(17,24,39,.92);color:#f9fafb;font:600 17px/1.45 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25)';
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
        'border-radius:10px;background:#0b1020;color:#d1fae5;font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap;' +
        'box-shadow:0 10px 30px rgba(0,0,0,.35)';
      box.textContent = `$ ${cmd}\n${out}`;
      document.body.append(box);
    },
    [command, output],
  );
  await page.waitForTimeout(hold);
  await page.evaluate(() => document.getElementById('demo-terminal')?.remove());
}

async function scenario(page: Page, kind: string, amount?: string) {
  await page.getByLabel('Comportamento').selectOption(kind);
  if (amount) await page.getByLabel('Valor (BRL)').last().fill(amount);
  const response = page.waitForResponse((r) => r.url().endsWith('/demo/scenarios'));
  await page.getByRole('button', { name: 'Executar cenário' }).click();
  const body = await (await response).json();
  await page
    .locator('#demo-results-state')
    .filter({ hasText: /Todas as operações|Algumas operações/ })
    .waitFor({ timeout: 20000 });
  return body as {
    transactions: { httpStatus: number; originalReceipt: { body: Record<string, unknown> } }[];
  };
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
  const body = {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
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
  };
  await sqs.send(
    new SendMessageCommand({
      QueueUrl,
      MessageBody: JSON.stringify(body),
      MessageGroupId: walletId,
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );
  const attributes = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['ApproximateNumberOfMessages'] }),
  );
  return { queueDepth: attributes.Attributes?.ApproximateNumberOfMessages, body };
}

await mkdir(outDir, { recursive: true });
const viewerToken = await apiToken();
const api = async (path: string, init?: RequestInit) =>
  (await (
    await fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${viewerToken}` } })
  ).json()) as any;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: outDir, size: { width: 1280, height: 800 } },
});
const page = await context.newPage();
try {
  await page.goto(base);
  await caption(
    page,
    'Jungle Gaming — processador de apostas. Stack local real: API, workers, PostgreSQL, SQS (LocalStack) e Keycloak.',
  );
  run.health = await sh('curl', '-fsS', `${base}/health/ready`);
  await terminal(page, `curl ${base}/health/ready`, String(run.health), pace);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.locator('#username').fill('demo-operator');
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
  await page.locator('#identity').filter({ hasText: 'demo-operator' }).waitFor();
  await caption(
    page,
    'Login via Keycloak (Authorization Code + PKCE) como demo-operator. Criando uma wallet fictícia com 100.00 BRL.',
  );

  const playerId = `video-${crypto.randomUUID().slice(0, 8)}`;
  await page.getByLabel('Jogador').fill(playerId);
  await page.getByLabel('Saldo inicial (BRL)').fill('100.00');
  await page.getByRole('button', { name: 'Criar wallet', exact: true }).click();
  await page.getByTestId('wallet-balance').filter({ hasText: '100.00' }).waitFor();
  const walletId = (await page.getByTestId('wallet-id').textContent())!.trim();
  run.wallet = { walletId, playerId, opening: '100.00' };

  await caption(
    page,
    '1) Disputa de saldo: duas BET de 80.00 enviadas ao mesmo tempo pelo endpoint real do provedor.',
  );
  const race = await scenario(page, 'race');
  run.race = race.transactions;
  await page.getByTestId('wallet-balance').filter({ hasText: '20.00' }).waitFor();
  await caption(
    page,
    'Uma PROCESSED (HTTP 200) e outra REJECTED com INSUFFICIENT_FUNDS (HTTP 422). Saldo final 20.00 e um único débito no ledger.',
    pace * 2,
  );

  await caption(
    page,
    '2) Replay idempotente: a mesma chave e o mesmo corpo enviados duas vezes em paralelo (BET 5.00).',
  );
  const duplicate = await scenario(page, 'duplicate', '5.00');
  run.duplicate = duplicate.transactions;
  await page.getByTestId('wallet-balance').filter({ hasText: '15.00' }).waitFor();
  await caption(
    page,
    'Mesmo transactionId; um recibo com idempotentReplay=true. Saldo 15.00: o débito aconteceu uma vez.',
    pace * 2,
  );

  await caption(
    page,
    '3) Falha + referência fora de ordem: derrubamos o reference-worker com SIGKILL no ambiente local.',
  );
  run.killReferenceWorker = await sh('docker', 'compose', 'kill', 'reference-worker');
  await terminal(
    page,
    'docker compose kill reference-worker',
    String(run.killReferenceWorker) || 'Container reference-worker Killed',
  );
  await caption(
    page,
    'REFUND de 5.00 chega antes da BET referenciada: aceite 202 PENDING_REFERENCE, sem mover saldo.',
  );
  const outOfOrder = await scenario(page, 'out-of-order', '5.00');
  run.outOfOrder = outOfOrder.transactions;
  const refund = outOfOrder.transactions.find((t) => t.httpStatus === 202)!;
  const refundId = String(refund.originalReceipt.body.transactionId);
  run.refundWhileWorkerDown = await api(`/wagering/transactions/${refundId}`);
  await caption(
    page,
    `Com o worker fora do ar o REFUND segue ${String((run.refundWhileWorkerDown as any).status)}: a agenda de retry está persistida no PostgreSQL, não na memória.`,
    pace * 1.5,
  );
  run.startReferenceWorker = await sh('docker', 'compose', 'start', 'reference-worker');
  await terminal(
    page,
    'docker compose start reference-worker',
    String(run.startReferenceWorker) || 'Container reference-worker Started',
  );
  const deadline = Date.now() + 60000;
  while (
    (await api(`/wagering/transactions/${refundId}`)).status === 'PENDING_REFERENCE' &&
    Date.now() < deadline
  )
    await Bun.sleep(500);
  run.refundAfterRestart = await api(`/wagering/transactions/${refundId}`);
  await page.getByRole('button', { name: `Detalhes da transação ${refundId}` }).click();
  await page.locator('#current-fields').getByText('PROCESSED').waitFor();
  await page.locator('#transaction-detail').scrollIntoViewIfNeeded();
  await caption(
    page,
    'Após o restart o worker conclui o REFUND. Recibo original (202 PENDING_REFERENCE) ao lado do estado atual (PROCESSED).',
    pace * 2.5,
  );

  await caption(
    page,
    '4) Falha do consumidor SQS: derrubamos o command-consumer e enviamos uma BET de 10.00 pela fila.',
  );
  run.killCommandConsumer = await sh('docker', 'compose', 'kill', 'command-consumer');
  const externalId = `sqs-${crypto.randomUUID().slice(0, 8)}`;
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
    `${String(run.killCommandConsumer) || 'Container command-consumer Killed'}\nmessageId=${first.body.messageId}\nApproximateNumberOfMessages=${first.queueDepth}`,
  );
  run.startCommandConsumer = await sh('docker', 'compose', 'start', 'command-consumer');
  let processed: any;
  for (const until = Date.now() + 60000; Date.now() < until; await Bun.sleep(500)) {
    const response = await fetch(
      `${base}/providers/provider-a/wagering/transactions/${externalId}`,
      {
        headers: { Authorization: `Bearer ${viewerToken}` },
      },
    );
    if (response.ok) {
      processed = await response.json();
      if (processed.status !== 'PENDING') break;
    }
  }
  run.sqsProcessed = processed;
  const afterFirst = await api(`/wallets/${walletId}`);
  await terminal(
    page,
    'docker compose start command-consumer',
    `${String(run.startCommandConsumer) || 'Container command-consumer Started'}\ntransação ${externalId}: ${processed?.status}\nsaldo ${afterFirst.balance.amount} · versão ${afterFirst.version}`,
  );
  await caption(
    page,
    'Reentrega com OUTRO messageId para a mesma operação: a inbox e a idempotência persistentes não repetem o débito.',
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
  const afterSecond = await api(`/wallets/${walletId}`);
  run.walletAfterSqs = { afterFirst, afterSecond };
  await terminal(
    page,
    'reenvio da mesma operação (delivery-2)',
    `saldo ${afterSecond.balance.amount} · versão ${afterSecond.version} (inalterados)`,
  );

  await page.getByLabel('ID da wallet').fill(walletId);
  await page.getByRole('button', { name: 'Consultar', exact: true }).click();
  await page
    .getByTestId('wallet-balance')
    .filter({ hasText: afterSecond.balance.amount })
    .waitFor();
  await caption(
    page,
    '5) Reconciliação final: saldo materializado comparado ao saldo reconstruído pelo ledger.',
  );
  const reconciliation = page.waitForResponse((r) => r.url().endsWith('/reconciliation'));
  await page.getByRole('button', { name: 'Reconciliar ledger' }).click();
  run.reconciliation = await (await reconciliation).json();
  await page.locator('#reconciliation').scrollIntoViewIfNeeded();
  await caption(
    page,
    `consistent=${(run.reconciliation as any).consistent}: registrado ${(run.reconciliation as any).storedBalance.amount} = reconstruído ${(run.reconciliation as any).calculatedBalance.amount}, ${(run.reconciliation as any).checkedEntries} lançamentos. Nada é corrigido silenciosamente.`,
    pace * 2.5,
  );
  await page
    .locator('#ledger-content')
    .scrollIntoViewIfNeeded()
    .catch(() => {});
  await caption(
    page,
    'Morte após commit e antes do ack, publishers concorrentes e outages isolados são provados pelo harness: bun run test:recovery.',
    pace * 2,
  );
} finally {
  run.finishedAt = new Date().toISOString();
  const video = page.video();
  await context.close();
  await browser.close();
  sqs.destroy();
  if (video) await rename(await video.path(), resolve(outDir, 'demo.webm'));
  await Bun.write(resolve(outDir, 'demo-run.json'), JSON.stringify(run, null, 2) + '\n');
  console.log(`Demo video and run data: ${outDir}`);
}
