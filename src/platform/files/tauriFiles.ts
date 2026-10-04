import { decodeImportBytes, IMPORT_MAX_BYTES } from '../../domain/csvImport';
import { FileExportError, MAX_EXPORT_BYTES, type FileService, type PickedText, type SaveRequest } from './types';

/** Commandes Rust de l'export et de l'import (`src-tauri/src/export.rs`, `src-tauri/src/import.rs`), injectables pour les tests. */
export interface TauriFileApi {
  /** « Enregistrer sous » système puis écriture du fichier choisi, faites par Rust ; chemin choisi, ou null si l'utilisateur annule. */
  saveFile(name: string, data: Uint8Array): Promise<string | null>;
  /** Affiche le dernier fichier exporté dans l'explorateur : aucun paramètre, Rust connaît le chemin et refuse tout chemin non local. */
  revealExported(): Promise<void>;
  /** « Ouvrir » système puis lecture du seul fichier choisi, faite par Rust (2 Mo au plus, disque local) ; null si l'utilisateur annule. Octets en base64. */
  pickFile(): Promise<{ name: string; data: string } | null>;
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
    async pickFile() {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<{ name: string; data: string } | null>('import_open_file');
    },
  };
}

function bytesOfBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * PC Windows (H-03 critère 7, P-07) : les boîtes « Enregistrer sous » et « Ouvrir » système, l'écriture et la lecture sont faites par Rust,
 * qui n'écrit ni ne lit que le fichier choisi (`capabilities/export.json` et `import.json` : une commande par opération, aucune
 * permission de plugin fs ni dialog). Annuler n'est pas une erreur. Échec d'écriture : `FileExportError` ; un fichier existant n'est
 * jamais supprimé (s'il a été écrasé, il peut être tronqué). Lecture : texte UTF-8, repli Windows-1252 ; au-delà de 2 Mo,
 * `FileExportError('too-large')`.
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
    async pickText(): Promise<PickedText | null> {
      let picked: { name: string; data: string } | null;
      try {
        picked = await api.pickFile();
      } catch (error) {
        const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
        throw new FileExportError(code === 'too-large' ? 'too-large' : 'unreadable', error);
      }
      if (picked === null) return null;
      const bytes = bytesOfBase64(picked.data);
      if (bytes.length > IMPORT_MAX_BYTES) throw new FileExportError('too-large');
      return { name: picked.name, text: decodeImportBytes(bytes) };
    },
  };
}
