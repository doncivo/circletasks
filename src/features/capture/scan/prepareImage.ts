/**
 * Image à lire (Q-04 critères 2 et 3) : contrôle du type et de la taille, réduction à 2 000 px au plus, vignette. Tout reste en mémoire :
 * la photo n'est ni enregistrée ni envoyée, le bitmap est fermé dès que la lecture est faite. Jamais d'URL `blob:` (la politique de
 * sécurité de l'app ne l'autorise pas pour les images) : la vignette est une petite image `data:`.
 */

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 2_000;
export const ACCEPTED_IMAGE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];
const THUMBNAIL_SIDE = 320;

export type ImageRefusal = 'heic' | 'unsupported' | 'too-large';

export interface ImageCandidate {
  readonly type: string;
  readonly size: number;
  readonly name?: string;
}

/** Pourquoi une image est refusée (HEIC : message dédié), `null` si elle peut être lue. */
export function checkImageFile(file: ImageCandidate): ImageRefusal | null {
  const type = file.type.toLowerCase();
  const name = (file.name ?? '').toLowerCase();
  if (/^image\/hei[cf]/.test(type) || /\.(heic|heif)$/.test(name)) return 'heic';
  if (!ACCEPTED_IMAGE_TYPES.includes(type)) return 'unsupported';
  if (file.size > MAX_IMAGE_BYTES) return 'too-large';
  return null;
}

/** Dimensions réduites pour tenir dans `max` px sur le plus grand côté (jamais agrandies). */
export function fitWithin(width: number, height: number, max: number = MAX_IMAGE_SIDE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const ratio = max / longest;
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

export interface PreparedImage {
  /** Image réduite, en mémoire (PNG si l'original l'était, sinon JPEG). */
  readonly blob: Blob;
  /** Petite image `data:` pour la relecture ; `null` si le navigateur ne sait pas dessiner. */
  readonly thumbnail: string | null;
  /** Dimensions de l'image lue. */
  readonly width: number;
  readonly height: number;
}

export class ImageUnreadableError extends Error {
  constructor(cause?: unknown) {
    super('Image illisible', { cause });
    this.name = 'ImageUnreadableError';
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new ImageUnreadableError())), type, quality);
  });
}

/**
 * Décode, réduit à 2 000 px et ré-encode (JPEG 92 %, ou PNG pour un PNG : texte net). Sans décodeur (jsdom), l'image passe telle quelle.
 * Rejette avec `ImageUnreadableError` si le fichier n'est pas une image.
 */
export async function prepareImage(source: Blob): Promise<PreparedImage> {
  if (typeof createImageBitmap !== 'function') return { blob: source, thumbnail: null, width: 0, height: 0 };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch (error) {
    throw new ImageUnreadableError(error);
  }
  try {
    const target = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext('2d');
    if (!context) return { blob: source, thumbnail: null, width: bitmap.width, height: bitmap.height };
    // Fond blanc : un PNG transparent ne devient pas noir en JPEG.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, target.width, target.height);
    context.drawImage(bitmap, 0, 0, target.width, target.height);
    const asPng = source.type === 'image/png';
    const blob = await toBlob(canvas, asPng ? 'image/png' : 'image/jpeg', asPng ? undefined : 0.92);

    const small = fitWithin(target.width, target.height, THUMBNAIL_SIDE);
    const thumb = document.createElement('canvas');
    thumb.width = small.width;
    thumb.height = small.height;
    thumb.getContext('2d')?.drawImage(canvas, 0, 0, small.width, small.height);
    return { blob, thumbnail: thumb.toDataURL('image/jpeg', 0.8), width: target.width, height: target.height };
  } finally {
    bitmap.close();
  }
}

export type WebcamFailure = 'denied' | 'none' | 'failed';

export class WebcamError extends Error {
  readonly reason: WebcamFailure;
  constructor(reason: WebcamFailure, cause?: unknown) {
    super(`Webcam indisponible (${reason})`, { cause });
    this.name = 'WebcamError';
    this.reason = reason;
  }
}

/** Démarre la webcam (appelé seulement après le clic « Utiliser la webcam » : jamais d'accès implicite, critère « action explicite »). */
export async function startWebcam(): Promise<MediaStream> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) throw new WebcamError('none');
  try {
    return await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new WebcamError('denied', error);
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new WebcamError('none', error);
    throw new WebcamError('failed', error);
  }
}

/** Coupe la caméra (voyant éteint) : à la photo prise, à l'arrêt et à la fermeture. */
export function stopWebcam(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

/** Photo de l'image affichée par la webcam, en JPEG, en mémoire. */
export async function captureFrame(video: HTMLVideoElement): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext('2d');
  if (!context || canvas.width === 0) throw new ImageUnreadableError();
  context.drawImage(video, 0, 0);
  return toBlob(canvas, 'image/jpeg', 0.92);
}
