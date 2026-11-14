// The contract between the three demo steps (voice -> record -> mix): file layout, shapes and the
// small process helpers they share. Importing this module has no side effects.
import { resolve } from 'node:path';

export interface VoiceClip {
  id: string;
  file: string;
  durationMs: number;
  caption: string;
}
export interface VoiceManifest {
  voice: string;
  rate: string;
  clips: VoiceClip[];
}
/** When a narration line started, measured from the start of the recording. */
export interface TimelineEntry {
  id: string;
  startMs: number;
  durationMs: number;
  caption: string;
}
/** A silent wait on the stack that the edit removes from the video. */
export interface Cut {
  startMs: number;
  endMs: number;
}

export function demoPaths(outDir: string) {
  const dir = resolve(outDir);
  return {
    dir,
    voiceDir: resolve(dir, 'voice'),
    manifest: resolve(dir, 'voice/manifest.json'),
    timeline: resolve(dir, 'timeline.json'),
    cuts: resolve(dir, 'cuts.json'),
    run: resolve(dir, 'demo-run.json'),
    webm: resolve(dir, 'demo.webm'),
    mp4: resolve(dir, 'demo.mp4'),
    srt: resolve(dir, 'demo.srt'),
  };
}

/** Runs a command and returns stdout + stderr; throws with stderr when it fails. */
export async function exec(...args: string[]) {
  const child = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${args.join(' ')} failed: ${err.trim()}`);
  return (out + err).trim();
}

/** Media duration in seconds, read with ffprobe. */
export async function probeDuration(file: string) {
  const out = await exec(
    'ffprobe',
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    file,
  );
  return Number(out);
}
