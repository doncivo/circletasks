import { describe, expect, it } from 'vitest';
import { A4_HEIGHT_PT, A4_WIDTH_PT, buildPdfWithJpeg } from './pdfDocument';

const latin1 = (bytes: Uint8Array): string => Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 0xff, 0xd9]);

describe('PDF minimal (H-03 critère 5, D3)', () => {
  const pdf = buildPdfWithJpeg(JPEG, 1080, 700);
  const text = latin1(pdf);

  it('une page A4 portrait avec l’image JPEG en DCTDecode', () => {
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain(`/MediaBox [0 0 ${String(A4_WIDTH_PT)} ${String(A4_HEIGHT_PT)}]`);
    expect(text).toContain('/Count 1');
    expect(text).toContain('/Filter /DCTDecode');
    expect(text).toContain('/Width 1080 /Height 700');
  });

  it('les octets du JPEG sont intacts', () => {
    const start = text.indexOf('stream\n', text.indexOf('/DCTDecode')) + 'stream\n'.length;
    expect(Array.from(pdf.slice(start, start + JPEG.length))).toEqual(Array.from(JPEG));
    expect(text).toContain(`/Length ${String(JPEG.length)}`);
  });

  it('la table xref pointe sur le début de chaque objet et startxref sur « xref »', () => {
    const startxref = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
    const entries = [...text.slice(startxref).matchAll(/(\d{10}) 00000 n /g)].map((match) => Number(match[1]));
    expect(entries).toHaveLength(6);
    entries.forEach((offset, index) => expect(text.slice(offset, offset + `${String(index + 1)} 0 obj`.length)).toBe(`${String(index + 1)} 0 obj`));
  });

  it('l’image tient dans les marges et reste dans la page, même très haute', () => {
    const tall = latin1(buildPdfWithJpeg(JPEG, 500, 3000));
    const [, w, h, x, y] = /q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm/.exec(tall)?.map(Number) ?? [];
    expect(h).toBeLessThanOrEqual(A4_HEIGHT_PT - 56 + 0.01);
    expect((x ?? 0) + (w ?? 0)).toBeLessThanOrEqual(A4_WIDTH_PT);
    expect(y).toBeGreaterThanOrEqual(0);
  });
});
