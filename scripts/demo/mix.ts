// Mixes the narration clips onto the recorded video, removes silent waits, and ships the subtitles
// as a soft pt-BR track (nothing is burned into the picture).
// Usage: bun scripts/demo/mix.ts <outDir>   -> demo.mp4 (H.264 + AAC + subtitles) and demo.srt
import {
  demoPaths,
  exec,
  probeDuration,
  type Cut,
  type TimelineEntry,
  type VoiceManifest,
} from './artifacts';

const paths = demoPaths(process.argv[2] ?? 'artifacts/demo');
const { clips } = (await Bun.file(paths.manifest).json()) as VoiceManifest;
const timeline = (await Bun.file(paths.timeline).json()) as TimelineEntry[];
const cutsFile = Bun.file(paths.cuts);
const cuts = ((await cutsFile.exists()) ? await cutsFile.json() : []) as Cut[];
const byId = new Map(clips.map((clip) => [clip.id, clip]));
// Playwright starts the video slightly before the page reports ready; DEMO_AV_OFFSET_MS nudges the voice.
const offset = Number(process.env.DEMO_AV_OFFSET_MS ?? 0);

const cutLength = (cut: Cut) => cut.endMs - cut.startMs;
/** Moves a recording timestamp onto the edited timeline (silent waits removed). */
const edited = (ms: number) =>
  ms - cuts.filter((cut) => cut.endMs <= ms).reduce((sum, cut) => sum + cutLength(cut), 0) + offset;
const removedSeconds = cuts.reduce((sum, cut) => sum + cutLength(cut), 0) / 1000;
const duration = (await probeDuration(paths.video)) - removedSeconds;

const srtTime = (ms: number) => {
  const total = Math.max(0, Math.round(ms));
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(total % 1000, 3)}`;
};
await Bun.write(
  paths.srt,
  timeline
    .map((entry, index) => {
      const start = edited(entry.startMs);
      return `${index + 1}\n${srtTime(start)} --> ${srtTime(start + entry.durationMs)}\n${entry.caption}\n`;
    })
    .join('\n'),
);

const voiceInputs = timeline.flatMap((entry) => {
  const clip = byId.get(entry.id);
  if (!clip) throw new Error(`No voice clip for ${entry.id}`);
  return ['-i', clip.file];
});
const delays = timeline.map((entry, index) => {
  const ms = Math.max(0, Math.round(edited(entry.startMs)));
  return `[${index + 1}:a]adelay=${ms}|${ms}[a${index}]`;
});
const voice =
  `${timeline.map((_, index) => `[a${index}]`).join('')}` +
  `amix=inputs=${timeline.length}:normalize=0:dropout_transition=0,` +
  'highpass=f=70,acompressor=threshold=-20dB:ratio=3:attack=5:release=120,' +
  'loudnorm=I=-16:TP=-1.5:LRA=9,apad[voice]';
const keep = cuts.length
  ? `select='not(${cuts.map((cut) => `between(t,${(cut.startMs / 1000).toFixed(3)},${(cut.endMs / 1000).toFixed(3)})`).join('+')})',setpts=N/30/TB,`
  : '';
const video = `[0:v]fps=30,${keep}format=yuv420p,fade=t=in:st=0:d=0.6,fade=t=out:st=${Math.max(0, duration - 1.2).toFixed(2)}:d=1.2[video]`;

await exec(
  'ffmpeg',
  '-y',
  '-v',
  'error',
  '-i',
  paths.video,
  ...voiceInputs,
  '-i',
  paths.srt,
  '-filter_complex',
  [...delays, voice, video].join(';'),
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
  paths.mp4,
);
console.log(
  `demo.mp4 (${duration.toFixed(1)} s, ${removedSeconds.toFixed(1)} s of idle waits cut) and demo.srt in ${paths.dir}`,
);
