// Synthesizes every narration line with edge-tts and writes <outDir>/voice/manifest.json.
// Usage: bun scripts/demo/voice.ts <outDir>   (EDGE_TTS=/path/to/edge-tts, DEMO_VOICE, DEMO_VOICE_RATE)
// The script text is the only thing sent to the speech service; no run data leaves the machine.
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { demoPaths, exec, probeDuration, type VoiceClip, type VoiceManifest } from './artifacts';
import { narration } from './narration';

const paths = demoPaths(process.argv[2] ?? 'artifacts/demo');
const tts = process.env.EDGE_TTS ?? 'edge-tts';
const voice = process.env.DEMO_VOICE ?? 'pt-BR-AntonioNeural';
const rate = process.env.DEMO_VOICE_RATE ?? '-4%';

await mkdir(paths.voiceDir, { recursive: true });
const clips: VoiceClip[] = [];
for (const line of narration) {
  const file = resolve(paths.voiceDir, `${line.id}.mp3`);
  const text = line.speech ?? line.caption;
  for (let attempt = 1; ; attempt++) {
    try {
      await exec(tts, '--voice', voice, `--rate=${rate}`, '--text', text, '--write-media', file);
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      await Bun.sleep(1000 * attempt);
    }
  }
  const seconds = await probeDuration(file);
  clips.push({ id: line.id, file, durationMs: Math.round(seconds * 1000), caption: line.caption });
  console.log(`${line.id}: ${seconds.toFixed(2)} s`);
}
const manifest: VoiceManifest = { voice, rate, clips };
await Bun.write(paths.manifest, JSON.stringify(manifest, null, 2) + '\n');
const total = clips.reduce((sum, clip) => sum + clip.durationMs, 0) / 1000;
console.log(`${clips.length} clips, ${total.toFixed(1)} s of narration in ${paths.voiceDir}`);
