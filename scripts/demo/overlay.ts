// The production layer drawn over the real console while recording: a visible cursor, a terminal
// that types the real command and prints its real output, and the opening/closing cards.
// Nothing here talks to the API; the recorder (record-demo.ts) owns the script of the demo.
import type { Locator, Page } from 'playwright';

const CSS = `
#demo-cursor{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;opacity:0;
  transform:translate(var(--x,640px),var(--y,420px));transition:transform 650ms cubic-bezier(.16,1,.3,1),opacity 200ms}
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
.demo-card{position:fixed;inset:0;z-index:2147483645;display:grid;place-content:center;gap:22px;padding:96px;
  background:#24164f;color:#f3f0ff;font-family:Archivo,system-ui,sans-serif;transition:opacity 700ms ease-out}
.demo-card h1{margin:0;font-size:120px;font-stretch:72%;font-weight:750;letter-spacing:-.03em;line-height:1}
.demo-card p{margin:0;font-size:28px;color:#bdb4e6;max-width:28ch}
.demo-card .meta{margin-top:12px;max-width:none;font:16px/1.5 'JetBrains Mono',monospace}
.demo-card .kind{align-self:start;justify-self:start;padding:4px 10px;background:#ffd23f;color:#2e2200;
  font-size:15px;font-weight:800;font-stretch:70%;letter-spacing:.08em}
.demo-card ul{margin:8px 0 0;padding:0;list-style:none;display:grid;gap:10px;font:20px/1.4 'JetBrains Mono',monospace;color:#e0f3e8}
.demo-card li::before{content:'$ ';color:#ffd23f}
`;

/** Runs in every page of the recording context: installs the styles and the cursor element. */
function install(css: string) {
  const mount = () => {
    if (document.getElementById('demo-cursor')) return;
    const style = document.createElement('style');
    style.textContent = css;
    document.documentElement.append(style);
    const cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    cursor.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l15 8.5-6.5 1.6L8 18.5z" fill="#14121c" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    document.documentElement.append(cursor);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}

/**
 * The opening card, rendered as its own page so the recording starts on it with no flash. Load it
 * with `showTitleCard`, which keeps the console's origin so the self-hosted fonts are same-origin.
 */
const titleCardHtml = (consoleUrl: string) => `<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8"><link rel="stylesheet" href="${consoleUrl}/fonts.css"><style>${CSS}</style></head>
<body style="margin:0"><div class="demo-card">
<span class="kind">DESAFIO DE BACKEND · PROCESSADOR DE APOSTAS</span>
<h1>Lastro</h1>
<p>Cada garantia, provada com os dados da execução.</p>
<p class="meta">API · workers · PostgreSQL · SQS · Keycloak — stack local real</p>
</div></body></html>`;

export async function showTitleCard(page: Page, consoleUrl: string) {
  // Served by the recording browser itself under the console's origin, so fonts are same-origin.
  const url = `${consoleUrl}/__demo-title`;
  await page.route(url, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: titleCardHtml(consoleUrl) }),
  );
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.unroute(url);
}

export type Overlay = Awaited<ReturnType<typeof createOverlay>>;

export async function createOverlay(page: Page) {
  await page.context().addInitScript(install, CSS);
  let cursor = { x: 640, y: 420 };
  /** The cursor appears with the first real move, never on the title card. */
  let shown = false;

  /** Navigations rebuild the page; put the cursor back where it was without animating. */
  page.on('load', () => {
    void page
      .evaluate(
        ({ x, y, shown }) => {
          const el = document.getElementById('demo-cursor');
          el?.style.setProperty('transition', 'none');
          el?.style.setProperty('--x', `${x}px`);
          el?.style.setProperty('--y', `${y}px`);
          if (shown) el?.classList.add('on');
          requestAnimationFrame(() => el?.style.removeProperty('transition'));
        },
        { ...cursor, shown },
      )
      .catch(() => {});
  });

  async function moveTo(target: Locator) {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) return;
    cursor = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    shown = true;
    await page.evaluate(({ x, y }) => {
      const el = document.getElementById('demo-cursor');
      el?.classList.add('on');
      el?.style.setProperty('--x', `${x}px`);
      el?.style.setProperty('--y', `${y}px`);
    }, cursor);
    await page.waitForTimeout(700);
  }

  async function click(target: Locator) {
    await moveTo(target);
    await page.evaluate(() => {
      const el = document.getElementById('demo-cursor');
      el?.classList.remove('press');
      void el?.offsetWidth;
      el?.classList.add('press');
    });
    await page.waitForTimeout(160);
    await target.click();
  }

  async function type(target: Locator, text: string) {
    await click(target);
    await target.fill('');
    await target.pressSequentially(text, { delay: 55 });
  }

  async function reveal(target: Locator, block: 'start' | 'end' = 'start') {
    await target.evaluate((el, where) => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      const offset = where === 'start' ? 72 : innerHeight - el.clientHeight - 40;
      window.scrollTo({ top: Math.max(0, top - offset), behavior: 'smooth' });
    }, block);
    await page.waitForTimeout(900);
  }

  /** Types the command, then prints the real output it produced. */
  async function terminal(command: string, output: string, holdMs = 2600) {
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
      document.querySelector('#demo-terminal pre')?.append(`\n${out}`);
    }, output);
    await page.waitForTimeout(holdMs);
  }

  async function closeTerminal() {
    await page.evaluate(() => {
      const box = document.getElementById('demo-terminal');
      box?.classList.remove('on');
      setTimeout(() => box?.remove(), 300);
    });
  }

  async function outroCard() {
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

  return { moveTo, click, type, reveal, terminal, closeTerminal, outroCard };
}
