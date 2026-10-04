import { createStore } from 'zustand';
import { importTemplateCsv, rejectedReportCsv, type RejectReason, type UndatedTarget } from '../../domain/csvImport';
import { EXPORT_MIME } from '../../domain/historyExport';
import { t, tDynamic, type MessageKey } from '../../i18n';
import { logDesktopFailure } from '../../platform';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { createImportUseCases, type ImportPreview } from './importUseCases';

export type ImportStep = 'idle' | 'reading' | 'preview' | 'importing' | 'done';

export type ImportErrorKey = 'importCsv.errorEmpty' | 'importCsv.errorNoTitle' | 'importCsv.errorTooManyRows' | 'importCsv.errorTooLarge' | 'importCsv.errorUnreadable' | 'importCsv.errorFailed' | 'importCsv.errorSave';

export interface ImportState {
  readonly step: ImportStep;
  readonly preview: ImportPreview | null;
  readonly undated: UndatedTarget;
  readonly progress: { readonly done: number; readonly total: number } | null;
  /** Nombre de tâches créées par le dernier import. */
  readonly importedCount: number;
  readonly errorKey: ImportErrorKey | null;
  /** Dernier fichier enregistré (modèle ou rapport) : confirmation brève. */
  readonly savedKey: 'importCsv.templateSaved' | 'importCsv.reportSaved' | null;
  /** « Choisir un fichier » : boîte système, lecture, validation. Ne rejette jamais. */
  choose(): Promise<void>;
  /** Choix « Tâches sans date » : revalide le même fichier. */
  setUndated(value: UndatedTarget): Promise<void>;
  /** « Importer N tâches ». Ne rejette jamais ; en cas d'échec, rien n'est créé. */
  run(): Promise<void>;
  downloadTemplate(): Promise<void>;
  downloadReport(): Promise<void>;
  /** Revient au choix du fichier (autre fichier, ou ouverture de l'écran). */
  reset(): void;
}

const REASON_KEYS: Record<RejectReason['code'], MessageKey> = {
  'title-empty': 'importCsv.reasonTitleEmpty',
  'title-too-long': 'importCsv.reasonTitleTooLong',
  'date-invalid': 'importCsv.reasonDateInvalid',
  'time-invalid': 'importCsv.reasonTimeInvalid',
  'time-without-date': 'importCsv.reasonTimeWithoutDate',
  'space-unknown': 'importCsv.reasonSpaceUnknown',
};

/** Motif d'un rejet, en français : « date invalide « 31/02/2026 » ». */
export function rejectReasonText(reason: RejectReason): string {
  const params: Record<string, string | number> = 'value' in reason ? { value: reason.value } : 'length' in reason ? { length: reason.length } : {};
  // `t()` exige une clé littérale ; les motifs sont choisis à l'exécution.
  return tDynamic(REASON_KEYS[reason.code], params);
}

const FILE_ERROR_KEYS: Record<string, ImportErrorKey> = {
  empty: 'importCsv.errorEmpty',
  'no-title-column': 'importCsv.errorNoTitle',
  'too-many-rows': 'importCsv.errorTooManyRows',
};

export const importStore = defineFeatureStore<ImportState>((container: AppContainer) => createImportStore(container));

function createImportStore(container: AppContainer) {
  const useCases = createImportUseCases(container);
  const initial = { step: 'idle' as ImportStep, preview: null, undated: 'today' as UndatedTarget, progress: null, importedCount: 0, errorKey: null, savedKey: null };

  return createStore<ImportState>()((set, get) => ({
    ...initial,
    async choose() {
      set({ errorKey: null, savedKey: null });
      let picked;
      try {
        picked = await container.files.pickText({ accept: ['.csv', '.txt', '.tsv', 'text/csv', 'text/plain'] });
      } catch (error) {
        logDesktopFailure('import-pick', error);
        set({ step: get().preview ? 'preview' : 'idle', errorKey: (error as { reason?: unknown } | null)?.reason === 'too-large' ? 'importCsv.errorTooLarge' : 'importCsv.errorUnreadable' });
        return;
      }
      if (picked === null) return; // annulation : rien ne change
      set({ step: 'reading' });
      try {
        const result = await useCases.analyze(picked.name, picked.text, get().undated);
        if (!result.ok) {
          set({ step: 'idle', preview: null, errorKey: FILE_ERROR_KEYS[result.error] ?? 'importCsv.errorUnreadable' });
          return;
        }
        set({ step: 'preview', preview: result.preview });
      } catch (error) {
        logDesktopFailure('import-analyze', error);
        set({ step: 'idle', preview: null, errorKey: 'importCsv.errorUnreadable' });
      }
    },
    async setUndated(value) {
      const current = get().preview;
      set({ undated: value });
      if (!current) return;
      try {
        set({ preview: await useCases.revalidate(current, value) });
      } catch (error) {
        logDesktopFailure('import-revalidate', error);
        set({ errorKey: 'importCsv.errorUnreadable' });
      }
    },
    async run() {
      const preview = get().preview;
      if (!preview || preview.validation.valid.length === 0 || get().step === 'importing') return;
      set({ step: 'importing', errorKey: null, progress: { done: 0, total: preview.validation.valid.length } });
      try {
        const outcome = await useCases.run(preview, (done, total) => set({ progress: { done, total } }));
        set({ step: 'done', importedCount: outcome.created.length, progress: null, preview: null });
      } catch (error) {
        logDesktopFailure('import-run', error);
        set({ step: 'preview', progress: null, errorKey: 'importCsv.errorFailed' });
      }
    },
    async downloadTemplate() {
      set({ errorKey: null, savedKey: null });
      const csv = importTemplateCsv({ title: t('importCsv.templateExample'), date: '2026-10-06', time: '10:00', space: 'Pro', project: '', note: '' });
      try {
        const result = await container.files.save({ suggestedName: 'circletasks-modele-import.csv', mime: EXPORT_MIME.csv, data: new TextEncoder().encode(csv) });
        if (result.saved) set({ savedKey: 'importCsv.templateSaved' });
      } catch (error) {
        logDesktopFailure('import-template', error);
        set({ errorKey: 'importCsv.errorSave' });
      }
    },
    async downloadReport() {
      const preview = get().preview;
      if (!preview) return;
      set({ errorKey: null, savedKey: null });
      const csv = rejectedReportCsv(preview.table, preview.validation.rejected, rejectReasonText, { line: t('importCsv.reportColLine'), reason: t('importCsv.reportColReason') });
      try {
        const result = await container.files.save({ suggestedName: 'circletasks-import-lignes-rejetees.csv', mime: EXPORT_MIME.csv, data: new TextEncoder().encode(csv) });
        if (result.saved) set({ savedKey: 'importCsv.reportSaved' });
      } catch (error) {
        logDesktopFailure('import-report', error);
        set({ errorKey: 'importCsv.errorSave' });
      }
    },
    reset: () => set({ ...initial, undated: get().undated }),
  }));
}
