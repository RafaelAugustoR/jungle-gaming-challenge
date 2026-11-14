import { cp, copyFile, mkdir, rm } from 'node:fs/promises';
const root = new URL('../', import.meta.url).pathname;
const out = `${root}frontend/dist`;
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const result = await Bun.build({
  entrypoints: [`${root}frontend/src/main.tsx`],
  outdir: out,
  naming: 'app.js',
  target: 'browser',
  minify: true,
});
if (!result.success) throw new AggregateError(result.logs, 'Frontend build failed');
await Promise.all([
  ...['index.html', 'style.css', 'favicon.svg'].map((file) =>
    copyFile(`${root}frontend/${file}`, `${out}/${file}`),
  ),
  cp(`${root}frontend/fonts`, `${out}/fonts`, { recursive: true }),
]);
