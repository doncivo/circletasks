import { todayLocal } from '../../domain/clock';
import {
  parseImportFile,
  titleDateKey,
  validateImportRows,
  type ImportFileError,
  type ImportTable,
  type ImportValidation,
  type UndatedTarget,
} from '../../domain/csvImport';
import { newEntityId } from '../../domain/id';
import type { NewTask, ReminderOffsetMin, Task } from '../../domain/model';
import { buildReminders } from '../../domain/reminders';
import { defaultSpaceFor } from '../../domain/spaceRules';
import type { ReminderId, TaskId } from '../../domain/types';
import { useAppStore } from '../app/appStore';
import type { AppContainer } from '../app/container';
import type { UndoableCommand } from '../app/undo';

type Deps = Pick<AppContainer, 'clock' | 'ids' | 'data' | 'undo' | 'taskEntities'>;

/** Lignes écrites par lot dans la transaction (l'indicateur d'avancement avance à chaque lot). */
export const IMPORT_BATCH_SIZE = 200;

export interface ImportPreview {
  readonly fileName: string;
  readonly table: ImportTable;
  readonly undated: UndatedTarget;
  readonly validation: ImportValidation;
  /** Tâches à créer qui ont le même titre et la même date qu'une tâche existante (avertissement seulement, critère 10). */
  readonly duplicates: number;
}

export type AnalyzeResult = { readonly ok: true; readonly preview: ImportPreview } | { readonly ok: false; readonly error: ImportFileError };

export interface ImportOutcome {
  readonly created: readonly Task[];
}

export interface ImportUseCases {
  /** Lit le texte du fichier, le valide et compte les doublons. Ne touche pas à la base en écriture. */
  analyze(fileName: string, text: string, undated: UndatedTarget): Promise<AnalyzeResult>;
  /** Re-valide la même table avec un autre choix pour les tâches sans date. */
  revalidate(preview: ImportPreview, undated: UndatedTarget): Promise<ImportPreview>;
  /**
   * Crée les tâches valides en une seule transaction (tout ou rien), par lots, avec les règles d'une tâche saisie à la main (rappels
   * par défaut quand il y a une heure, ordre en fin de liste), puis pousse une commande « Annuler » unique (5 s et Ctrl+Z) qui retire
   * tout le lot. Rejette si l'écriture échoue (rien n'est créé).
   */
  run(preview: ImportPreview, onProgress?: (done: number, total: number) => void): Promise<ImportOutcome>;
}

/**
 * Commande « Annuler » propre à l'import (5 s et Ctrl+Z) : retire le lot d'un coup. Par paquets de 100, UNE requête retient les tâches
 * encore au `hlc` écrit par l'import (non modifiées depuis) et les écarte, UNE autre écarte leurs rappels : pas de lecture ni d'écriture
 * tâche par tâche. Aucune tâche retirée (toutes modifiées depuis) : 'stale'.
 */
export function createImportUndoCommand(deps: Pick<Deps, 'data' | 'taskEntities'>, created: readonly Task[]): UndoableCommand {
  return {
    kind: 'import',
    count: created.length,
    labelKey: created.length === 1 ? 'importCsv.undoLabelOne' : 'importCsv.undoLabel',
    labelParams: { count: created.length },
    async undo() {
      const removed = await deps.data.transaction(async (repos) => {
        const gone: TaskId[] = [];
        for (let start = 0; start < created.length; start += 100) {
          const chunk = created.slice(start, start + 100);
          const ids = await repos.tasks.discardUnchanged(chunk.map((task) => ({ id: task.id, hlc: task.hlc })));
          if (ids.length > 0) await repos.reminders.softDeleteForTargets('task', ids);
          gone.push(...ids);
        }
        return gone;
      });
      if (removed.length === 0) return 'stale';
      deps.taskEntities.remove(removed);
      return 'undone';
    },
  };
}

/** Cas d'usage de l'import CSV (P-07). */
export function createImportUseCases(deps: Deps): ImportUseCases {
  async function validate(fileName: string, table: ImportTable, undated: UndatedTarget): Promise<ImportPreview> {
    const [spaces, projects] = await Promise.all([deps.data.repos.spaces.listAll(), deps.data.repos.projects.listForFilter('all', { includeArchived: true })]);
    const defaultSpaceId = defaultSpaceFor(useAppStore.getState().spaceFilter, spaces);
    const first = spaces[0];
    if (!defaultSpaceId || !first) {
      // Aucun espace : jamais le cas après le premier démarrage (Pro et Perso sont créés), mais on ne devine rien.
      return { fileName, table, undated, validation: { valid: [], rejected: [], warnings: [] }, duplicates: 0 };
    }
    const validation = validateImportRows(table, {
      spaces: spaces.map((space) => ({ id: space.id, name: space.name })),
      defaultSpaceId,
      projects: projects.map((project) => ({ id: project.id, spaceId: project.spaceId, name: project.name, archived: project.archived })),
      undated,
      today: todayLocal(deps.clock),
    });
    const existing = await deps.data.repos.tasks.existingTitleDates(validation.valid.map((draft) => ({ title: draft.title, date: draft.date })));
    const duplicates = validation.valid.filter((draft) => existing.has(titleDateKey(draft))).length;
    return { fileName, table, undated, validation, duplicates };
  }

  return {
    async analyze(fileName, text, undated) {
      const parsed = parseImportFile(text);
      if (!parsed.ok) return parsed;
      return { ok: true, preview: await validate(fileName, parsed.table, undated) };
    },

    revalidate: (preview, undated) => validate(preview.fileName, preview.table, undated),

    async run(preview, onProgress) {
      const drafts = preview.validation.valid;
      const offsets: readonly ReminderOffsetMin[] = await deps.data.repos.settings.get('reminders.defaultOffsets');
      const base = deps.clock.nowMs();
      const created: Task[] = [];
      await deps.data.transaction(async (repos) => {
        for (let start = 0; start < drafts.length; start += IMPORT_BATCH_SIZE) {
          const batch = drafts.slice(start, start + IMPORT_BATCH_SIZE);
          const tasks = batch.map(
            (draft, offset): NewTask => ({
              id: newEntityId<TaskId>(deps.ids),
              spaceId: draft.spaceId,
              projectId: draft.projectId,
              title: draft.title,
              note: draft.note,
              date: draft.date,
              time: draft.time,
              status: 'todo',
              doneAt: null,
              // Fin de liste, dans l'ordre du fichier (comme une tâche saisie à la main : horodatage croissant).
              sortOrder: base + start + offset,
              carriedOver: false,
              recurrenceId: null,
              seriesIndex: null,
              seriesTemplate: null,
              goalId: null,
              icon: null,
              someday: draft.someday,
              source: 'local',
              externalId: null,
              externalEventId: null,
            }),
          );
          const written = await repos.tasks.createMany(tasks);
          // N-02 : rappels par défaut seulement pour une tâche datée avec une heure ; écrits par paquets (une instruction par paquet).
          const reminders = written.flatMap((task) =>
            buildReminders({
              target: { type: 'task', id: task.id },
              date: task.date,
              time: task.time,
              offsets,
              newReminderId: () => newEntityId<ReminderId>(deps.ids),
            }),
          );
          if (reminders.length > 0) await repos.reminders.createMany(reminders);
          created.push(...written);
          onProgress?.(created.length, drafts.length);
        }
      });
      deps.taskEntities.publish(created);
      if (created.length > 0) {
        deps.undo.push(createImportUndoCommand(deps, created));
      }
      return { created };
    },
  };
}
