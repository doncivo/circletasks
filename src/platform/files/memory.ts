import { FileExportError, type FileService, type PickedText, type SaveRequest, type SaveResult } from './types';

export interface MemoryFiles extends FileService {
  /** Enregistrements réussis, dans l'ordre. */
  readonly saved: readonly (SaveRequest & { readonly path: string })[];
  readonly revealed: readonly string[];
  /** Prochaines réponses : annuler la boîte, échouer, ou fournir un texte à choisir. */
  cancelNext(): void;
  failNext(): void;
  setPick(file: PickedText | null): void;
  /** Le prochain choix de fichier échoue (« too-large », « unreadable »). */
  failNextPick(reason: 'too-large' | 'unreadable'): void;
}

/**
 * Faux des tests (H-03 critère 10 : le contrat `FileExporter` est testé avec un faux) : garde en mémoire ce qui serait écrit, sait annuler
 * ou échouer à la demande. `canSave` configurable (faux sur iPhone).
 */
export function createMemoryFiles(options: { readonly canSave?: boolean } = {}): MemoryFiles {
  const saved: (SaveRequest & { readonly path: string })[] = [];
  const revealed: string[] = [];
  let mode: 'save' | 'cancel' | 'fail' = 'save';
  let pick: PickedText | null = null;
  let pickFailure: 'too-large' | 'unreadable' | null = null;
  const canSave = options.canSave ?? true;
  return {
    saved,
    revealed,
    cancelNext: () => {
      mode = 'cancel';
    },
    failNext: () => {
      mode = 'fail';
    },
    setPick: (file) => {
      pick = file;
    },
    canSave: () => canSave,
    save(request): Promise<SaveResult> {
      const current = mode;
      mode = 'save';
      if (!canSave) return Promise.reject(new FileExportError('unavailable'));
      if (current === 'cancel') return Promise.resolve({ saved: false });
      if (current === 'fail') return Promise.reject(new FileExportError('write-failed'));
      const path = `C:\\Export\\${request.suggestedName}`;
      saved.push({ ...request, path });
      return Promise.resolve({ saved: true, path });
    },
    reveal(path) {
      revealed.push(path);
      return Promise.resolve();
    },
    failNextPick: (reason) => {
      pickFailure = reason;
    },
    pickText() {
      if (pickFailure) {
        const reason = pickFailure;
        pickFailure = null;
        return Promise.reject(new FileExportError(reason));
      }
      return Promise.resolve(pick);
    },
  };
}

/** Plateforme sans enregistrement de fichier (iPhone avant l'ordre 5) : le bouton « Exporter » n'apparaît pas. */
export function createUnavailableFiles(): FileService {
  return {
    canSave: () => false,
    save: () => Promise.reject(new FileExportError('unavailable')),
    pickText: () => Promise.reject(new FileExportError('unavailable')),
  };
}
