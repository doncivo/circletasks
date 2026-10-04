import { FileExportError, type FileService, type PickedText } from './types';

/**
 * Navigateur de développement et tests de bout en bout : « enregistrer » déclenche un téléchargement (élément `<a download>`), le
 * navigateur choisit le dossier. Jamais utilisé dans l'app installée.
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
      return new Promise<PickedText | null>((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = options.accept.join(',');
        input.addEventListener('change', () => {
          const file = input.files?.[0];
          if (!file) {
            resolve(null);
            return;
          }
          file.text().then((text) => resolve({ name: file.name, text }), (error: unknown) => reject(new FileExportError('write-failed', error)));
        });
        input.addEventListener('cancel', () => resolve(null));
        input.click();
      });
    },
  };
}
