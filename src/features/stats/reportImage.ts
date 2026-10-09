import { buildPdfWithJpeg } from '../../domain/pdfDocument';
import type { ReportLayout, ReportOp } from '../../domain/reportLayout';
import { REPORT_FONT_FACES, REPORT_FONT_SAMPLE } from './reportFonts';
import { REPORT_PALETTE } from './reportPalette';

/** Largeur de l'image PNG (H-03 critère 6) ; le PDF utilise la même image, réduite à la page. */
export const REPORT_IMAGE_WIDTH_PX = 1080;

const FAMILY = { title: '"Fraunces Variable", Georgia, serif', text: '"DM Sans Variable", system-ui, sans-serif' } as const;

/** Charge les polices embarquées avant de dessiner (sinon le canvas utiliserait la police de repli). */
async function loadFonts(): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return;
  await Promise.all(REPORT_FONT_FACES.map((face) => document.fonts.load(face, REPORT_FONT_SAMPLE))).catch(() => undefined);
}

function shorten(context: CanvasRenderingContext2D, text: string, maxWidth: number | undefined): string {
  if (maxWidth === undefined || context.measureText(text).width <= maxWidth) return text;
  let end = text.length;
  while (end > 1 && context.measureText(`${text.slice(0, end)}…`).width > maxWidth) end -= 1;
  return `${text.slice(0, end)}…`;
}

function roundedPath(context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, top: number, bottom: number): void {
  context.beginPath();
  context.moveTo(x + top, y);
  context.lineTo(x + w - top, y);
  context.arcTo(x + w, y, x + w, y + top, top);
  context.lineTo(x + w, y + h - bottom);
  context.arcTo(x + w, y + h, x + w - bottom, y + h, bottom);
  context.lineTo(x + bottom, y + h);
  context.arcTo(x, y + h, x, y + h - bottom, bottom);
  context.lineTo(x, y + top);
  context.arcTo(x, y, x + top, y, top);
  context.closePath();
}

function drawOp(context: CanvasRenderingContext2D, op: ReportOp): void {
  if (op.kind === 'rect') {
    const top = Math.min(op.radius ?? op.topRadius ?? 0, op.w / 2, op.h);
    const bottom = Math.min(op.radius ?? 0, op.w / 2, op.h);
    roundedPath(context, op.x, op.y, op.w, op.h, top, bottom);
    if (op.fill) {
      context.fillStyle = REPORT_PALETTE[op.fill];
      context.fill();
    }
    if (op.stroke) {
      context.strokeStyle = REPORT_PALETTE[op.stroke];
      context.lineWidth = 1.5;
      context.setLineDash(op.dashed ? [3, 3] : []);
      context.stroke();
      context.setLineDash([]);
    }
    return;
  }
  context.font = `${String(op.weight)} ${String(op.size)}px ${FAMILY[op.font]}`;
  context.fillStyle = REPORT_PALETTE[op.color];
  context.textBaseline = 'alphabetic';
  if ('letterSpacing' in context) (context as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${String(op.letterSpacing ?? 0)}px`;
  const text = shorten(context, op.text, op.maxWidth);
  context.textAlign = op.align;
  context.fillText(text, op.x, op.y);
  if (op.suffix) {
    const width = context.measureText(text).width;
    context.font = `600 16px ${FAMILY.text}`;
    context.fillStyle = REPORT_PALETTE.secondary;
    context.textAlign = 'left';
    context.fillText(op.suffix, op.x + width + 6, op.y);
  }
}

/** Dessine la mise en page sur un canvas de `widthPx` de large (polices embarquées chargées d'abord). */
export async function renderReportCanvas(layout: ReportLayout, widthPx = REPORT_IMAGE_WIDTH_PX): Promise<HTMLCanvasElement> {
  await loadFonts();
  const scale = widthPx / layout.width;
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = Math.ceil(layout.height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas 2D indisponible');
  context.scale(scale, scale);
  for (const op of layout.ops) drawOp(context, op);
  return canvas;
}

function toBytes(canvas: HTMLCanvasElement, type: 'image/png' | 'image/jpeg'): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('encodage de l’image impossible'));
          return;
        }
        blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
      },
      type,
      0.92,
    );
  });
}

/** PNG de 1 080 px de large (H-03 critère 6). */
export async function renderReportPng(layout: ReportLayout): Promise<Uint8Array> {
  return toBytes(await renderReportCanvas(layout), 'image/png');
}

/** PDF A4 portrait d'une page (H-03 critère 5) : le rendu du rapport encodé en JPEG puis posé sur la page. */
export async function renderReportPdf(layout: ReportLayout, title: string): Promise<Uint8Array> {
  const canvas = await renderReportCanvas(layout);
  return buildPdfWithJpeg(await toBytes(canvas, 'image/jpeg'), canvas.width, canvas.height, title);
}
