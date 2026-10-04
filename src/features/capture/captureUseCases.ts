import { nowLocalTime, todayLocal } from '../../domain/clock';
import type { ReminderOffsetMin, Task } from '../../domain/model';
import { effectiveProjectFilter } from '../../domain/projectRules';
import { parseQuickInput, type QuickContext } from '../../domain/quickInput';
import { defaultSpaceFor, isCreatedOutsideFilter } from '../../domain/spaceRules';
import type { SpaceId } from '../../domain/types';
import { t } from '../../i18n';
import { getFirstWeekday } from '../../i18n/formatPrefs';
import type { CaptureError } from '../../platform/capture';
import { useAppStore } from '../app/appStore';
import type { AppContainer } from '../app/container';
import type { UndoableCommand } from '../app/undo';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { normalizeQuickText } from './spokenTimes';
import { captureInputFrom } from './useQuickInput';

type Deps = Pick<AppContainer, 'clock' | 'ids' | 'data' | 'undo' | 'taskEntities'>;

export type CaptureTextResult = { readonly ok: true; readonly task: Task } | { readonly ok: false; readonly error: CaptureError };

/** Contexte d'analyse de la fenêtre principale : espaces, projets et filtre courants, heure de l'appareil. */
export function currentQuickContext(container: Pick<AppContainer, 'clock'>): QuickContext {
  const { spaces, projects, spaceFilter } = useAppStore.getState();
  return {
    spaces,
    projects,
    defaultSpaceId: defaultSpaceFor(spaceFilter, spaces),
    dates: true,
    firstWeekday: getFirstWeekday(),
    now: { date: todayLocal(container.clock), time: nowLocalTime(container.clock) },
  };
}

/**
 * Commande « Annuler » d'une ou plusieurs créations (Q-01 critère 5, Q-04 critère 9) : les tâches non modifiées depuis (hlc inchangé)
 * sont écartées avec leurs rappels, comme l'annulation d'une copie (T-12) ; si aucune ne peut l'être : 'stale'. Un seul Ctrl+Z
 * retire tout le lot.
 */
export function createCaptureUndoCommand(deps: Deps, created: readonly Task[], label: Pick<UndoableCommand, 'labelKey' | 'labelParams'>): UndoableCommand {
  return {
    kind: 'capture',
    count: created.length,
    ...label,
    async undo() {
      const removed = await deps.data.transaction(async (repos) => {
        const gone: Task[] = [];
        for (const task of created) {
          const current = await repos.tasks.getById(task.id);
          if (!current || current.hlc !== task.hlc) continue;
          const [discarded] = await repos.tasks.discard([task.id]);
          await repos.reminders.softDeleteForTarget({ type: 'task', id: task.id }, discarded?.deletedAt ?? undefined);
          gone.push(task);
        }
        return gone;
      });
      if (removed.length === 0) return 'stale';
      deps.taskEntities.remove(removed.map((task) => task.id));
      return 'undone';
    },
  };
}

/** Libellé « Annuler » : « Ajouté dans Perso » quand le filtre actif masque la tâche (ES-02), sinon « « Titre » ajoutée ». */
export function undoLabelFor(spaceId: SpaceId, title: string): Pick<UndoableCommand, 'labelKey' | 'labelParams'> {
  const { spaceFilter, spaces } = useAppStore.getState();
  const name = spaces.find((space) => space.id === spaceId)?.name;
  if (name && isCreatedOutsideFilter(spaceFilter, spaceId)) return { labelKey: 'spaces.addedIn', labelParams: { name } };
  return { labelKey: 'capture.undo.created', labelParams: { title } };
}

/**
 * Crée une tâche depuis le texte de la mini-fenêtre (Q-01), comme la saisie d'Aujourd'hui : même analyse (Q-06, Q-02, heures dictées),
 * même espace par défaut (ES-02), mêmes rappels par défaut ; sans date écrite, la tâche est datée d'aujourd'hui (la mini-fenêtre ne
 * connaît pas le jour affiché). Ajoute la commande « Annuler » (5 s, Ctrl+Z). Ne rejette jamais.
 */
export async function createTaskFromCaptureText(container: Deps, text: string, ignored: readonly string[]): Promise<CaptureTextResult> {
  try {
    const context = currentQuickContext(container);
    const parse = parseQuickInput(normalizeQuickText(text), context, { ignored: new Set(ignored) });
    if (parse.title.trim() === '') return { ok: false, error: 'title-empty' };

    const state = useAppStore.getState();
    const projectFilter = effectiveProjectFilter(state.spaceFilter, state.projectFilter, state.projects);
    const capture = captureInputFrom(parse, context.defaultSpaceId, projectFilter);
    if (!capture.spaceId) return { ok: false, error: 'no-space' };

    const date = capture.date ?? todayLocal(container.clock);
    const time = capture.time;
    const reminderOffsets: readonly ReminderOffsetMin[] =
      time !== null ? await container.data.repos.settings.get('reminders.defaultOffsets').catch((): readonly ReminderOffsetMin[] => []) : [];
    const result = await createTaskUseCases(container).create({
      title: capture.title,
      spaceId: capture.spaceId,
      ...(capture.projectId ? { projectId: capture.projectId } : {}),
      date,
      ...(time !== null ? { time } : {}),
      ...(reminderOffsets.length > 0 ? { reminderOffsets } : {}),
    });
    if (!result.ok) return { ok: false, error: result.error === 'empty-title' ? 'title-empty' : 'failed' };

    const task = result.value;
    container.undo.push(createCaptureUndoCommand(container, [task], undoLabelFor(task.spaceId, task.title)));
    return { ok: true, task };
  } catch {
    return { ok: false, error: 'failed' };
  }
}

/** Libellé du message d'un lot (« 4 tâches créées ») ; une seule tâche : « « Titre » ajoutée ». */
export function batchUndoLabel(created: readonly Task[]): Pick<UndoableCommand, 'labelKey' | 'labelParams'> {
  const only = created[0];
  if (created.length === 1 && only) return { labelKey: 'capture.undo.created', labelParams: { title: only.title } };
  return { labelKey: 'capture.undo.createdMany', labelParams: { count: created.length } };
}

/** Texte annoncé dans la mini-fenêtre après un enchaînement (Ctrl+Entrée). */
export function addedMessage(title: string): string {
  return t('capture.window.added', { title });
}
