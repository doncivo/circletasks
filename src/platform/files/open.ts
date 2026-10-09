import { createBrowserFiles, pickTextFromInput } from './browser';
import { createTauriFiles } from './tauriFiles';
import { createUnavailableFiles } from './memory';
import { DEFAULT_PICK_MAX_BYTES, type FileService } from './types';

/**
 * iPhone : service réel chargé à la demande (bundle de départ, PERF-02) ; `canSave` vrai d'emblée, `pickText` par le sélecteur du système.
 */
function createLazyIosFiles(): FileService {
  let loaded: Promise<FileService> | null = null;
  const real = (): Promise<FileService> => (loaded ??= import('./iosFiles').then((module) => module.createIosFiles()));
  return {
    canSave: () => true,
    save: (request) => real().then((files) => files.save(request)),
    pickText: (options) => pickTextFromInput(options.accept, options.maxBytes ?? DEFAULT_PICK_MAX_BYTES),
  };
}

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
  if (os === 'ios') return createLazyIosFiles();
  return createUnavailableFiles();
}
