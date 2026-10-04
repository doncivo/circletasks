import { describe, expect, it } from 'vitest';
import { checkImageFile, fitWithin, MAX_IMAGE_BYTES, MAX_IMAGE_SIDE } from './prepareImage';

describe('image à lire (Q-04 critère 2)', () => {
  it.each([
    [{ type: 'image/jpeg', size: 200_000 }, null],
    [{ type: 'image/png', size: 2_000_000 }, null],
    [{ type: 'image/webp', size: 500_000 }, null],
    [{ type: 'IMAGE/JPEG', size: 1 }, null],
    [{ type: 'image/png', size: MAX_IMAGE_BYTES }, null],
    [{ type: 'image/png', size: MAX_IMAGE_BYTES + 1 }, 'too-large'],
    [{ type: 'image/heic', size: 1_000 }, 'heic'],
    [{ type: 'image/heif', size: 1_000 }, 'heic'],
    [{ type: '', size: 1_000, name: 'IMG_0001.HEIC' }, 'heic'],
    [{ type: 'application/octet-stream', size: 1_000, name: 'photo.heif' }, 'heic'],
    [{ type: 'image/gif', size: 1_000 }, 'unsupported'],
    [{ type: 'application/pdf', size: 1_000 }, 'unsupported'],
    [{ type: 'text/plain', size: 10 }, 'unsupported'],
    [{ type: '', size: 10 }, 'unsupported'],
  ])('%j : %s', (file, expected) => {
    expect(checkImageFile(file)).toBe(expected);
  });

  it('une image HEIC trop lourde est refusée comme HEIC (message le plus utile)', () => {
    expect(checkImageFile({ type: 'image/heic', size: MAX_IMAGE_BYTES * 2 })).toBe('heic');
  });
});

describe('réduction à 2 000 px (critère 3)', () => {
  it('une image plus grande est réduite au plus grand côté, proportions gardées', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 2000, height: 1500 });
    expect(fitWithin(3000, 4000)).toEqual({ width: 1500, height: 2000 });
    expect(fitWithin(8000, 100)).toEqual({ width: 2000, height: 25 });
  });

  it('une image assez petite n’est jamais agrandie', () => {
    expect(fitWithin(1200, 800)).toEqual({ width: 1200, height: 800 });
    expect(fitWithin(MAX_IMAGE_SIDE, MAX_IMAGE_SIDE)).toEqual({ width: 2000, height: 2000 });
  });

  it('la vignette utilise la même règle avec une autre limite', () => {
    expect(fitWithin(2000, 1500, 320)).toEqual({ width: 320, height: 240 });
  });

  it('jamais de dimension nulle', () => {
    expect(fitWithin(10_000, 1)).toEqual({ width: 2000, height: 1 });
  });
});

describe('Q-04 rotation et très grande image (QA)', () => {
  it('le décodeur applique l’orientation EXIF (jamais imageOrientation: none) et la dimension rendue suit l’image tournée', async () => {
    const { vi } = await import('vitest');
    const { prepareImage } = await import('./prepareImage');
    const close = vi.fn();
    const decode = vi.fn(() => Promise.resolve({ width: 4000, height: 3000, close }));
    vi.stubGlobal('createImageBitmap', decode);
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) });
    try {
      const result = await prepareImage(new Blob([new Uint8Array(10)], { type: 'image/jpeg' }));
      const options = (decode.mock.calls[0] as unknown[])[1] as { imageOrientation?: string } | undefined;
      expect(options?.imageOrientation).not.toBe('none');
      expect(result.width).toBeGreaterThan(0);
      expect(close).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('une image illisible est refusée et libère tout', async () => {
    const { vi } = await import('vitest');
    const { prepareImage } = await import('./prepareImage');
    vi.stubGlobal('createImageBitmap', () => Promise.reject(new Error('bad')));
    try {
      await expect(prepareImage(new Blob(['x'], { type: 'image/png' }))).rejects.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([[8000, 6000], [6000, 8000], [30000, 100]])('très grande image %i x %i : plus grand côté ramené à la limite', (w, h) => {
    const r = fitWithin(w, h);
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(MAX_IMAGE_SIDE);
    expect(Math.min(r.width, r.height)).toBeGreaterThanOrEqual(1);
  });
});
