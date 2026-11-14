// Synthesizes every narration line with edge-tts and writes <outDir>/voice/manifest.json.
// Usage: bun scripts/demo/voice.ts <outDir>   (EDGE_TTS=/path/to/edge-tts, DEMO_VOICE, DEMO_VOICE_RATE)
// The script text is the only thing sent to the speech service; no run data leaves the machine.
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { narration } from './narration';

export interface VoiceClip {
  id: string;
  file: string;
  durationMs: number;
  caption: string;
}

const outDir = resolve(process.argv[2] ?? 'artifacts/demo');
const voiceDir = resolve(outDir, 'voice');
const tts = process.env.EDGE_TTS ?? 'edge-tts';
const voice = process.env.DEMO_VOICE ?? 'pt-BR-AntonioNeural';
const rate = process.env.DEMO_VOICE_RATE ?? '-4%';

async function run(args: string[]) {
  const child = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${args[0]} failed: ${err.trim()}`);
  return out.trim();
}

await mkdir(voiceDir, { recursive: true });
const clips: VoiceClip[] = [];
for (const line of narration) {
  const file = resolve(voiceDir, `${line.id}.mp3`);
  for (let attempt = 1; ; attempt++) {
    try {
      await run([
        tts,
        '--voice',
        voice,
        `--rate=${rate}`,
        '--text',
        line.speech ?? line.caption,
        '--write-media',
        file,
      ]);
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      await Bun.sleep(1000 * attempt);
    }
  }
  const seconds = Number(
    await run([
      'ffprobe',
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      file,
    ]),
  );
  clips.push({ id: line.id, file, durationMs: Math.round(seconds * 1000), caption: line.caption });
  console.log(`${line.id}: ${seconds.toFixed(2)} s`);
}
await Bun.write(
  resolve(voiceDir, 'manifest.json'),
  JSON.stringify({ voice, rate, clips }, null, 2) + '\n',
);
const total = clips.reduce((sum, clip) => sum + clip.durationMs, 0) / 1000;
console.log(`${clips.length} clips, ${total.toFixed(1)} s of narration in ${voiceDir}`);
