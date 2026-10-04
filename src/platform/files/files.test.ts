import { describe, expect, it, vi } from 'vitest';
import { createMemoryFiles, createTauriFiles, createUnavailableFiles, FileExportError, type TauriFileApi } from './index';

const request = { suggestedName: 'circletasks-taches-2026-10-04.csv', mime: 'text/csv', data: new Uint8Array([1, 2, 3]) };

function api(overrides: Partial<TauriFileApi> = {}): TauriFileApi & { written: Map<string, Uint8Array> } {
  const written = new Map<string, Uint8Array>();
  return {
    written,
    saveDialog: () => Promise.resolve('C:\\Docs\\export.csv'),
    writeFile: (path, data) => {
      written.set(path, data);
      return Promise.resolve();
    },
    remove: (path) => {
      written.delete(path);
      return Promise.resolve();
    },
    revealItemInDir: () => Promise.resolve(),
    ...overrides,
  };
}

describe('Contrat FileExporter (H-03 D4, critères 7, 9, 10)', () => {
  it('faux en mémoire : enregistre, annule sans erreur, échoue sur demande', async () => {
    const files = createMemoryFiles();
    expect(files.canSave()).toBe(true);
    await expect(files.save(request)).resolves.toMatchObject({ saved: true });
    expect(files.saved).toHaveLength(1);
    files.cancelNext();
    await expect(files.save(request)).resolves.toEqual({ saved: false });
    files.failNext();
    await expect(files.save(request)).rejects.toBeInstanceOf(FileExportError);
    expect(files.saved).toHaveLength(1);
  });

  it('iPhone avant l’ordre 5 : canSave est faux et enregistrer échoue proprement', async () => {
    const files = createUnavailableFiles();
    expect(files.canSave()).toBe(false);
    await expect(files.save(request)).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it('Tauri : boîte système puis écriture du fichier choisi, extension proposée au filtre', async () => {
    const saveDialog = vi.fn(() => Promise.resolve('C:\\Docs\\export.csv'));
    const fake = api({ saveDialog });
    const files = createTauriFiles(fake);
    await expect(files.save(request)).resolves.toEqual({ saved: true, path: 'C:\\Docs\\export.csv' });
    expect(saveDialog).toHaveBeenCalledWith({ defaultPath: request.suggestedName, extension: 'csv' });
    expect(fake.written.get('C:\\Docs\\export.csv')).toEqual(request.data);
  });

  it('Tauri : annuler la boîte n’écrit rien et ne lève aucune erreur', async () => {
    const writeFile = vi.fn(() => Promise.resolve());
    const files = createTauriFiles(api({ saveDialog: () => Promise.resolve(null), writeFile }));
    await expect(files.save(request)).resolves.toEqual({ saved: false });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('Tauri : échec d’écriture (disque plein) supprime le fichier partiel et lève FileExportError', async () => {
    const remove = vi.fn(() => Promise.resolve());
    const files = createTauriFiles(api({ writeFile: () => Promise.reject(new Error('disque plein')), remove }));
    await expect(files.save(request)).rejects.toMatchObject({ name: 'FileExportError', reason: 'write-failed' });
    expect(remove).toHaveBeenCalledWith('C:\\Docs\\export.csv');
  });

  it('Tauri : « Afficher dans le dossier »', async () => {
    const revealItemInDir = vi.fn(() => Promise.resolve());
    const files = createTauriFiles(api({ revealItemInDir }));
    await files.reveal?.('C:\\Docs\\export.csv');
    expect(revealItemInDir).toHaveBeenCalledWith('C:\\Docs\\export.csv');
  });
});
