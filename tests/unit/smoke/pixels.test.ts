import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng, fillRect, measureRegion, NEAR_BLACK_MAX, SAMPLE_STEP, solidImage, type RgbaImage } from '../../smoke/pixels';

/**
 * REL-TECH-01, critère 12 (ADR 0016) : preuve du détecteur d'écran noir, en Node et sans fenêtre. Une image noire est vue noire à 100 %,
 * une fenêtre noire sous une barre de titre claire est noire à 100 % dans sa zone cliente, le thème sombre de l'app (fond vers (26,21,48))
 * n'est jamais compté, et le décodeur PNG rend exactement les pixels encodés (filtres 0 à 4, RVB et RVBA).
 */
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set([...type].map((ch) => ch.charCodeAt(0)), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encodeur PNG de test : chaque ligne reçoit le filtre `filterOf(y)` (0 à 4), RVB (type 2) ou RVBA (type 6). */
function encodePng(image: RgbaImage, channels: 3 | 4, filterOf: (y: number) => number): Uint8Array {
  const stride = image.width * channels;
  const raw = new Uint8Array((stride + 1) * image.height);
  const line = (y: number, x: number, c: number): number => image.rgba[(y * image.width + x) * 4 + c] ?? 0;
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) for (let c = 0; c < channels; c += 1) cur[x * channels + c] = line(y, x, c);
    const filter = filterOf(y);
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? (cur[i - channels] ?? 0) : 0;
      const b = prev[i] ?? 0;
      const c = i >= channels ? (prev[i - channels] ?? 0) : 0;
      const x = cur[i] ?? 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      raw[y * (stride + 1) + 1 + i] = (x - predictor) & 0xff;
    }
    prev.set(cur);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, image.width);
  view.setUint32(4, image.height);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0))];
  return new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));
}

const BLACK: readonly [number, number, number] = [0, 0, 0];
const WHITE: readonly [number, number, number] = [255, 255, 255];
const APP_DARK: readonly [number, number, number] = [26, 21, 48];
const W = 1200;
const H = 800;
const WHOLE = { x: 0, y: 0, width: W, height: H };

describe('REL-TECH-01 : détecteur d’écran noir (pixels en Node)', () => {
  it('une image noire est noire à 100 %, d’une seule couleur', () => {
    const stats = measureRegion(solidImage(W, H, BLACK), WHOLE);
    expect(stats.sampled).toBe((W / SAMPLE_STEP) * (H / SAMPLE_STEP));
    expect(stats.nearBlack).toBe(stats.sampled);
    expect(stats.distinct).toBe(1);
  });

  it('une fenêtre noire sous une barre de titre claire : la fenêtre entière frôle le seuil, la zone cliente est noire à 100 %', () => {
    const image = solidImage(W, H, BLACK);
    fillRect(image, { x: 0, y: 0, width: W, height: 31 }, WHITE);
    const whole = measureRegion(image, WHOLE);
    expect(whole.nearBlack / whole.sampled).toBeGreaterThan(0.95);
    expect(whole.nearBlack).toBeLessThan(whole.sampled);
    const client = measureRegion(image, { x: 0, y: 31, width: W, height: H - 31 });
    expect(client.nearBlack).toBe(client.sampled);
    expect(client.distinct).toBe(1);
  });

  it('le thème sombre de l’app n’est jamais compté noir ; un contenu clair ajoute une couleur', () => {
    const image = solidImage(W, H, APP_DARK, (rgba) => {
      // Un titre blanc, comme l'écran du jour.
      for (let y = 100; y < 180; y += 1) for (let x = 100; x < 700; x += 1) rgba.set([255, 255, 255], (y * W + x) * 4);
    });
    const stats = measureRegion(image, WHOLE);
    expect(stats.nearBlack).toBe(0);
    expect(stats.distinct).toBeGreaterThanOrEqual(2);
    expect(Math.max(...APP_DARK)).toBeGreaterThanOrEqual(NEAR_BLACK_MAX);
  });

  it('la zone mesurée est bornée à l’image et décalée au cadre de la fenêtre', () => {
    const image = solidImage(200, 100, WHITE);
    fillRect(image, { x: 8, y: 31, width: 184, height: 61 }, BLACK);
    const client = measureRegion(image, { x: 8, y: 31, width: 184, height: 500 });
    expect(client.sampled).toBeGreaterThan(0);
    expect(client.nearBlack).toBe(client.sampled);
  });

  it.each([
    ['RVBA, filtres 0 à 4 en alternance', 4 as const, (y: number): number => y % 5],
    ['RVB, filtre Paeth partout', 3 as const, (): number => 4],
  ])('le décodeur PNG rend les pixels encodés (%s)', (_name, channels, filterOf) => {
    const image = solidImage(37, 23, APP_DARK, (rgba) => {
      for (let i = 0; i < 37 * 23; i += 1) rgba.set([(i * 7) & 0xff, (i * 13) & 0xff, (i * 29) & 0xff], i * 4);
    });
    const decoded = decodePng(encodePng(image, channels, filterOf));
    expect(decoded.width).toBe(37);
    expect(decoded.height).toBe(23);
    for (let i = 0; i < 37 * 23; i += 1) {
      expect([decoded.rgba[i * 4], decoded.rgba[i * 4 + 1], decoded.rgba[i * 4 + 2]]).toEqual([image.rgba[i * 4], image.rgba[i * 4 + 1], image.rgba[i * 4 + 2]]);
    }
  });

  it('le décodeur refuse ce qu’il ne sait pas lire, avec un message', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(/signature/);
    const image = solidImage(4, 4, BLACK);
    const png = encodePng(image, 4, () => 0);
    const interlaced = new Uint8Array(png);
    interlaced[8 + 8 + 12] = 1; // IHDR.interlace
    expect(() => decodePng(interlaced)).toThrow(/entrelacement|PNG/);
  });
});
