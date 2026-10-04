// Génère le carillon de fin de session Focus (F-04 D4) : trois partiels d'une cloche (440, 880 et 1320 Hz) à décroissance
// exponentielle, 1,6 s, mono 16 bits, 22 050 Hz. Œuvre originale du projet, placée dans le domaine public (CC0) : aucun échantillon tiers.
// Usage : node scripts/generate-focus-chime.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 22_050;
const SECONDS = 1.6;
const samples = Math.floor(RATE * SECONDS);
const partials = [
  { hz: 523.25, gain: 0.5, decay: 3.2 },
  { hz: 1046.5, gain: 0.3, decay: 4.5 },
  { hz: 1568.0, gain: 0.15, decay: 6.5 },
];
const pcm = Buffer.alloc(samples * 2);
for (let i = 0; i < samples; i += 1) {
  const t = i / RATE;
  // Attaque douce de 8 ms, puis décroissance ; fondu final pour éviter un clic.
  const attack = Math.min(1, t / 0.008);
  const tail = Math.min(1, (SECONDS - t) / 0.05);
  let value = 0;
  for (const p of partials) value += p.gain * Math.exp(-p.decay * t) * Math.sin(2 * Math.PI * p.hz * t);
  // Seconde frappe à 0,45 s, une quinte plus haut, plus légère.
  if (t > 0.45) value += 0.45 * Math.exp(-3.6 * (t - 0.45)) * Math.sin(2 * Math.PI * 784 * (t - 0.45)) * Math.min(1, (t - 0.45) / 0.008);
  const sample = Math.max(-1, Math.min(1, value * attack * tail * 0.8));
  pcm.writeInt16LE(Math.round(sample * 32_767), i * 2);
}
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);
const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'features', 'focus', 'assets', 'focus-end.wav');
writeFileSync(target, Buffer.concat([header, pcm]));
console.log(`${target} : ${String(header.length + pcm.length)} octets, ${SECONDS} s`);
