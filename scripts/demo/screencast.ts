// Records a page at its device resolution through the Chrome DevTools screencast. Playwright's own
// recordVideo captures in CSS pixels and pads the rest of a larger frame, so a 1.5x page recorded at
// 1920×1200 came out as a 1280×800 picture in a grey frame. Here every frame arrives at device
// pixels with its timestamp, and ffmpeg turns the variable-rate frames into a constant 30 fps video.
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Page } from 'playwright';
import { exec } from './artifacts';

interface Frame {
  file: string;
  /** Seconds since the epoch, as reported by Chrome. */
  at: number;
}

export async function startScreencast(
  page: Page,
  dir: string,
  size: { width: number; height: number },
) {
  const frameDir = resolve(dir, 'frames');
  await rm(frameDir, { recursive: true, force: true });
  await mkdir(frameDir, { recursive: true });
  const session = await page.context().newCDPSession(page);
  const frames: Frame[] = [];
  const writes: Promise<unknown>[] = [];
  session.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = resolve(frameDir, `${String(frames.length).padStart(6, '0')}.jpg`);
    frames.push({ file, at: metadata.timestamp ?? Date.now() / 1000 });
    writes.push(Bun.write(file, Buffer.from(data, 'base64')));
    void session.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  const startedAt = Date.now();
  await session.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 95,
    maxWidth: size.width,
    maxHeight: size.height,
    everyNthFrame: 1,
  });

  /** Stops capturing and encodes the frames to `output`; the video starts at `startedAt`. */
  async function stop(output: string) {
    await session.send('Page.stopScreencast').catch(() => {});
    const stoppedAt = Date.now() / 1000;
    await Promise.all(writes);
    if (!frames.length) throw new Error('The screencast produced no frames');
    // Each frame lasts until the next one; the first one also covers the gap since startedAt.
    const lines = frames.flatMap((frame, index) => {
      const next = frames[index + 1]?.at ?? stoppedAt;
      const lead = index === 0 ? Math.max(0, frame.at - startedAt / 1000) : 0;
      return [
        `file '${frame.file}'`,
        `duration ${Math.max(0.001, next - frame.at + lead).toFixed(4)}`,
      ];
    });
    lines.push(`file '${frames.at(-1)!.file}'`);
    const list = resolve(frameDir, 'frames.txt');
    await Bun.write(list, lines.join('\n') + '\n');
    await exec(
      'ffmpeg',
      '-y',
      '-v',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-vf',
      `fps=30,scale=${size.width}:${size.height}:flags=lanczos,format=yuv420p`,
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '12',
      output,
    );
    await rm(frameDir, { recursive: true, force: true });
    return { frames: frames.length };
  }

  return { startedAt, stop };
}
