import {
  APPLE_REMINDERS_DEVICE,
  appleLinkState,
  isFollowed,
  massDeletionBlocked,
  MAX_NOTICES,
  MAX_REMINDERS_PER_LIST,
  mergeLinked,
  parseAppleCreate,
  parseAppleLists,
  parseLastPassAt,
  sameAppleValues,
  syntheticHlc,
  taskScheduleOf,
  valuesOfItem,
  valuesOfTask,
  type AppleCreateSetting,
  type AppleListSetting,
  type AppleListsSetting,
  type AppleNoticeKind,
  type AppleValues,
  type MergeResult,
  type ReminderItem,
  type ReminderList,
} from '../../../domain/appleReminders';
import { nowIso } from '../../../domain/clock';
import { parseHlc } from '../../../domain/hlc';
import { newEntityId } from '../../../domain/id';
import type { NewTask, Task } from '../../../domain/model';
import type { Hlc, IsoDateTime, SpaceId, TaskId } from '../../../domain/types';
import type { AppleReminderLink, TaskFieldClocks } from '../../../db/repositories';
import { t } from '../../../i18n';
import { logFailure } from '../../../platform/desktop/log';
import { RemindersError } from '../../../platform/reminders';
import type { AppContainer } from '../../app/container';
import { applyRemoteChanges } from '../../sync/remoteChanges';
import { applyValuesToTask } from './appleTaskWrites';
import { appleRemindersState } from './appleRemindersState';

/**
 * Passage des Rappels Apple (K-05 lecture, K-06 écriture ; ADR 0008 §10.5 à §10.8) : à l'ouverture, à la reprise, sur `changed`, après
 * une synchro reçue et au passage en arrière-plan (`full`), et après une écriture locale d'une tâche liée (`push`, différences locales
 * seulement). Il lit les listes affichées (500 rappels non terminés au plus par liste) et les rappels déjà liés (par identifiant),
 * importe les nouveaux comme tâches (espace de la liste, « Un jour » sans échéance), met à jour les tâches liées par champ (un seul côté
 * a changé : il gagne ; les deux : le plus récent, la valeur perdue au journal des conflits), termine, détache ou supprime selon ce que
 * Rappels dit, et ne supprime JAMAIS sur un échec de lecture, un accès autre que complet, une liste absente, une tâche sans lien sur cet
 * appareil ou une suppression massive (garde `massDeletionBlocked`).
 *
 * Les écritures de la tâche se font par les repositories, dans une transaction (jamais de SQL ici), et sont publiées par la synchro
 * (visibles sur le PC, K-07). Le passage ne pose pas `sync_guard`. Les écritures VERS Rappels (modifications, créations, suppressions)
 * sont confiées à `options.send` (`remindersWrites.ts`) ; sans lui elles restent dues : l'empreinte garde alors la valeur que Rappels
 * porte encore et le nombre est rendu dans `pending`.
 */

export type PassKind = 'full' | 'push';

export interface PassReport {
  readonly status: 'done' | 'skipped' | 'failed';
  readonly reason?: 'unavailable' | 'not-determined';
  readonly code?: string;
  /** Tâches créées depuis Rappels. */
  readonly created: number;
  /** Tâches modifiées (titre, échéance, statut) depuis Rappels. */
  readonly updated: number;
  /** Tâches mises à la corbeille (rappel supprimé, liste décochée). */
  readonly deleted: number;
  /** Tâches détachées de Rappels et gardées. */
  readonly detached: number;
  /** Écritures faites vers Rappels (K-06). */
  readonly sent: number;
  /** Écritures dues vers Rappels non faites. */
  readonly pending: number;
}

export const EMPTY_REPORT: PassReport = { status: 'done', created: 0, updated: 0, deleted: 0, detached: 0, sent: 0, pending: 0 };

/** Une écriture due vers Rappels (K-06) : la tâche liée, son lien, le rappel lu, ce qui diffère et les valeurs communes après envoi. */
export interface DueWrite {
  readonly task: Task;
  readonly link: AppleReminderLink | null;
  readonly item: ReminderItem;
  readonly toApple: MergeResult['toApple'];
  readonly next: AppleValues;
}

/** Ce que le passage donne à l'écrivain : écritures de champs dues, réglages, listes d'Apple, tâches et liens lus. */
export interface SendContext {
  readonly kind: PassKind;
  readonly due: readonly DueWrite[];
  readonly lists: AppleListsSetting;
  readonly create: AppleCreateSetting;
  readonly platformLists: readonly ReminderList[];
  readonly tasks: readonly Task[];
  readonly links: readonly AppleReminderLink[];
  readonly nowMs: number;
}

export interface SendResult {
  /** Écritures faites vers Rappels (champs, créations, suppressions). */
  readonly sent: number;
  /** Écritures restées dues. */
  readonly pending: number;
  /** Premier code d'échec (jamais un titre) ; null sans échec. */
  readonly code: string | null;
  /** Tâches changées par l'écrivain (lien posé, détachement) : à republier. */
  readonly touched: readonly TaskId[];
  /** Messages à inscrire (type, nombre). */
  readonly notices: readonly { readonly kind: AppleNoticeKind; readonly count: number }[];
  /** La création dans Rappels a été désactivée pour ces espaces (liste de destination disparue). */
  readonly createOff: boolean;
}

export type SendDue = (context: SendContext) => Promise<SendResult>;

export interface PassOptions {
  /** Envoi des écritures dues (K-06) ; absent : elles restent dues. */
  readonly send?: SendDue;
  /**
   * Échéance (ms, horloge du conteneur) du passage lancé au masquage de l'iPhone (ADR 0008 §10.8, 8 s) : une fois dépassée, le passage n'entame
   * plus de tâche ni de paquet ; rien n'est perdu (transactions par paquets de 100 tâches, liens écrits avec les tâches), la reprise est à l'ouverture.
   */
  readonly deadlineAt?: number;
}

const CHUNK = 100;
const hlcMs = (hlc: Hlc): number => Number(hlc.slice(0, 15));

/** Valeurs communes après la lecture : celles de `next`, sauf les champs restés dus vers Rappels, qui gardent la valeur que Rappels porte encore. */
function withDueKept(next: AppleValues, toApple: MergeResult['toApple'], item: AppleValues): AppleValues {
  const kept: Record<string, unknown> = { ...next };
  const apple = item as unknown as Record<string, unknown>;
  for (const field of Object.keys(toApple)) kept[field] = apple[field];
  if ('completed' in toApple) kept['doneAt'] = apple['doneAt'];
  return kept as unknown as AppleValues;
}

function toLink(task: Task, item: ReminderItem, synced: AppleValues | null, previous: AppleReminderLink | null): AppleReminderLink {
  return { taskId: task.id, reminderId: item.id, externalRef: item.externalRef, listId: item.listId, state: 'linked', synced, appleModified: item.modifiedAt, startedAt: previous?.startedAt ?? null };
}

const sameLink = (a: AppleReminderLink | null, b: AppleReminderLink): boolean =>
  a !== null && a.state === b.state && a.reminderId === b.reminderId && a.externalRef === b.externalRef && a.listId === b.listId && a.appleModified === b.appleModified && JSON.stringify(a.synced) === JSON.stringify(b.synced);

export async function runRemindersPass(container: AppContainer, kind: PassKind, options: PassOptions = {}): Promise<PassReport> {
  if (!container.reminders.available) return { ...EMPTY_REPORT, status: 'skipped', reason: 'unavailable' };
  const state = appleRemindersState(container);
  try {
    await state.load();
    return await passBody(container, kind, options);
  } catch (error) {
    // Aucun échec silencieux : tout rejet du plugin et toute exception d'un passage sont écrits (code, heure ; jamais un titre).
    const code = error instanceof RemindersError ? error.code : 'pass-failed';
    logFailure(APPLE_REMINDERS_DEVICE, `pass-failed ${code}`);
    await state.fail(code);
    return { ...EMPTY_REPORT, status: 'failed', code };
  }
}

async function passBody(container: AppContainer, kind: PassKind, options: PassOptions): Promise<PassReport> {
  const platform = container.reminders;
  const state = appleRemindersState(container);
  const nowMs = container.clock.nowMs();
  const now = nowIso(container.clock);
  const repos = container.data.repos;
  const full = kind === 'full';

  const access = await platform.status();
  state.setObserved(access);
  if (access === 'not-determined') return { ...EMPTY_REPORT, status: 'skipped', reason: 'not-determined' };
  if (access !== 'full') {
    await state.fail('access-denied');
    return { ...EMPTY_REPORT, status: 'failed', code: 'access-denied' };
  }

  const settings = repos.settings;
  const lists = parseAppleLists(await settings.get('appleReminders.lists'));
  const create = parseAppleCreate(await settings.get('appleReminders.create'));
  const lastPassAt = parseLastPassAt(await settings.get('appleReminders.lastPassAt'));
  const shown = lists.lists.filter((list): list is AppleListSetting & { spaceId: SpaceId } => list.shown && list.spaceId !== null);
  const shownById = new Map(shown.map((list) => [list.id, list]));

  // Noms lisibles : les listes connues gardent le nom que Rappels leur donne (le PC les affiche).
  const platformLists = await platform.lists();
  state.setObserved(access, platformLists);
  const renamed = lists.lists.map((list) => {
    const live = platformLists.find((candidate) => candidate.id === list.id);
    return live && live.name !== list.name ? { ...list, name: live.name.slice(0, 200) } : list;
  });
  if (JSON.stringify(renamed) !== JSON.stringify(lists.lists)) await state.setLists({ lists: renamed });

  const tasks = await repos.tasks.listAppleSourced();
  const links = await repos.appleLinks.listAll();
  const linkByTask = new Map(links.map((link) => [link.taskId, link]));
  const linkedTasks = tasks.filter((task) => appleLinkState(task) === 'linked');
  const localDiffers = (task: Task): boolean => {
    const link = linkByTask.get(task.id);
    return link?.synced != null && !sameAppleValues(valuesOfTask(task), link.synced);
  };
  // `push` : seulement les tâches dont une valeur locale diffère de l'empreinte ; `full` : toutes les tâches suivies.
  const followed = linkedTasks.filter((task) => (full ? isFollowed(task, nowMs, lastPassAt) : localDiffers(task)));

  const result = await platform.fetch({
    listIds: full ? shown.map((list) => list.id) : [],
    limitPerList: MAX_REMINDERS_PER_LIST,
    ids: followed.map((task) => ({ id: task.externalId as string, externalRef: linkByTask.get(task.id)?.externalRef ?? null })),
  });

  const itemById = new Map<string, ReminderItem>();
  const itemByRef = new Map<string, ReminderItem>();
  const remember = (item: ReminderItem): void => {
    itemById.set(item.id, item);
    if (item.externalRef !== null) itemByRef.set(item.externalRef, item);
  };
  for (const list of result.lists) list.items.forEach(remember);
  result.byId.forEach(remember);
  const missingLists = new Set(result.missingLists);

  const report = { created: 0, updated: 0, deleted: 0, detached: 0, sent: 0, pending: 0 };
  const touched = new Set<TaskId>();
  const notices = new Map<AppleNoticeKind, number>();
  const notice = (kind: AppleNoticeKind, count = 1): void => void notices.set(kind, (notices.get(kind) ?? 0) + count);
  const absentByList = new Map<string, Task[]>();
  const dueWrites: DueWrite[] = [];
  let unknown = 0;
  const matchedItemIds = new Set<string>();
  const late = (): boolean => options.deadlineAt !== undefined && container.clock.nowMs() > options.deadlineAt;
  let partial = false;
  const clocks = await repos.appleLinks.fieldClocks(followed.map((task) => task.id));

  for (const task of followed) {
    if (late()) {
      partial = true;
      break;
    }
    const link = linkByTask.get(task.id) ?? null;
    const item = itemById.get(task.externalId as string) ?? (link?.externalRef ? itemByRef.get(link.externalRef) : undefined);
    const listId = task.appleListId ?? item?.listId ?? null;
    if (listId === null) {
      unknown += 1;
      continue;
    }
    const owning = shownById.get(listId);

    // Liste décochée ou espace retiré (lecture complète seulement) : règle de la liste décochée.
    if (owning === undefined) {
      if (!full || missingLists.has(listId)) continue;
      const outcome = await unlinkTask(container, task, link, item ?? null);
      if (outcome === 'deleted') {
        report.deleted += 1;
        notice('unlinked-list');
      } else if (outcome === 'detached') {
        report.detached += 1;
        notice('detached');
      }
      if (outcome !== 'skipped') touched.add(task.id);
      if (item) matchedItemIds.add(item.id);
      continue;
    }

    if (!item) {
      // Introuvable : seule une lecture complète et réussie, accès complet, liste présente, peut conclure à une suppression.
      if (!full || missingLists.has(listId)) continue;
      if (link === null) {
        // Sans lien sur cet appareil : identifiant inconnu ici, compté et visible, jamais supprimé (ADR 0008 §10.6).
        unknown += 1;
        continue;
      }
      const group = absentByList.get(listId) ?? [];
      group.push(task);
      absentByList.set(listId, group);
      continue;
    }
    matchedItemIds.add(item.id);

    // Rappel déplacé dans une liste non affichée : règle de la liste décochée.
    if (item.listId !== listId && !shownById.has(item.listId)) {
      if (!full) continue;
      const outcome = await unlinkTask(container, task, link, item);
      if (outcome === 'deleted') {
        report.deleted += 1;
        notice('unlinked-list');
      } else if (outcome === 'detached') {
        report.detached += 1;
        notice('detached');
      }
      if (outcome !== 'skipped') touched.add(task.id);
      continue;
    }

    const itemValues = valuesOfItem(item, t('appleReminders.untitled'));
    const fieldClocks = clocks.get(task.id) ?? null;
    const merged = mergeLinked({
      task: valuesOfTask(task),
      carriedOver: task.carriedOver,
      item: itemValues,
      synced: link?.synced ?? null,
      appleModifiedMs: item.modifiedAt === null ? null : Date.parse(item.modifiedAt),
      localMs: {
        title: fieldClocks ? hlcMs(fieldClocks.title) : null,
        date: fieldClocks ? hlcMs(fieldClocks.date) : null,
        time: fieldClocks ? hlcMs(fieldClocks.time) : null,
        status: fieldClocks ? hlcMs(fieldClocks.status) : null,
      },
      locked: item.recurring,
    });

    const change = await applyRead(container, task, link, item, merged, fieldClocks, now);
    if (change.skipped) continue;
    if (change.applied !== null) {
      touched.add(task.id);
      if (change.changedTask) report.updated += 1;
    }
    if (item.recurring && merged.conflicts.length > 0) notice('recurring-refused');
    if (!item.recurring && Object.keys(merged.toApple).length > 0) dueWrites.push({ task: change.applied ?? task, link: change.link, item, toApple: merged.toApple, next: merged.next });
  }

  const held: { listId: string; count: number; at: IsoDateTime }[] = [];
  if (full && !partial) {
    // Rappels absents : suppression douce et détachement, sous la garde de suppression massive.
    for (const [listId, absent] of absentByList) {
      const total = linkedTasks.filter((task) => task.appleListId === listId).length;
      if (massDeletionBlocked(total, absent.length)) {
        held.push({ listId, count: absent.length, at: now });
        continue;
      }
      for (const task of absent) {
        if (await removeAbsent(container, task, linkByTask.get(task.id) ?? null, now)) {
          report.deleted += 1;
          notice('deleted');
          touched.add(task.id);
        }
      }
    }

    // Import : rappels non terminés des listes affichées qui n'ont ni tâche ni lien.
    const linkedReminderIds = new Set(links.map((link) => link.reminderId).filter((id): id is string => id !== null));
    const knownExternalIds = new Set(tasks.map((task) => task.externalId).filter((id): id is string => id !== null));
    const toImport: { item: ReminderItem; list: AppleListSetting & { spaceId: SpaceId } }[] = [];
    for (const fetched of result.lists) {
      const list = shownById.get(fetched.listId);
      if (!list) continue;
      for (const item of fetched.items) {
        if (item.completed || matchedItemIds.has(item.id) || knownExternalIds.has(item.id) || linkedReminderIds.has(item.id)) continue;
        toImport.push({ item, list });
      }
    }
    for (let start = 0; start < toImport.length; start += CHUNK) {
      if (late()) {
        partial = true;
        break;
      }
      const created = await importChunk(container, toImport.slice(start, start + CHUNK), nowMs);
      report.created += created.length;
      created.forEach((task) => touched.add(task.id));
    }
  }

  // Écritures dues vers Rappels (K-06) : confiées à `send` ; sans lui, elles restent dues et comptées.
  let sendCode: string | null = null;
  if (options.send) {
    const sent = await options.send({ kind, due: dueWrites, lists, create, platformLists, tasks, links, nowMs });
    report.sent += sent.sent;
    report.pending += sent.pending;
    sendCode = sent.code;
    sent.touched.forEach((id) => touched.add(id));
    for (const entry of sent.notices) notice(entry.kind, entry.count);
    if (sent.createOff) notice('creation-off');
  } else {
    report.pending += dueWrites.length;
  }

  if (touched.size > 0) await applyRemoteChanges(container, { tables: new Set(['task']), ids: new Map([['task', new Set(touched)]]) });

  const caps = full && !partial ? result.lists.filter((entry) => entry.total > entry.items.length).map((entry) => ({ listId: entry.listId, total: entry.total, imported: entry.items.length })) : null;
  await state.patchStatus((current) => {
    let notes = current.notices;
    for (const [kind, count] of notices) {
      const previous = notes.find((entry) => entry.kind === kind);
      notes = [{ kind, count: count + (previous?.count ?? 0), at: now }, ...notes.filter((entry) => entry.kind !== kind)].slice(0, MAX_NOTICES);
    }
    return {
      ...current,
      ...(caps === null ? {} : { caps, held, unknown, missingLists: [...missingLists] }),
      notices: notes,
      failure: sendCode === null ? null : { code: sendCode, at: now, write: true as const },
    };
  });
  await state.setPending(report.pending);
  // Une écriture au plus tous les 15 minutes (K-05 critère 14), sauf quand le passage a envoyé des écritures vers Rappels (K-07 D2) ; un passage
  // `push` qui a envoyé quelque chose compte aussi : le PC doit voir que ses modifications sont parties.
  if ((full && !partial) || report.sent > 0) await state.setLastPassAt(now, nowMs, report.sent > 0);
  return { ...EMPTY_REPORT, ...report, status: 'done' };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Écritures de la tâche
// ---------------------------------------------------------------------------------------------------------------------------------

interface ReadChange {
  /** La tâche a changé depuis la lecture : rien n'a été écrit, le passage suivant la reprendra. */
  readonly skipped: boolean;
  /** La tâche relue après écriture ; null : rien n'a été écrit dans la tâche. */
  readonly applied: Task | null;
  /** Une valeur de la tâche a changé (titre, échéance, statut). */
  readonly changedTask: boolean;
  readonly link: AppleReminderLink | null;
}

/** Applique à la tâche ce que Rappels a gagné, met à jour le lien (empreinte, date de modification) et journalise les conflits, en une transaction. */
async function applyRead(container: AppContainer, task: Task, link: AppleReminderLink | null, item: ReminderItem, merged: MergeResult, clocks: TaskFieldClocks | null, now: IsoDateTime): Promise<ReadChange> {
  const nextSynced = withDueKept(merged.next, merged.toApple, valuesOfItem(item, t('appleReminders.untitled')));
  return container.data.transaction(async (repos): Promise<ReadChange> => {
    // La tâche a pu être modifiée depuis la lecture : on ne l'écrase pas, le passage suivant la reprendra.
    const current = await repos.tasks.getById(task.id);
    if (!current || current.hlc !== task.hlc) return { skipped: true, applied: null, changedTask: false, link };
    const toTask = merged.toTask;
    let written = await applyValuesToTask(repos, current, toTask, now);
    // Récurrence, liste d'origine et identifiant (changé par EventKit) suivent Rappels.
    if (current.appleRecurring !== item.recurring || current.appleListId !== item.listId || current.externalId !== item.id) {
      written = await repos.tasks.setAppleLink(task.id, { source: 'apple_reminders', externalId: item.id, appleListId: item.listId, appleRecurring: item.recurring });
    }
    const updatedLink = toLink(task, item, nextSynced, link);
    if (!sameLink(link, updatedLink)) await repos.appleLinks.upsert(updatedLink);
    if (merged.conflicts.length > 0) {
      await repos.sync.insertConflicts(
        merged.conflicts.map((conflict) => {
          const localHlc = clocks ? clocks[conflict.field] : current.hlc;
          const appleMs = conflict.winner === 'apple' ? (item.modifiedAt === null ? null : Date.parse(item.modifiedAt)) : conflict.discardedAtMs;
          const appleHlc = syntheticHlc(appleMs);
          const localDevice = parseHlc(localHlc).deviceId;
          return {
            table: 'task',
            rowId: task.id,
            field: conflict.field,
            keptValue: conflict.kept,
            discardedValue: conflict.discarded,
            keptDevice: conflict.winner === 'apple' ? APPLE_REMINDERS_DEVICE : localDevice,
            discardedDevice: conflict.winner === 'apple' ? localDevice : APPLE_REMINDERS_DEVICE,
            keptHlc: conflict.winner === 'apple' ? appleHlc : localHlc,
            discardedHlc: conflict.winner === 'apple' ? localHlc : appleHlc,
          };
        }),
        now,
      );
    }
    return { skipped: false, applied: written, changedTask: Object.keys(toTask).length > 0, link: updatedLink };
  });
}

/** Liste décochée : tâche non modifiée localement depuis le dernier passage → corbeille et détachement ; sinon détachée et gardée. */
async function unlinkTask(container: AppContainer, task: Task, link: AppleReminderLink | null, item: ReminderItem | null): Promise<'deleted' | 'detached' | 'skipped'> {
  return container.data.transaction(async (repos) => {
    const current = await repos.tasks.getById(task.id);
    if (!current || current.hlc !== task.hlc) return 'skipped';
    // « Non modifiée localement » : l'empreinte du dernier passage est connue et égale aux valeurs de la tâche.
    const unchanged = link?.synced != null && sameAppleValues(valuesOfTask(current), link.synced);
    await repos.tasks.setAppleLink(task.id, { source: 'local', externalId: null, appleListId: current.appleListId ?? item?.listId ?? null, appleRecurring: false });
    if (unchanged) await repos.tasks.softDelete([task.id]);
    await repos.appleLinks.remove(task.id);
    return unchanged ? 'deleted' : 'detached';
  });
}

/** Rappel supprimé dans Rappels : corbeille ET détachement dans la même écriture ; conflit sur `deleted_at` si la tâche avait des changements locaux non envoyés. */
async function removeAbsent(container: AppContainer, task: Task, link: AppleReminderLink | null, now: IsoDateTime): Promise<boolean> {
  return container.data.transaction(async (repos) => {
    const current = await repos.tasks.getById(task.id);
    if (!current || current.hlc !== task.hlc) return false;
    const localChanges = link?.synced != null && !sameAppleValues(valuesOfTask(current), link.synced);
    await repos.tasks.setAppleLink(task.id, { source: 'local', externalId: null, appleListId: current.appleListId, appleRecurring: false });
    await repos.tasks.softDelete([task.id]);
    await repos.appleLinks.remove(task.id);
    if (localChanges) {
      // La suppression gagne ; la tâche reste restaurable 30 jours (ADR 0011 §4.2) : la trace dit qu'elle avait des changements locaux.
      await repos.sync.insertConflicts(
        [{ table: 'task', rowId: task.id, field: 'deleted_at', keptValue: now, discardedValue: null, keptDevice: APPLE_REMINDERS_DEVICE, discardedDevice: parseHlc(current.hlc).deviceId, keptHlc: syntheticHlc(Date.parse(now)), discardedHlc: current.hlc }],
        now,
      );
    }
    return true;
  });
}

/** Crée les tâches d'un paquet de rappels (tâche et lien dans une même transaction ; idempotent par identifiant de rappel). */
async function importChunk(container: AppContainer, chunk: readonly { item: ReminderItem; list: AppleListSetting & { spaceId: SpaceId } }[], nowMs: number): Promise<Task[]> {
  return container.data.transaction(async (repos) => {
    const created: Task[] = [];
    let offset = 0;
    for (const { item, list } of chunk) {
      // Une tâche vivante de même identifiant (reçue de la synchro) : lien reconstruit plutôt que doublon.
      const existing = await repos.tasks.findByExternalId(item.id);
      if (existing) {
        await repos.appleLinks.upsert(toLink(existing, item, null, null));
        continue;
      }
      const values = valuesOfItem(item, t('appleReminders.untitled'));
      const schedule = taskScheduleOf(values);
      const newTask: NewTask = {
        id: newEntityId<TaskId>(container.ids),
        spaceId: list.spaceId,
        projectId: null,
        title: values.title,
        note: '',
        date: schedule.date,
        time: schedule.time,
        status: 'todo',
        doneAt: null,
        sortOrder: nowMs + offset,
        carriedOver: false,
        recurrenceId: null,
        seriesIndex: null,
        seriesTemplate: null,
        goalId: null,
        icon: null,
        someday: schedule.someday,
        source: 'apple_reminders',
        externalId: item.id,
        appleListId: list.id,
        appleRecurring: item.recurring,
        externalEventId: null,
      };
      offset += 1;
      const task = await repos.tasks.create(newTask);
      await repos.appleLinks.upsert(toLink(task, item, values, null));
      created.push(task);
    }
    return created;
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Suppression retenue par la garde (ADR 0008 §10.6) : le geste de l'utilisateur
// ---------------------------------------------------------------------------------------------------------------------------------

export type HeldChoice = 'delete' | 'keep';

/**
 * « {n} rappels sont absents de Rappels. Supprimer les tâches liées ? » : « Supprimer » met à la corbeille ET détache les tâches dont le
 * rappel est toujours absent (relu à l'instant), « Garder et détacher » les détache sans les supprimer. Rien n'est fait si la lecture
 * échoue, si l'accès n'est pas complet ou si la liste a disparu (jamais de suppression sur un doute) ; l'entrée « retenue » est alors gardée.
 */
export async function resolveHeldList(container: AppContainer, listId: string, choice: HeldChoice): Promise<PassReport> {
  if (!container.reminders.available) return { ...EMPTY_REPORT, status: 'skipped', reason: 'unavailable' };
  const state = appleRemindersState(container);
  try {
    await state.load();
    const now = nowIso(container.clock);
    if ((await container.reminders.status()) !== 'full') {
      await state.fail('access-denied');
      return { ...EMPTY_REPORT, status: 'failed', code: 'access-denied' };
    }
    const repos = container.data.repos;
    const present = (await container.reminders.lists()).some((list) => list.id === listId);
    const tasks = (await repos.tasks.listAppleSourced()).filter((task) => appleLinkState(task) === 'linked' && task.appleListId === listId);
    const links = new Map((await repos.appleLinks.listAll()).map((link) => [link.taskId, link]));
    const read = await container.reminders.fetch({ listIds: [], limitPerList: MAX_REMINDERS_PER_LIST, ids: tasks.map((task) => ({ id: task.externalId as string, externalRef: links.get(task.id)?.externalRef ?? null })) });
    const gone = new Set(read.missing);
    const absent = present ? tasks.filter((task) => gone.has(task.externalId as string) && links.has(task.id)) : [];
    let deleted = 0;
    let detached = 0;
    const touched = new Set<TaskId>();
    for (const task of absent) {
      if (choice === 'delete') {
        if (await removeAbsent(container, task, links.get(task.id) ?? null, now)) {
          deleted += 1;
          touched.add(task.id);
        }
      } else if (await detachOnly(container, task)) {
        detached += 1;
        touched.add(task.id);
      }
    }
    if (touched.size > 0) await applyRemoteChanges(container, { tables: new Set(['task']), ids: new Map([['task', new Set(touched)]]) });
    if (present) {
      await state.patchStatus((current) => {
        const kind: AppleNoticeKind = choice === 'delete' ? 'deleted' : 'detached';
        const count = choice === 'delete' ? deleted : detached;
        const previous = current.notices.find((entry) => entry.kind === kind);
        return {
          ...current,
          held: current.held.filter((entry) => entry.listId !== listId),
          notices: count === 0 ? current.notices : [{ kind, count: count + (previous?.count ?? 0), at: now }, ...current.notices.filter((entry) => entry.kind !== kind)].slice(0, MAX_NOTICES),
        };
      });
    }
    return { ...EMPTY_REPORT, deleted, detached };
  } catch (error) {
    const code = error instanceof RemindersError ? error.code : 'pass-failed';
    logFailure(APPLE_REMINDERS_DEVICE, `held-failed ${code}`);
    await state.fail(code);
    return { ...EMPTY_REPORT, status: 'failed', code };
  }
}

/** Détache sans supprimer (« Garder et détacher ») : tâche ordinaire qui garde sa liste, lien local retiré. */
async function detachOnly(container: AppContainer, task: Task): Promise<boolean> {
  return container.data.transaction(async (repos) => {
    const current = await repos.tasks.getById(task.id);
    if (!current || current.hlc !== task.hlc) return false;
    await repos.tasks.setAppleLink(task.id, { source: 'local', externalId: null, appleListId: current.appleListId, appleRecurring: false });
    await repos.appleLinks.remove(task.id);
    return true;
  });
}
