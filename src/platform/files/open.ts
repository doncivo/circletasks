import { createBrowserFiles } from './browser';
import { createTauriFiles } from './tauriFiles';
import { createUnavailableFiles } from './memory';
import type { FileService } from './types';

/**
 * Service de fichiers de la plateforme courante : PC Windows installé → boîte « Enregistrer sous » système ; iPhone → indisponible
 * jusqu'au plugin Fichiers de l'ordre 5 (le bouton « Exporter » n'apparaît pas) ; navigateur de développement → téléchargement.
 * En développement, un test de bout en bout peut poser `globalThis.__ctFiles` (faux) avant le chargement de la page.
 */
export function openFileService(runtime: 'tauri' | 'web', os: 'windows' | 'ios' | 'other'): FileService {
  if (import.meta.env.DEV) {
    const override = (globalThis as { __ctFiles?: FileService }).__ctFiles;
    if (override) return override;
  }
  if (runtime === 'web') return createBrowserFiles();
  return os === 'windows' ? createTauriFiles() : createUnavailableFiles();
}
