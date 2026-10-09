import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIosFiles, fileErrorCode, FileExportError, MAX_EXPORT_BYTES, openFileService, type IosFileApi } from './index';

const request = { suggestedName: 'circletasks-taches-2026-10-08.csv', mime: 'text/csv', data: new Uint8Array([1, 2, 3]) };

function api(saveFile: IosFileApi['saveFile']): IosFileApi {
  return { saveFile };
}

describe('FILES-IOS-01 : service de fichiers de l’iPhone (ADR 0009 avenant lot F A4)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('critère 1 : (tauri, ios) enregistre, sans « Afficher dans le dossier », et choisit le CSV par le sélecteur du système', async () => {
    const files = openFileService('tauri', 'ios');
    expect(files.canSave()).toBe(true);
    expect(files.reveal).toBeUndefined();
    // pickText : `<input type="file">` (P-07 critère 13), refus avant lecture au-delà du plafond.
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      const file = new File(['x'.repeat(10)], 'grand.csv', { type: 'text/csv' });
      Object.defineProperty(this, 'files', { value: [file] });
      this.dispatchEvent(new Event('change'));
    });
    await expect(files.pickText({ accept: ['.csv'], maxBytes: 5 })).rejects.toMatchObject({ reason: 'too-large' });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('critère 1 : Windows et web gardent leurs services (Tauri avec « Afficher dans le dossier », téléchargement)', () => {
    expect(openFileService('tauri', 'windows').reveal).toBeTypeOf('function');
    expect(openFileService('web', 'other').canSave()).toBe(true);
    expect(openFileService('tauri', 'other').canSave()).toBe(false);
  });

  it('critère 2 : completed vrai -> { saved: true } sans chemin ; la commande reçoit le nom proposé et les octets', async () => {
    const saveFile = vi.fn(() => Promise.resolve({ completed: true }));
    const files = createIosFiles(api(saveFile));
    await expect(files.save(request)).resolves.toEqual({ saved: true });
    expect(saveFile).toHaveBeenCalledWith(request.suggestedName, request.data);
  });

  it('critère 2 : completed faux -> { saved: false } (annulation, pas une erreur)', async () => {
    const files = createIosFiles(api(() => Promise.resolve({ completed: false })));
    await expect(files.save(request)).resolves.toEqual({ saved: false });
  });

  it('critère 2 : not-foreground et busy -> unavailable ; too-large -> too-large ; tout autre rejet -> write-failed, code conservé', async () => {
    const cases: readonly (readonly [unknown, string, string])[] = [
      [{ code: 'not-foreground' }, 'unavailable', 'not-foreground'],
      [{ code: 'busy' }, 'unavailable', 'busy'],
      [{ code: 'too-large' }, 'too-large', 'too-large'],
      [{ code: 'unsafe-folder' }, 'write-failed', 'unsafe-folder'],
      [{ code: 'io' }, 'write-failed', 'io'],
      [{ code: 'failed' }, 'write-failed', 'failed'],
      [new Error('quelque chose'), 'write-failed', 'write-failed'],
    ];
    for (const [rejection, reason, code] of cases) {
      const files = createIosFiles(api(() => Promise.reject(rejection)));
      const error: unknown = await files.save(request).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(FileExportError);
      expect(error).toMatchObject({ reason });
      expect(fileErrorCode(error)).toBe(code);
    }
  });

  it('critère 2 : la promesse ne reste jamais en suspens : un sélecteur fermé par iOS sans réponse est rendu annulé au retour au premier plan', async () => {
    vi.useFakeTimers();
    try {
      // Le plugin résout `{ completed: false }` au retour au premier plan (`didBecomeActive`, contrat de la fixture) : simulé après 30 s.
      const files = createIosFiles(api(() => new Promise((resolve) => setTimeout(() => resolve({ completed: false }), 30_000))));
      const pending = files.save(request);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(pending).resolves.toEqual({ saved: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('critère 8 : au-delà de 64 Mio, refus « too-large » avant tout envoi', async () => {
    const saveFile = vi.fn(() => Promise.resolve({ completed: true }));
    const files = createIosFiles(api(saveFile));
    const tooBig = { ...request, data: { length: MAX_EXPORT_BYTES + 1 } as unknown as Uint8Array };
    const error: unknown = await files.save(tooBig).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: 'too-large' });
    expect(fileErrorCode(error)).toBe('too-large');
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('fileErrorCode : seule une valeur en forme de code est rendue (jamais un message ni un chemin)', () => {
    expect(fileErrorCode(new FileExportError('write-failed', { code: 'C:\\Users\\Ali' }))).toBe('write-failed');
    expect(fileErrorCode(new FileExportError('unreadable'))).toBe('unreadable');
    expect(fileErrorCode('texte')).toBe('write-failed');
    expect(fileErrorCode(null)).toBe('write-failed');
  });
});
