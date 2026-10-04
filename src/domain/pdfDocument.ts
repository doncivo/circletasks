/**
 * PDF minimal (H-03 D3) : une page A4 portrait contenant une image JPEG (`DCTDecode`), sans bibliothèque. Le rapport du mois est dessiné
 * sur un canvas, encodé en JPEG, puis posé sur la page. Fonction pure : octets en entrée, octets en sortie.
 */

/** A4 en points PDF (1 pt = 1/72 pouce). */
export const A4_WIDTH_PT = 595;
export const A4_HEIGHT_PT = 842;
const MARGIN_PT = 28;

/**
 * Document d'une page A4 portrait avec l'image `jpeg` (largeur et hauteur en pixels) : réduite pour tenir dans les marges, centrée
 * horizontalement, collée en haut. Table des références (xref) calculée sur les décalages réels.
 */
export function buildPdfWithJpeg(jpeg: Uint8Array, imageWidth: number, imageHeight: number, title = 'CircleTasks'): Uint8Array {
  const encoder = new TextEncoder();
  const scale = Math.min((A4_WIDTH_PT - 2 * MARGIN_PT) / imageWidth, (A4_HEIGHT_PT - 2 * MARGIN_PT) / imageHeight);
  const width = Math.round(imageWidth * scale * 100) / 100;
  const height = Math.round(imageHeight * scale * 100) / 100;
  const x = Math.round(((A4_WIDTH_PT - width) / 2) * 100) / 100;
  const y = Math.round((A4_HEIGHT_PT - MARGIN_PT - height) * 100) / 100;
  const content = `q ${String(width)} 0 0 ${String(height)} ${String(x)} ${String(y)} cm /Im0 Do Q`;
  // Titre en ASCII (sans accents ni parenthèses) : les chaînes d'un PDF sont en PDFDocEncoding, pas en UTF-8.
  const safeTitle = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/[()\\]/g, '')
    .trim();

  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (part: Uint8Array): void => {
    chunks.push(part);
    length += part.length;
  };
  const text = (value: string): void => push(encoder.encode(value));
  const object = (number: number, body: () => void): void => {
    offsets[number] = length;
    text(`${String(number)} 0 obj\n`);
    body();
    text('\nendobj\n');
  };

  text('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // commentaire binaire : le fichier n'est pas du texte
  object(1, () => text('<< /Type /Catalog /Pages 2 0 R >>'));
  object(2, () => text('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
  object(3, () =>
    text(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(A4_WIDTH_PT)} ${String(A4_HEIGHT_PT)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`),
  );
  object(4, () => {
    text(`<< /Type /XObject /Subtype /Image /Width ${String(imageWidth)} /Height ${String(imageHeight)} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${String(jpeg.length)} >>\nstream\n`);
    push(jpeg);
    text('\nendstream');
  });
  object(5, () => text(`<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`));
  object(6, () => text(`<< /Title (${safeTitle}) /Producer (CircleTasks) >>`));

  const xrefAt = length;
  text(`xref\n0 7\n0000000000 65535 f \n`);
  for (let number = 1; number <= 6; number += 1) text(`${String(offsets[number] ?? 0).padStart(10, '0')} 00000 n \n`);
  text(`trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${String(xrefAt)}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) {
    out.set(chunk, position);
    position += chunk.length;
  }
  return out;
}
