import { FileExportError, MAX_EXPORT_BYTES, type FileService, type SaveRequest } from './types';

/** Commandes Rust de l'export (`src-tauri/src/export.rs`), injectables pour les tests. */
export interface TauriFileApi {
  /** « Enregistrer sous » système puis écriture du fichier choisi, faites par Rust ; chemin choisi, ou null si l'utilisateur annule. */
  saveFile(name: string, data: Uint8Array): Promise<string | null>;
  /** Affiche le dernier fichier exporté dans l'explorateur : aucun paramètre, Rust connaît le chemin et refuse tout chemin non local. */
  revealExported(): Promise<void>;
}

/** Nom du fichier dans l'en-tête de la requête : base64 de l'UTF-8 (un en-tête ne porte pas d'accents). */
function encodeName(name: string): string {
  return btoa(Array.from(new TextEncoder().encode(name), (byte) => String.fromCharCode(byte)).join(''));
}

export function loadTauriFileApi(): TauriFileApi {
  return {
    async saveFile(name, data) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<string | null>('export_save_file', data, { headers: { 'x-file-name': encodeName(name) } });
    },
    async revealExported() {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('reveal_exported_file');
    },
  };
}

/**
 * PC Windows (H-03 critère 7) : la boîte « Enregistrer sous » et l'écriture sont faites par Rust, qui n'écrit que le fichier choisi
 * (`capabilities/export.json` : deux commandes, aucune permission de plugin fs ni dialog). Annuler n'est pas une erreur. Échec d'écriture :
 * `FileExportError` ; un fichier existant n'est jamais supprimé (s'il a été écrasé, il peut être tronqué).
 */
export function createTauriFiles(api: TauriFileApi = loadTauriFileApi()): FileService {
  return {
    canSave: () => true,
    async save(request: SaveRequest) {
      // Même plafond que la commande Rust (64 Mio) : refus avant tout envoi.
      if (request.data.length > MAX_EXPORT_BYTES) throw new FileExportError('write-failed');
      let path: string | null;
      try {
        path = await api.saveFile(request.suggestedName, request.data);
      } catch (error) {
        throw new FileExportError('write-failed', error);
      }
      return path === null ? { saved: false } : { saved: true, path };
    },
    reveal: () => api.revealExported(),
    // Lecture d'un fichier choisi : P-07 (commande Rust dédiée, limitée au fichier choisi).
    pickText: () => Promise.reject(new FileExportError('unsupported')),
  };
}
