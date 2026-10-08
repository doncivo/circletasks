import { pickTextFromInput } from './browser';
import { DEFAULT_PICK_MAX_BYTES, FileExportError, MAX_EXPORT_BYTES, type FileService, type SaveRequest, type SaveResult } from './types';

/**
 * Commande Rust de l'export sur iPhone (`src-tauri/src/export_ios.rs`, capability `export-ios.json`), injectable pour les tests : Rust écrit
 * un temporaire, le plugin Swift `ct-files` présente le sélecteur « Enregistrer dans Fichiers », puis Rust supprime le temporaire.
 * Résout `{ completed }` (faux = annulation) ; rejette `{ code }`.
 */
export interface IosFileApi {
  saveFile(name: string, data: Uint8Array): Promise<{ readonly completed: boolean }>;
}

/** Nom du fichier dans l'en-tête de la requête : base64 de l'UTF-8 (un en-tête ne porte pas d'accents). */
function encodeName(name: string): string {
  return btoa(Array.from(new TextEncoder().encode(name), (byte) => String.fromCharCode(byte)).join(''));
}

export function loadIosFileApi(): IosFileApi {
  return {
    async saveFile(name, data) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<{ completed: boolean }>('export_save_file', data, { headers: { 'x-file-name': encodeName(name) } });
    },
  };
}

/** Code `{ code }` d'un rejet de la commande, s'il en a la forme. */
function codeOf(error: unknown): string | undefined {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/**
 * iPhone (FILES-IOS-01, ADR 0009 avenant lot F A4, décision du 2026-10-08) : `save` passe par le sélecteur « Enregistrer dans Fichiers »
 * (iCloud Drive compris), jamais par le panneau de partage (H-03 : aucune donnée ne quitte l'appareil). Pas de `reveal` (aucun chemin
 * connu). `pickText` : sélecteur de fichiers du système (`<input type="file">`, P-07 critère 13), inchangé.
 *
 * Correspondance : `completed` vrai -> `{ saved: true }` (sans chemin) ; faux -> `{ saved: false }` (annulation, pas une erreur) ;
 * `not-foreground` ou `busy` -> `FileExportError('unavailable')` ; `too-large` -> `'too-large'` ; tout autre rejet -> `'write-failed'`.
 * La cause garde le code de Rust (`fileErrorCode`) pour le message visible et le journal.
 */
export function createIosFiles(api: IosFileApi = loadIosFileApi()): FileService {
  return {
    canSave: () => true,
    async save(request: SaveRequest): Promise<SaveResult> {
      // Même plafond que la commande Rust (64 Mio) : refus avant tout envoi.
      if (request.data.length > MAX_EXPORT_BYTES) throw new FileExportError('too-large', { code: 'too-large' });
      let answer: { readonly completed: boolean };
      try {
        answer = await api.saveFile(request.suggestedName, request.data);
      } catch (error) {
        const code = codeOf(error);
        if (code === 'not-foreground' || code === 'busy') throw new FileExportError('unavailable', error);
        if (code === 'too-large') throw new FileExportError('too-large', error);
        throw new FileExportError('write-failed', error);
      }
      return answer.completed ? { saved: true } : { saved: false };
    },
    pickText: (options) => pickTextFromInput(options.accept, options.maxBytes ?? DEFAULT_PICK_MAX_BYTES),
  };
}
