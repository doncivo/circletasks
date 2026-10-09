import type { Page } from '@playwright/test';

/** Faux du service de fichiers pour les e2e (H-03) : enregistre en mémoire ce que l'app écrirait ; à installer AVANT d'ouvrir l'app. */

export interface SavedFile {
  readonly name: string;
  readonly mime: string;
  readonly bytes: number[];
}

declare global {
  interface Window {
    __ctSaved?: SavedFile[];
    __ctRevealed?: string[];
    __ctFilesMode?: 'save' | 'cancel' | 'fail' | 'too-large';
    /** P-07 : fichier que « Choisir un fichier » rendra (null : annulation) ; `__ctPickFail` : raison d'un échec de lecture. */
    __ctPick?: { name: string; text: string } | null;
    __ctPickFail?: string | null;
  }
}

export async function installFakeFiles(page: Page, options: { canSave?: boolean } = {}): Promise<void> {
  await page.addInitScript((canSave) => {
    window.__ctSaved = [];
    window.__ctRevealed = [];
    window.__ctFilesMode = 'save';
    (globalThis as { __ctFiles?: unknown }).__ctFiles = {
      canSave: () => canSave,
      save: async (request: { suggestedName: string; mime: string; data: Uint8Array }) => {
        const mode = window.__ctFilesMode;
        window.__ctFilesMode = 'save';
        if (mode === 'cancel') return { saved: false };
        if (mode === 'fail') throw new Error('disque plein');
        if (mode === 'too-large') throw Object.assign(new Error('trop gros'), { reason: 'too-large' });
        (window.__ctSaved ??= []).push({ name: request.suggestedName, mime: request.mime, bytes: Array.from(request.data) });
        return { saved: true, path: `C:\\Export\\${request.suggestedName}` };
      },
      reveal: async (path: string) => {
        (window.__ctRevealed ??= []).push(path);
      },
      pickText: async () => {
        const failure = window.__ctPickFail ?? null;
        window.__ctPickFail = null;
        if (failure) throw Object.assign(new Error(failure), { reason: failure });
        return window.__ctPick ?? null;
      },
    };
  }, options.canSave ?? true);
}

export async function nextFilesMode(page: Page, mode: 'cancel' | 'fail' | 'too-large'): Promise<void> {
  await page.evaluate((value) => {
    window.__ctFilesMode = value;
  }, mode);
}

export async function savedFiles(page: Page): Promise<SavedFile[]> {
  return page.evaluate(() => window.__ctSaved ?? []);
}

export async function revealedPaths(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__ctRevealed ?? []);
}

/** Texte UTF-8 d'un fichier enregistré (BOM conservée). */
export function textOf(file: SavedFile): string {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(file.bytes));
}

/** Le seul fichier enregistré (échoue s'il y en a zéro ou plusieurs). */
export async function onlySaved(page: Page): Promise<SavedFile> {
  const files = await savedFiles(page);
  const [file] = files;
  if (files.length !== 1 || !file) throw new Error(`un fichier attendu, ${String(files.length)} enregistré(s)`);
  return file;
}

/** Entier de 32 bits en gros-boutiste à `offset`. */
export function be32(bytes: readonly number[], offset: number): number {
  return ((bytes[offset] ?? 0) * 2 ** 24) + ((bytes[offset + 1] ?? 0) << 16) + ((bytes[offset + 2] ?? 0) << 8) + (bytes[offset + 3] ?? 0);
}

/** P-07 : fichier que « Choisir un fichier » rendra (null : annulation de la boîte). */
export async function setPick(page: Page, file: { name: string; text: string } | null): Promise<void> {
  await page.evaluate((value) => {
    window.__ctPick = value;
  }, file);
}

/** P-07 : le prochain choix de fichier échoue (« too-large », « unreadable »). */
export async function failNextPick(page: Page, reason: 'too-large' | 'unreadable'): Promise<void> {
  await page.evaluate((value) => {
    window.__ctPickFail = value;
  }, reason);
}
