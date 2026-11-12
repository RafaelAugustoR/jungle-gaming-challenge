import { mkdir, copyFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url).pathname;
await mkdir(`${root}frontend/dist`, { recursive: true });
const result = await Bun.build({
  entrypoints: [`${root}frontend/app.ts`],
  outdir: `${root}frontend/dist`,
  target: 'browser',
  minify: true,
});
if (!result.success) throw new AggregateError(result.logs, 'Frontend build failed');
await Promise.all(
  ['index.html', 'style.css'].map((file) =>
    copyFile(`${root}frontend/${file}`, `${root}frontend/dist/${file}`),
  ),
);
