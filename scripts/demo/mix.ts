// Mixes the narration clips onto the recorded video and burns nothing: subtitles ship as a soft track.
// Usage: bun scripts/demo/mix.ts <outDir>   -> demo.mp4 (H.264 + AAC + pt-BR subtitles) and demo.srt
import { resolve } from 'node:path';
import type { TimelineEntry } from '../record-demo';
import type { VoiceClip } from './voice';

const outDir = resolve(process.argv[2] ?? 'artifacts/demo');
const { clips } = (await Bun.file(resolve(outDir, 'voice/manifest.json')).json()) as {
  clips: VoiceClip[];
};
const timeline = (await Bun.file(resolve(outDir, 'timeline.json')).json()) as TimelineEntry[];
const byId = new Map(clips.map((clip) => [clip.id, clip]));
const cutsFile = Bun.file(resolve(outDir, 'cuts.json'));
const cuts = ((await cutsFile.exists()) ? await cutsFile.json() : []) as {
  startMs: number;
  endMs: number;
}[];
/** Moves a recording timestamp onto the edited timeline (dead waits removed). */
const edited = (ms: number) =>
  ms - cuts.filter((cut) => cut.endMs <= ms).reduce((sum, cut) => sum + cut.endMs - cut.startMs, 0);
const removedSeconds = cuts.reduce((sum, cut) => sum + cut.endMs - cut.startMs, 0) / 1000;
// Playwright starts the video slightly before the page reports ready; DEMO_AV_OFFSET_MS nudges the voice.
const offset = Number(process.env.DEMO_AV_OFFSET_MS ?? 0);

const stamp = (ms: number) => {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(total % 1000, 3)}`;
};
const srt = timeline
  .map((entry, index) => {
    const start = edited(entry.startMs) + offset;
    return `${index + 1}\n${stamp(start)} --> ${stamp(start + entry.durationMs)}\n${entry.caption}\n`;
  })
  .join('\n');
await Bun.write(resolve(outDir, 'demo.srt'), srt);

const video = resolve(outDir, 'demo.webm');
const probe = Bun.spawnSync([
  'ffprobe',
  '-v',
  'error',
  '-show_entries',
  'format=duration',
  '-of',
  'csv=p=0',
  video,
]);
const duration = Number(new TextDecoder().decode(probe.stdout).trim()) - removedSeconds;
const inputs = ['-i', video];
const delays: string[] = [];
timeline.forEach((entry, index) => {
  const clip = byId.get(entry.id);
  if (!clip) throw new Error(`No voice clip for ${entry.id}`);
  inputs.push('-i', clip.file);
  const ms = Math.max(0, edited(entry.startMs) + offset);
  delays.push(`[${index + 1}:a]adelay=${ms}|${ms}[a${index}]`);
});
const mix = `${timeline.map((_, i) => `[a${i}]`).join('')}amix=inputs=${timeline.length}:normalize=0:dropout_transition=0,`;
const filter = [
  ...delays,
  `${mix}highpass=f=70,acompressor=threshold=-20dB:ratio=3:attack=5:release=120,loudnorm=I=-16:TP=-1.5:LRA=9,apad[voice]`,
  `[0:v]fps=30,${
    cuts.length
      ? `select='not(${cuts.map((cut) => `between(t,${(cut.startMs / 1000).toFixed(3)},${(cut.endMs / 1000).toFixed(3)})`).join('+')})',setpts=N/30/TB,`
      : ''
  }format=yuv420p,fade=t=in:st=0:d=0.6,fade=t=out:st=${Math.max(0, duration - 1.2).toFixed(2)}:d=1.2[video]`,
].join(';');
const args = [
  'ffmpeg',
  '-y',
  '-v',
  'error',
  ...inputs,
  '-i',
  resolve(outDir, 'demo.srt'),
  '-filter_complex',
  filter,
  '-map',
  '[video]',
  '-map',
  '[voice]',
  '-map',
  `${timeline.length + 1}:s`,
  '-c:v',
  'libx264',
  '-preset',
  'slow',
  '-crf',
  '20',
  '-profile:v',
  'high',
  '-movflags',
  '+faststart',
  '-c:a',
  'aac',
  '-b:a',
  '192k',
  '-ar',
  '48000',
  '-c:s',
  'mov_text',
  '-metadata:s:s:0',
  'language=por',
  '-metadata:s:a:0',
  'language=por',
  '-t',
  duration.toFixed(2),
  resolve(outDir, 'demo.mp4'),
];
const child = Bun.spawnSync(args, { stderr: 'pipe' });
if (child.exitCode !== 0) throw new Error(new TextDecoder().decode(child.stderr));
console.log(
  `demo.mp4 (${duration.toFixed(1)} s, ${removedSeconds.toFixed(1)} s of idle waits cut) and demo.srt in ${outDir}`,
);
