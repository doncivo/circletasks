import { createBrowserFiles, pickTextFromInput } from './browser';
import { createTauriFiles } from './tauriFiles';
import { createUnavailableFiles } from './memory';
import { DEFAULT_PICK_MAX_BYTES } from './types';
import type { FileService } from './types';

/**
 * Service de fichiers de la plateforme courante : PC Windows installé -> boîtes « Enregistrer sous » et « Ouvrir » système (Rust) ;
 * iPhone -> enregistrement indisponible jusqu'au plugin Fichiers de l'ordre 5 (le bouton « Exporter » n'apparaît pas), mais le sélecteur
 * de fichiers du système (`<input type="file">`) fournit le CSV de l'import (P-07 critère 13) ; navigateur de développement -> téléchargement.
 * En développement, un test de bout en bout peut poser `globalThis.__ctFiles` (faux) avant le chargement de la page.
 */
export function openFileService(runtime: 'tauri' | 'web', os: 'windows' | 'ios' | 'other'): FileService {
  if (import.meta.env.DEV) {
    const override = (globalThis as { __ctFiles?: FileService }).__ctFiles;
    if (override) return override;
  }
  if (runtime === 'web') return createBrowserFiles();
  if (os === 'windows') return createTauriFiles();
  if (os === 'ios') return { ...createUnavailableFiles(), pickText: (options) => pickTextFromInput(options.accept, options.maxBytes ?? DEFAULT_PICK_MAX_BYTES) };
  return createUnavailableFiles();
}
