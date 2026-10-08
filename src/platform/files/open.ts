import { createBrowserFiles } from './browser';
import { createIosFiles } from './iosFiles';
import { createTauriFiles } from './tauriFiles';
import { createUnavailableFiles } from './memory';
import type { FileService } from './types';

/**
 * Service de fichiers de la plateforme courante : PC Windows installé -> boîtes « Enregistrer sous » et « Ouvrir » système (Rust) ;
 * iPhone -> sélecteur « Enregistrer dans Fichiers » (plugin ct-files appelé par Rust, FILES-IOS-01) et sélecteur de fichiers du système
 * (`<input type="file">`) pour le CSV de l'import (P-07 critère 13) ; navigateur de développement -> téléchargement.
 * En développement, un test de bout en bout peut poser `globalThis.__ctFiles` (faux) avant le chargement de la page.
 */
export function openFileService(runtime: 'tauri' | 'web', os: 'windows' | 'ios' | 'other'): FileService {
  if (import.meta.env.DEV) {
    const override = (globalThis as { __ctFiles?: FileService }).__ctFiles;
    if (override) return override;
  }
  if (runtime === 'web') return createBrowserFiles();
  if (os === 'windows') return createTauriFiles();
  if (os === 'ios') return createIosFiles();
  return createUnavailableFiles();
}
