import { inflateSync } from 'node:zlib';

/**
 * REL-TECH-01 (ADR 0016) : mesure des pixels d'une capture de fenêtre, en Node (jamais en PowerShell : ses boucles et son démarrage à froid
 * sur un runner chargé ont dépassé 60 s puis 120 s le 2026-10-15). Décodeur PNG minimal (ce que `System.Drawing` enregistre : 8 bits par
 * canal, RVB ou RVBA, non entrelacé) et échantillonnage tous les 16 px d'une zone : `nearBlack` = max(R,V,B) < 12 (le fond sombre de
 * l'app, vers (26,21,48), n'est jamais compté), `distinct` = couleurs distinctes quantifiées à 4 bits par canal.
 */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** 4 octets par pixel, lignes du haut vers le bas. */
  readonly rgba: Uint8Array;
}

export interface PixelStats {
  readonly sampled: number;
  readonly nearBlack: number;
  readonly distinct: number;
}

export interface Region {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Pas de l'échantillonnage (px) et seuil du quasi-noir (valeur maximale des trois canaux). */
export const SAMPLE_STEP = 16;
export const NEAR_BLACK_MAX = 12;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Décode un PNG 8 bits RVB (type 2) ou RVBA (type 6), non entrelacé ; rejette tout autre format avec un message. */
export function decodePng(file: Uint8Array): RgbaImage {
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (file[i] !== PNG_SIGNATURE[i]) throw new Error('PNG : signature absente');
  }
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Uint8Array[] = [];
  while (offset + 8 <= file.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(file[offset + 4] ?? 0, file[offset + 5] ?? 0, file[offset + 6] ?? 0, file[offset + 7] ?? 0);
    const dataStart = offset + 8;
    if (type === 'IHDR') {
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      const bitDepth = file[dataStart + 8];
      colorType = file[dataStart + 9] ?? -1;
      const interlace = file[dataStart + 12];
      if (bitDepth !== 8) throw new Error(`PNG : profondeur ${String(bitDepth)} non prise en charge (8 attendu)`);
      if (colorType !== 2 && colorType !== 6) throw new Error(`PNG : type de couleur ${String(colorType)} non pris en charge (2 ou 6 attendu)`);
      if (interlace !== 0) throw new Error('PNG : entrelacement non pris en charge');
    } else if (type === 'IDAT') {
      idat.push(file.subarray(dataStart, dataStart + length));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStart + length + 4;
  }
  if (width === 0 || height === 0 || colorType < 0) throw new Error('PNG : en-tête IHDR absent');
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat.map((part) => Buffer.from(part))));
  const stride = width * channels;
  if (raw.length !== (stride + 1) * height) throw new Error(`PNG : ${String(raw.length)} octets décompressés au lieu de ${String((stride + 1) * height)}`);
  const rgba = new Uint8Array(width * height * 4);
  const previous = new Uint8Array(stride);
  const current = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i += 1) {
      const x = line[i] ?? 0;
      const a = i >= channels ? (current[i - channels] ?? 0) : 0;
      const b = previous[i] ?? 0;
      const c = i >= channels ? (previous[i - channels] ?? 0) : 0;
      let value: number;
      if (filter === 0) value = x;
      else if (filter === 1) value = x + a;
      else if (filter === 2) value = x + b;
      else if (filter === 3) value = x + Math.floor((a + b) / 2);
      else if (filter === 4) value = x + paeth(a, b, c);
      else throw new Error(`PNG : filtre ${String(filter)} inconnu (ligne ${String(y)})`);
      current[i] = value & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      rgba[dst] = current[src] ?? 0;
      rgba[dst + 1] = current[src + 1] ?? 0;
      rgba[dst + 2] = current[src + 2] ?? 0;
      rgba[dst + 3] = channels === 4 ? (current[src + 3] ?? 255) : 255;
    }
    previous.set(current);
  }
  return { width, height, rgba };
}

/** Statistiques de la zone [x, x+width) × [y, y+height) de l'image (bornée à l'image), échantillonnée tous les `SAMPLE_STEP` px. */
export function measureRegion(image: RgbaImage, region: Region): PixelStats {
  const xMax = Math.min(image.width, region.x + region.width);
  const yMax = Math.min(image.height, region.y + region.height);
  const colors = new Set<number>();
  let sampled = 0;
  let nearBlack = 0;
  for (let y = region.y + SAMPLE_STEP / 2; y < yMax; y += SAMPLE_STEP) {
    for (let x = region.x + SAMPLE_STEP / 2; x < xMax; x += SAMPLE_STEP) {
      const i = (y * image.width + x) * 4;
      const r = image.rgba[i] ?? 0;
      const g = image.rgba[i + 1] ?? 0;
      const b = image.rgba[i + 2] ?? 0;
      sampled += 1;
      if (Math.max(r, g, b) < NEAR_BLACK_MAX) nearBlack += 1;
      colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    }
  }
  return { sampled, nearBlack, distinct: colors.size };
}

/** Image unie (tests et auto-contrôle) ; `paint` peut poser d'autres pixels. */
export function solidImage(width: number, height: number, color: readonly [number, number, number], paint?: (rgba: Uint8Array) => void): RgbaImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = color[0];
    rgba[i * 4 + 1] = color[1];
    rgba[i * 4 + 2] = color[2];
    rgba[i * 4 + 3] = 255;
  }
  paint?.(rgba);
  return { width, height, rgba };
}

/** Peint un rectangle plein (tests). */
export function fillRect(image: RgbaImage, rect: Region, color: readonly [number, number, number]): void {
  for (let y = rect.y; y < Math.min(image.height, rect.y + rect.height); y += 1) {
    for (let x = rect.x; x < Math.min(image.width, rect.x + rect.width); x += 1) {
      const i = (y * image.width + x) * 4;
      image.rgba[i] = color[0];
      image.rgba[i + 1] = color[1];
      image.rgba[i + 2] = color[2];
    }
  }
}
