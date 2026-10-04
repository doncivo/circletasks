import { FileExportError, type FileService, type SaveRequest } from './types';

/** Accès aux plugins Tauri, injectable pour les tests. */
export interface TauriFileApi {
  /** Boîte « Enregistrer sous » système : chemin choisi, ou null si l'utilisateur annule. */
  saveDialog(options: { readonly defaultPath: string; readonly extension: string }): Promise<string | null>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  revealItemInDir(path: string): Promise<void>;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1);
}

/** Les plugins sont chargés à la demande : l'app n'a pas besoin d'eux tant qu'on n'exporte rien. */
export function loadTauriFileApi(): TauriFileApi {
  return {
    async saveDialog({ defaultPath, extension }) {
      const { save } = await import('@tauri-apps/plugin-dialog');
      return save({ defaultPath, filters: extension === '' ? [] : [{ name: extension.toUpperCase(), extensions: [extension] }] });
    },
    async writeFile(path, data) {
      const { writeFile } = await import('@tauri-apps/plugin-fs');
      await writeFile(path, data);
    },
    async remove(path) {
      const { remove } = await import('@tauri-apps/plugin-fs');
      await remove(path);
    },
    async revealItemInDir(path) {
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(path);
    },
  };
}

/**
 * PC Windows (H-03 critère 7) : « Enregistrer sous » du système, puis écriture du seul fichier choisi (le plugin dialog l'ajoute au
 * périmètre du plugin fs ; aucun autre accès, voir `capabilities/export.json`). Annuler n'est pas une erreur. Échec d'écriture : le
 * fichier partiel est supprimé et `FileExportError` est levée (critère 9).
 */
export function createTauriFiles(api: TauriFileApi = loadTauriFileApi()): FileService {
  return {
    canSave: () => true,
    async save(request: SaveRequest) {
      const path = await api.saveDialog({ defaultPath: request.suggestedName, extension: extensionOf(request.suggestedName) }).catch((error: unknown) => {
        throw new FileExportError('write-failed', error);
      });
      if (path === null) return { saved: false };
      try {
        await api.writeFile(path, request.data);
      } catch (error) {
        await api.remove(path).catch(() => undefined);
        throw new FileExportError('write-failed', error);
      }
      return { saved: true, path };
    },
    reveal: (path) => api.revealItemInDir(path),
    // Lecture d'un fichier choisi : P-07 (permission de lecture à ajouter alors, limitée au fichier choisi).
    pickText: () => Promise.reject(new FileExportError('unsupported')),
  };
}
