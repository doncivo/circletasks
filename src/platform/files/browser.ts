import { decodeImportBytes, IMPORT_MAX_BYTES } from '../../domain/csvImport';
import { FileExportError, type FileService, type PickedText } from './types';

/**
 * Navigateur de développement et tests de bout en bout : « enregistrer » déclenche un téléchargement (élément `<a download>`), le
 * navigateur choisit le dossier. Jamais utilisé dans l'app installée pour l'enregistrement. `pickText` (sélecteur de fichiers du système,
 * `<input type="file">`) sert aussi à l'iPhone installé (P-07 critère 13).
 */
export function createBrowserFiles(): FileService {
  return {
    canSave: () => typeof document !== 'undefined',
    save(request) {
      try {
        const blob = new Blob([request.data as BlobPart], { type: request.mime });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = request.suggestedName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
        return Promise.resolve({ saved: true });
      } catch (error) {
        return Promise.reject(new FileExportError('write-failed', error));
      }
    },
    pickText(options) {
      return pickTextFromInput(options.accept, options.maxBytes ?? IMPORT_MAX_BYTES);
    },
  };
}

/** Sélecteur de fichiers du système : un seul fichier, refusé s'il dépasse `maxBytes` (avant toute lecture), décodé UTF-8 avec repli Windows-1252. */
export function pickTextFromInput(accept: readonly string[], maxBytes: number): Promise<PickedText | null> {
  return new Promise<PickedText | null>((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept.join(',');
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      if (file.size > maxBytes) {
        reject(new FileExportError('too-large'));
        return;
      }
      file.arrayBuffer().then(
        (buffer) => resolve({ name: file.name, text: decodeImportBytes(new Uint8Array(buffer)) }),
        (error: unknown) => reject(new FileExportError('unreadable', error)),
      );
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}
