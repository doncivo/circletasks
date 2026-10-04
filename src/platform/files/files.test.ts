import { describe, expect, it, vi } from 'vitest';
import { createMemoryFiles, createTauriFiles, createUnavailableFiles, FileExportError, MAX_EXPORT_BYTES, type TauriFileApi } from './index';

const request = { suggestedName: 'circletasks-taches-2026-10-04.csv', mime: 'text/csv', data: new Uint8Array([1, 2, 3]) };

function api(overrides: Partial<TauriFileApi> = {}): TauriFileApi {
  return {
    saveFile: () => Promise.resolve('C:\\Docs\\export.csv'),
    revealExported: () => Promise.resolve(),
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

  it('Tauri : la commande Rust reçoit le nom proposé et les octets, et renvoie le chemin choisi', async () => {
    const saveFile = vi.fn(() => Promise.resolve('C:\\Docs\\export.csv'));
    const files = createTauriFiles(api({ saveFile }));
    await expect(files.save(request)).resolves.toEqual({ saved: true, path: 'C:\\Docs\\export.csv' });
    expect(saveFile).toHaveBeenCalledWith(request.suggestedName, request.data);
  });

  it('Tauri : annuler la boîte ne lève aucune erreur', async () => {
    const files = createTauriFiles(api({ saveFile: () => Promise.resolve(null) }));
    await expect(files.save(request)).resolves.toEqual({ saved: false });
  });

  it('Tauri : un échec d’écriture (disque plein) lève FileExportError', async () => {
    const files = createTauriFiles(api({ saveFile: () => Promise.reject(new Error('disque plein')) }));
    await expect(files.save(request)).rejects.toMatchObject({ name: 'FileExportError', reason: 'write-failed' });
  });

  it('Tauri : « Afficher dans le dossier » appelle la commande Rust sans aucun chemin', async () => {
    const revealExported = vi.fn(() => Promise.resolve());
    const files = createTauriFiles(api({ revealExported }));
    await files.reveal?.('C:\\Docs\\export.csv');
    expect(revealExported).toHaveBeenCalledWith();
  });

  it('Tauri : un fichier de plus de 64 Mio est refusé avant tout envoi', async () => {
    const saveFile = vi.fn(() => Promise.resolve('C:\\Docs\\export.csv'));
    const files = createTauriFiles(api({ saveFile }));
    const tooBig = { ...request, data: { length: MAX_EXPORT_BYTES + 1 } as unknown as Uint8Array };
    await expect(files.save(tooBig)).rejects.toBeInstanceOf(FileExportError);
    expect(saveFile).not.toHaveBeenCalled();
  });
});
