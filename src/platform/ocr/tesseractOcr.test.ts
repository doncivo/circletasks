import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createTesseractOcr, linesOfPage } from './tesseractOcr';

/**
 * Repli tesseract.js sur les images de test (tests/fixtures/ocr, Q-04 D7) : vrai moteur, vraies données `fra`, en Node. Le texte imprimé
 * doit être lu ; le manuscrit ne fait l'objet d'aucune exigence d'exactitude (seule la chaîne lignes -> tâches est testée ailleurs).
 */
const ROOT = resolve(import.meta.dirname, '../../..');
const fixture = (name: string): Blob => new Blob([new Uint8Array(readFileSync(resolve(ROOT, 'tests/fixtures/ocr', name)))]);
const expected = JSON.parse(readFileSync(resolve(ROOT, 'tests/fixtures/ocr/expected.json'), 'utf8')) as Record<string, { lines: string[]; readable: boolean }>;

const engine = createTesseractOcr({
  paths: {
    workerPath: resolve(ROOT, 'node_modules/tesseract.js/src/worker-script/node/index.js'),
    corePath: resolve(ROOT, 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js'),
    langPath: resolve(ROOT, 'node_modules/@tesseract.js-data/fra/4.0.0_best_int'),
  },
  toInput: async (image) => Buffer.from(await image.arrayBuffer()),
});

afterAll(() => engine.dispose());

const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

describe('repli tesseract.js (Q-04)', () => {
  it('status : disponible quand WebAssembly et les workers existent', async () => {
    expect(await engine.status()).toEqual({ available: true, languages: ['fra'] });
  });

  it('liste imprimée : une ligne reconnue par ligne écrite, avec une confiance de 0 à 100', async () => {
    const { lines } = await engine.recognize(fixture('liste-imprimee.png'), { lang: 'fra' });
    expect(lines.length).toBe(5);
    const wanted = (expected['liste-imprimee.png']?.lines ?? []).map(fold);
    const got = lines.map((line) => fold(line.text));
    const matches = wanted.filter((line) => got.includes(line));
    expect(matches.length, `lu : ${JSON.stringify(lines.map((l) => l.text))}`).toBeGreaterThanOrEqual(4);
    for (const line of lines) expect(line.confidence).toBeGreaterThan(0);
    for (const line of lines) expect(line.confidence).toBeLessThanOrEqual(100);
  }, 90_000);

  it('liste à puces, tirets et numéros : les lignes sont lues, les marques sont retirées plus tard par le front', async () => {
    const { lines } = await engine.recognize(fixture('liste-puces.png'), { lang: 'fra' });
    const text = fold(lines.map((line) => line.text).join(' '));
    for (const word of ['notaire', 'pain', 'facture', 'dentiste', 'loyer']) expect(text, word).toContain(word);
  }, 90_000);

  it('photo (JPEG, inclinée, fond dégradé) : le texte imprimé est lu', async () => {
    const { lines } = await engine.recognize(fixture('photo-liste.jpg'), { lang: 'fra' });
    const text = fold(lines.map((line) => line.text).join(' '));
    for (const word of ['plombier', 'ampoules', 'cantine', 'garage']) expect(text, word).toContain(word);
  }, 90_000);

  it('écriture script : une lecture est rendue, sans exigence d’exactitude', async () => {
    const { lines } = await engine.recognize(fixture('liste-manuscrite.png'), { lang: 'fra' });
    expect(Array.isArray(lines)).toBe(true);
  }, 90_000);

  it('page vide : aucune ligne', async () => {
    const { lines } = await engine.recognize(fixture('page-vide.png'), { lang: 'fra' });
    expect(lines).toEqual([]);
  }, 90_000);

  it('donnée illisible : OcrError « failed », le moteur reste utilisable', async () => {
    await expect(engine.recognize(new Blob([new Uint8Array([1, 2, 3])]), { lang: 'fra' })).rejects.toMatchObject({ name: 'OcrError', reason: 'failed' });
    const again = await engine.recognize(fixture('liste-imprimee.png'), { lang: 'fra' });
    expect(again.lines.length).toBeGreaterThan(0);
  }, 90_000);
});

describe('linesOfPage', () => {
  it('aplatit blocs, paragraphes et lignes, compacte les espaces et écarte les lignes vides', () => {
    const lines = linesOfPage({
      blocks: [
        { paragraphs: [{ lines: [{ text: '  Appeler   le notaire \n', confidence: 91.5 }, { text: ' ', confidence: 10 }] }] },
        { paragraphs: [{ lines: [{ text: 'Payer', confidence: 40 }] }] },
      ],
    });
    expect(lines).toEqual([
      { text: 'Appeler le notaire', confidence: 91.5 },
      { text: 'Payer', confidence: 40 },
    ]);
  });

  it('sans blocs, le texte brut est coupé par ligne, sans confiance', () => {
    expect(linesOfPage({ blocks: null, text: 'un\n\n deux \r\ntrois' })).toEqual([{ text: 'un' }, { text: 'deux' }, { text: 'trois' }]);
    expect(linesOfPage({})).toEqual([]);
  });
});
