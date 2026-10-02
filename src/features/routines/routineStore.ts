import { createStore } from 'zustand';
import type { ReminderOffsetMin, Routine } from '../../domain/model';
import type { RoutineError } from '../../domain/routineRules';
import { groupDoneDates } from '../../domain/routineSchedule';
import type { LocalDate, Result, RoutineId, SpaceFilter } from '../../domain/types';
import type { PlainMessageKey } from '../../i18n';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { createRoutineUseCases, type RoutineInput } from './routineUseCases';

export type RoutinesStatus = 'idle' | 'loading' | 'ready' | 'error';

/** `create` et `update` peuvent en plus échouer pour une raison imprévue (écriture ou lecture en base). */
export type RoutineSaveError = RoutineError | 'unexpected';

/** Plage de lecture des validations : tout l'historique (séries, meilleure série, taux sur 90 jours, carte de chaleur). */
const HISTORY_FROM = '0001-01-01' as LocalDate;
const HISTORY_TO = '9999-12-31' as LocalDate;

/**
 * État et actions de l'onglet Routines (M4). Une instance par conteneur (`defineFeatureStore`, ADR 0004). Les occurrences ne sont
 * pas stockées : on charge les routines et leurs validations, tout le reste se calcule dans src/domain.
 */
export interface RoutinesState {
  readonly filter: SpaceFilter;
  /** Routines non archivées (en pause comprises), triées par heure puis titre. */
  readonly routines: readonly Routine[];
  /** Routines archivées de l'espace filtré (R-05). */
  readonly archived: readonly Routine[];
  /** Dates validées de chaque routine, historique complet. */
  readonly doneByRoutine: ReadonlyMap<RoutineId, ReadonlySet<LocalDate>>;
  /** Avances cochées d'office quand on donne une heure à une nouvelle routine (`reminders.defaultOffsets`, QB-08). */
  readonly defaultOffsets: readonly ReminderOffsetMin[];
  /** A-06 : vue compacte de l'onglet (`view.compact.routines`, local à l'appareil), lue au chargement. */
  readonly compact: boolean;
  readonly status: RoutinesStatus;
  readonly errorKey: PlainMessageKey | null;
  /** Échec d'une action (enregistrer, valider…) : message dédié, la liste reste affichée. */
  readonly actionErrorKey: PlainMessageKey | null;
  /** (Re)charge les routines et leurs validations pour le filtre d'espace. Ne rejette jamais. */
  load(filter: SpaceFilter): Promise<void>;
  /** A-06 : bascule la vue compacte et la mémorise. Ne rejette jamais. */
  setCompact(compact: boolean): Promise<void>;
  /** R-01, R-07 : crée une routine puis recharge. Ne rejette jamais : les échecs sont dans le `Result`. */
  create(input: RoutineInput): Promise<Result<Routine, RoutineSaveError>>;
  /** R-01, R-02, R-07 : enregistre le formulaire d'une routine puis recharge. Ne rejette jamais. */
  update(id: RoutineId, input: RoutineInput): Promise<Result<Routine, RoutineSaveError>>;
  /** R-02 : avances des rappels d'une routine (cases du formulaire de modification). Ne rejette jamais (aucune avance en cas d'échec). */
  reminderOffsets(id: RoutineId): Promise<readonly ReminderOffsetMin[]>;
}

export const routinesStore = defineFeatureStore<RoutinesState>((container: AppContainer) => {
  const useCases = createRoutineUseCases(container);
  // Jeton de requête : le résultat d'un chargement dépassé par un plus récent est ignoré.
  let requestId = 0;

  const read = async (filter: SpaceFilter) => {
    const all = await container.data.repos.routines.listForFilter(filter, { includeArchived: true });
    const logs = await container.data.repos.routineLogs.listForRange({ from: HISTORY_FROM, to: HISTORY_TO }, filter);
    return {
      routines: all.filter((routine) => !routine.archived),
      archived: all.filter((routine) => routine.archived),
      doneByRoutine: groupDoneDates(logs),
    };
  };

  return createStore<RoutinesState>()((set, get) => ({
    filter: 'all',
    routines: [],
    archived: [],
    doneByRoutine: new Map<RoutineId, ReadonlySet<LocalDate>>(),
    compact: false,
    defaultOffsets: [0],
    status: 'idle',
    errorKey: null,
    actionErrorKey: null,

    async load(filter) {
      const id = ++requestId;
      set({ status: 'loading', filter, errorKey: null, actionErrorKey: null });
      try {
        const data = await read(filter);
        // Réglage illisible : vue détaillée par défaut.
        const compact = await container.data.repos.settings.get('view.compact').then((value) => value.routines, () => false);
        if (id !== requestId) return;
        const defaultOffsets = await container.data.repos.settings.get('reminders.defaultOffsets').catch((): readonly ReminderOffsetMin[] => [0]);
        if (id !== requestId) return;
        set({ ...data, compact, defaultOffsets, status: 'ready' });
      } catch {
        if (id !== requestId) return;
        set({ status: 'error', errorKey: 'routines.loadError' });
      }
    },

    async setCompact(compact) {
      const previous = get().compact;
      set({ compact });
      try {
        const stored = await container.data.repos.settings.get('view.compact');
        await container.data.repos.settings.set('view.compact', { ...stored, routines: compact });
      } catch {
        set({ compact: previous, actionErrorKey: 'routines.saveError' });
      }
    },

    async create(input) {
      try {
        const result = await useCases.create(input);
        if (result.ok) await get().load(get().filter);
        return result;
      } catch {
        set({ actionErrorKey: 'routines.saveError' });
        return { ok: false, error: 'unexpected' };
      }
    },

    async update(id, input) {
      try {
        const result = await useCases.update(id, input);
        if (result.ok) await get().load(get().filter);
        return result;
      } catch {
        set({ actionErrorKey: 'routines.saveError' });
        return { ok: false, error: 'unexpected' };
      }
    },

    async reminderOffsets(id) {
      try {
        return await useCases.reminderOffsets(id);
      } catch {
        return [];
      }
    },
  }));
});
