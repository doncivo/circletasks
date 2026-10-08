import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openOcrService } from './index';
import { createNativeOcr, createWindowsOcr, OCR_RECOGNIZE_COMMAND, OCR_STATUS_COMMAND } from './nativeOcr';
import { OcrError } from './types';

let handler: (command: string, args?: unknown) => Promise<unknown> = () => Promise.resolve(undefined);
const calls: Array<[string, unknown]> = [];
const reply = (value: unknown): void => {
  handler = () => Promise.resolve(value);
};
const refuse = (error: unknown): void => {
  handler = () => Promise.reject(error);
};
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => {
    calls.push([command, args]);
    return handler(command, args);
  },
}));

const image = (): Blob => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });

/** Moteur natif derrière les commandes Rust : Windows (sans confiance) et Vision (confiance 0 à 100) — CAP-IOS-01 critères 1, 2 et 17. */
describe('nativeOcr', () => {
  beforeEach(() => {
    calls.length = 0;
    reply(undefined);
  });

  it('Vision : trois lignes avec leurs confiances (95, 40, 80) rendues telles quelles', async () => {
    reply({
      lines: [
        { text: 'plombier', confidence: 95 },
        { text: 'garage ?', confidence: 40 },
        { text: 'cantine', confidence: 80 },
      ],
    });
    const result = await createNativeOcr('vision').recognize(image(), { lang: 'fra' });
    expect(result.lines).toEqual([
      { text: 'plombier', confidence: 95 },
      { text: 'garage ?', confidence: 40 },
      { text: 'cantine', confidence: 80 },
    ]);
    expect(calls[0]?.[0]).toBe(OCR_RECOGNIZE_COMMAND);
    expect(calls[0]?.[1]).toBeInstanceOf(Uint8Array);
  });

  it('Windows : aucune confiance dans les lignes (champ absent)', async () => {
    reply({ lines: [{ text: 'a' }] });
    expect((await createWindowsOcr().recognize(image(), { lang: 'fra' })).lines).toEqual([{ text: 'a' }]);
  });

  it('état : la raison de Rust est transmise', async () => {
    reply({ available: false, languages: ['en-US'], reason: 'language-missing' });
    expect(await createNativeOcr('vision').status()).toEqual({ available: false, languages: ['en-US'], reason: 'language-missing' });
    expect(calls[0]).toEqual([OCR_STATUS_COMMAND, undefined]);
    reply({ available: true, languages: ['fr-FR'] });
    expect(await createNativeOcr('vision').status()).toEqual({ available: true, languages: ['fr-FR'] });
  });

  it('commande absente ou refusée : Vision est dit indisponible AVEC sa raison, Windows comme avant', async () => {
    refuse('not allowed');
    expect(await createNativeOcr('vision').status()).toEqual({ available: false, languages: [], reason: 'plugin-unavailable' });
    expect(await createNativeOcr('windows').status()).toEqual({ available: false, languages: [] });
  });

  it('erreurs de Rust : raison et code gardés, jamais le message', async () => {
    const cases: Array<[string, string]> = [
      ['ocr-unavailable', 'unavailable'],
      ['ocr-engine', 'failed'],
      ['ocr-dimensions-too-large', 'dimensions'],
      ['ocr-language-missing', 'language-missing'],
      ['ocr-unsupported-format', 'unsupported-format'],
    ];
    for (const [code, reason] of cases) {
      refuse({ code, message: 'Engine("texte reconnu secret")' });
      const error = await createNativeOcr('vision')
        .recognize(image(), { lang: 'fra' })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OcrError);
      expect(error).toMatchObject({ reason, code });
      expect(String((error as Error).message)).not.toContain('secret');
    }
  });
});

describe('openOcrService : moteurs de l’appareil', () => {
  it('(tauri, ios) : primary = Vision, fallback = tesseract.js', () => {
    const service = openOcrService('tauri', 'ios');
    expect(service.primary?.id).toBe('vision');
    expect(service.fallback?.id).toBe('tesseract');
  });

  it('(tauri, windows) : primary = Windows, inchangé', () => {
    expect(openOcrService('tauri', 'windows').primary?.id).toBe('windows');
  });

  it('navigateur : pas de moteur natif, repli seul', () => {
    for (const os of ['ios', 'windows', 'other'] as const) {
      const service = openOcrService('web', os);
      expect(service.primary).toBeNull();
      expect(service.fallback?.id).toBe('tesseract');
    }
  });
});
