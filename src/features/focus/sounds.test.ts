import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('Carillon de fin de session (F-04 D4)', () => {
  const wav = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'assets', 'focus-end.wav'));

  it('est un fichier WAV PCM valide de moins de 3 secondes', () => {
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    const rate = wav.readUInt32LE(24);
    const channels = wav.readUInt16LE(22);
    const bits = wav.readUInt16LE(34);
    const dataBytes = wav.readUInt32LE(40);
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(dataBytes + 44).toBe(wav.length);
    const seconds = dataBytes / (rate * channels * (bits / 8));
    expect(seconds).toBeGreaterThan(0.5);
    expect(seconds).toBeLessThan(3);
  });

  it('reste léger (installeur PC < 15 Mo, PRD 8) et n’est ni silencieux ni saturé', () => {
    expect(wav.length).toBeLessThan(200_000);
    let peak = 0;
    for (let i = 44; i + 1 < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
    expect(peak).toBeGreaterThan(3000);
    expect(peak).toBeLessThan(32767);
  });
});
