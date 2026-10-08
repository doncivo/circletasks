import {
  appleLinkState,
  createTargetFor,
  sameAppleValues,
  valuesOfItem,
  valuesOfTask,
  type AppleNoticeKind,
  type AppleValues,
  type MergeResult,
  type ReminderItem,
  type ReminderList,
} from '../../../domain/appleReminders';
import { nowIso } from '../../../domain/clock';
import type { Task } from '../../../domain/model';
import type { TaskId } from '../../../domain/types';
import type { AppleReminderLink } from '../../../db/repositories';
import { t } from '../../../i18n';
import { logFailure } from '../../../platform/desktop/log';
import { RemindersError, type UpsertInput } from '../../../platform/reminders';
import type { AppContainer } from '../../app/container';
import { applyValuesToTask } from './appleTaskWrites';
import { appleRemindersState } from './appleRemindersState';
import type { DueWrite, SendContext, SendDue, SendResult } from './remindersPass';

/**
 * Écritures VERS Rappels (K-06, ADR 0008 §10.5, §10.7, §10.8) : modifications dues d'une tâche liée (titre, échéance, statut terminé),
 * création d'un rappel pour une tâche « à créer » (réglage par espace, désactivé par défaut) et suppression du rappel d'une tâche supprimée.
 * Aucune file séparée : les écritures dues sont DÉRIVÉES à chaque passage (différences tâche / empreinte, tâches « à créer », tâches
 * supprimées dont le lien subsiste) ; elles survivent donc au redémarrage et ne sont jamais abandonnées. Après chaque écriture, l'empreinte et
 * `apple_modified` reçoivent l'élément RELU rendu par le plugin (anti-boucle : le passage suivant ne voit aucune différence). Jamais de
 * titre dans un journal ni dans l'état local : des codes et des nombres.
 */

interface Tally {
  sent: number;
  pending: number;
  code: string | null;
  readonly touched: Set<TaskId>;
  readonly notices: Map<AppleNoticeKind, number>;
  createOff: boolean;
  /** Échec qui vaudra pour tous les envois suivants (accès, magasin) : on n'insiste pas. */
  stop: boolean;
}

/** Codes qui ne se résolvent pas en réessayant dans le même passage. */
const GLOBAL_FAILURES: readonly string[] = ['access-denied', 'store-unavailable'];

const dueOf = (values: Pick<AppleValues, 'date' | 'time'>): UpsertInput['due'] => (values.date === null ? null : { date: values.date, time: values.time });

export function createSender(container: AppContainer): SendDue {
  return async (context) => {
    const tally: Tally = { sent: 0, pending: 0, code: null, touched: new Set(), notices: new Map(), createOff: false, stop: false };
    await sendDueFields(container, context, tally);
    if (!tally.stop) await sendCreations(container, context, tally);
    if (!tally.stop) await sendDeletions(container, context, tally);
    const result: SendResult = { sent: tally.sent, pending: tally.pending, code: tally.code, touched: [...tally.touched], notices: [...tally.notices].map(([kind, count]) => ({ kind, count })), createOff: tally.createOff };
    return result;
  };
}

const note = (tally: Tally, kind: AppleNoticeKind, count = 1): void => void tally.notices.set(kind, (tally.notices.get(kind) ?? 0) + count);

/** Un échec d'écriture : code retenu (le premier), écriture comptée comme due, échec global = on s'arrête. */
function failed(tally: Tally, error: unknown): string {
  const code = error instanceof RemindersError ? error.code : 'pass-failed';
  logFailure('apple-reminders', `write-failed ${code}`);
  tally.code ??= code;
  tally.pending += 1;
  if (GLOBAL_FAILURES.includes(code)) tally.stop = true;
  return code;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Modifications dues d'une tâche liée
// ---------------------------------------------------------------------------------------------------------------------------------

const onlyStatus = (toApple: MergeResult['toApple']): boolean => Object.keys(toApple).every((key) => key === 'completed' || key === 'doneAt');

async function sendDueFields(container: AppContainer, context: SendContext, tally: Tally): Promise<void> {
  const platform = container.reminders;
  for (const write of context.due) {
    if (tally.stop) {
      tally.pending += 1;
      continue;
    }
    try {
      const item = onlyStatus(write.toApple)
        ? await platform.setCompleted({ id: write.item.id, completed: write.next.completed, completedAt: write.next.doneAt })
        : await platform.upsert({ id: write.item.id, listId: write.item.listId, title: write.next.title, due: dueOf(write.next), completed: write.next.completed, completedAt: write.next.doneAt });
      await recordWritten(container, write, item);
      tally.sent += 1;
      tally.touched.add(write.task.id);
    } catch (error) {
      const code = error instanceof RemindersError ? error.code : '';
      if (code === 'not-found') {
        // Rappel disparu entre la lecture et l'écriture : la tâche est détachée (jamais supprimée), avec message.
        await detach(container, write.task);
        note(tally, 'detached');
        tally.touched.add(write.task.id);
      } else if (code === 'recurring-refused') {
        // Rappel récurrent que la tâche croyait ordinaire : verrouillé ; le prochain passage complet remplace la valeur locale.
        await container.data.transaction((repos) => repos.tasks.setAppleLink(write.task.id, { source: 'apple_reminders', externalId: write.task.externalId, appleListId: write.task.appleListId, appleRecurring: true }));
        note(tally, 'recurring-refused');
        tally.touched.add(write.task.id);
      } else {
        if (code === 'read-only-list') note(tally, 'read-only-list');
        failed(tally, error);
      }
    }
  }
}

/** Empreinte et date de modification de l'élément RELU ; si Rappels a normalisé une valeur, la tâche l'adopte (les deux côtés restent égaux). */
async function recordWritten(container: AppContainer, write: DueWrite, written: ReminderItem): Promise<void> {
  const readBack = valuesOfItem(written, t('appleReminders.untitled'));
  const now = nowIso(container.clock);
  await container.data.transaction(async (repos) => {
    const current = await repos.tasks.getById(write.task.id);
    // Tâche modifiée depuis la lecture : l'empreinte suit le rappel, la différence repartira au passage suivant.
    if (current && current.hlc === write.task.hlc && !sameAppleValues(readBack, write.next)) {
      await applyValuesToTask(repos, current, { ...(readBack.title !== write.next.title ? { title: readBack.title } : {}), ...(readBack.date !== write.next.date ? { date: readBack.date } : {}), ...(readBack.time !== write.next.time ? { time: readBack.time } : {}), ...(readBack.completed !== write.next.completed ? { completed: readBack.completed, doneAt: readBack.doneAt } : {}) }, now);
    }
    await repos.appleLinks.upsert({ taskId: write.task.id, reminderId: written.id, externalRef: written.externalRef, listId: written.listId, state: 'linked', synced: readBack, appleModified: written.modifiedAt, startedAt: write.link?.startedAt ?? null });
  });
}

async function detach(container: AppContainer, task: Task): Promise<void> {
  await container.data.transaction(async (repos) => {
    await repos.tasks.setAppleLink(task.id, { source: 'local', externalId: null, appleListId: task.appleListId, appleRecurring: false });
    await repos.appleLinks.remove(task.id);
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Création (réglage par espace, K-06 critères 5 et 6)
// ---------------------------------------------------------------------------------------------------------------------------------

/** Remet une tâche « à créer » à l'état ordinaire (réglage désactivé, liste disparue ou espace changé) : plus rien à envoyer. */
async function revertToOrdinary(container: AppContainer, task: Task): Promise<void> {
  await container.data.transaction(async (repos) => {
    await repos.tasks.setAppleLink(task.id, { source: 'local', externalId: null, appleListId: null, appleRecurring: false });
    await repos.appleLinks.remove(task.id);
  });
}

async function sendCreations(container: AppContainer, context: SendContext, tally: Tally): Promise<void> {
  const platform = container.reminders;
  const state = appleRemindersState(container);
  const waiting = context.tasks.filter((task) => appleLinkState(task) === 'to-create');
  if (waiting.length === 0) return;
  const linkOf = new Map(context.links.map((link) => [link.taskId, link]));
  const listsById = new Map<string, ReminderList>(context.platformLists.map((list) => [list.id, list]));
  const disabledLists = new Set<string>();
  for (const task of waiting) {
    if (tally.stop) {
      tally.pending += 1;
      continue;
    }
    const wanted = createTargetFor(task.spaceId, context.create, context.lists);
    const destination = task.appleListId as string;
    const vanished = !listsById.has(destination) || !context.lists.lists.some((list) => list.id === destination && list.shown);
    if (vanished) {
      // Liste de destination disparue ou décochée : réglage désactivé avec message, tâches remises à l'état ordinaire (K-06 critère 6).
      disabledLists.add(destination);
      await revertToOrdinary(container, task);
      tally.touched.add(task.id);
      tally.createOff = true;
      continue;
    }
    if (wanted !== destination) {
      // Réglage désactivé ou espace changé avant l'envoi : rien n'est créé, la tâche est ordinaire.
      await revertToOrdinary(container, task);
      tally.touched.add(task.id);
      continue;
    }
    const now = nowIso(container.clock);
    try {
      const adopted = await adoptInterrupted(container, task, linkOf.get(task.id) ?? null, destination, tally);
      let created: ReminderItem;
      if (adopted !== null) {
        created = adopted;
      } else {
        // Lien « création en cours » écrit AVANT l'appel : un arrêt entre l'appel et la fin se rattrape sans doublon (§10.7).
        await container.data.transaction((repos) => repos.appleLinks.upsert({ taskId: task.id, reminderId: null, externalRef: null, listId: destination, state: 'creating', synced: null, appleModified: null, startedAt: linkOf.get(task.id)?.startedAt ?? now }));
        created = await platform.upsert({ id: null, listId: destination, title: task.title, due: dueOf(valuesOfTask(task)), completed: task.status === 'done', completedAt: task.doneAt });
      }
      await container.data.transaction(async (repos) => {
        await repos.tasks.setAppleLink(task.id, { source: 'apple_reminders', externalId: created.id, appleListId: created.listId, appleRecurring: false });
        await repos.appleLinks.upsert({ taskId: task.id, reminderId: created.id, externalRef: created.externalRef, listId: created.listId, state: 'linked', synced: valuesOfItem(created, t('appleReminders.untitled')), appleModified: created.modifiedAt, startedAt: null });
      });
      tally.sent += 1;
      tally.touched.add(task.id);
    } catch (error) {
      const code = error instanceof RemindersError ? error.code : '';
      if (code === 'list-not-found') {
        disabledLists.add(destination);
        await revertToOrdinary(container, task);
        tally.touched.add(task.id);
        tally.createOff = true;
      } else {
        if (code === 'read-only-list') note(tally, 'read-only-list');
        failed(tally, error);
      }
    }
  }
  if (disabledLists.size > 0) {
    // Les règles dont la liste de destination a disparu sont désactivées (et le disent).
    const create = context.create;
    await state.setCreate({ bySpace: create.bySpace.map((rule) => (rule.listId !== null && disabledLists.has(rule.listId) ? { ...rule, enabled: false } : rule)) });
  }
}

/**
 * Reprise après un arrêt (lien « création en cours » sans identifiant) : un élément de même titre et même échéance créé après le début de
 * la création, dans la liste, est adopté (le plus ancien s'il y en a plusieurs ; les autres sont signalés, jamais supprimés).
 */
async function adoptInterrupted(container: AppContainer, task: Task, link: AppleReminderLink | null, listId: string, tally: Tally): Promise<ReminderItem | null> {
  if (link === null || link.state !== 'creating' || link.reminderId !== null || link.startedAt === null) return null;
  const started = Date.parse(link.startedAt);
  const values = valuesOfTask(task);
  const read = await container.reminders.fetch({ listIds: [listId], limitPerList: 500, ids: [] });
  const candidates = (read.lists.find((entry) => entry.listId === listId)?.items ?? [])
    .filter((item) => item.title.trim() === task.title.trim() && (item.due?.date ?? null) === values.date && (item.due?.time ?? null) === values.time && item.createdAt !== null && Date.parse(item.createdAt) >= started)
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id));
  // Un rappel déjà adopté par une autre tâche n'est pas un candidat.
  const taken = new Set((await container.data.repos.appleLinks.listAll()).map((entry) => entry.reminderId));
  const free = candidates.filter((item) => !taken.has(item.id));
  const [first, ...others] = free;
  if (first === undefined) return null;
  if (others.length > 0) note(tally, 'duplicate-created', others.length);
  return first;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Suppression (K-06 critère 7)
// ---------------------------------------------------------------------------------------------------------------------------------

async function sendDeletions(container: AppContainer, context: SendContext, tally: Tally): Promise<void> {
  const platform = container.reminders;
  const repos = container.data.repos;
  const alive = new Set(context.tasks.map((task) => task.id));
  const now = nowIso(container.clock);
  for (const link of context.links) {
    // Un lien « lié » dont la tâche n'est plus vivante (supprimée ici ou reçue de la synchro), ou un lien « suppression en cours » : à envoyer.
    if (link.state === 'creating') continue;
    if (link.state === 'linked' && alive.has(link.taskId)) continue;
    const task = await repos.tasks.getById(link.taskId, { includeDeleted: true });
    if (task !== null && task.deletedAt === null) continue; // tâche vivante hors de la liste (écartée) : rien à envoyer
    if (tally.stop) {
      tally.pending += 1;
      continue;
    }
    if (link.reminderId === null || task?.appleRecurring === true) {
      // Création interrompue puis tâche supprimée : rien n'existe. Rappel récurrent : jamais supprimé d'ici.
      await finishDeletion(container, task, link);
      continue;
    }
    try {
      if (link.state !== 'deleting') await container.data.transaction((tx) => tx.appleLinks.upsert({ ...link, state: 'deleting', startedAt: now }));
      await platform.delete({ id: link.reminderId });
      await finishDeletion(container, task, link);
      tally.sent += 1;
      if (task !== null) tally.touched.add(task.id);
    } catch (error) {
      const code = error instanceof RemindersError ? error.code : '';
      if (code === 'recurring-refused') {
        await finishDeletion(container, task, link);
        note(tally, 'recurring-refused');
      } else {
        if (code === 'read-only-list') note(tally, 'read-only-list');
        failed(tally, error);
      }
    }
  }
}

/** Fin d'une suppression : la tâche (même supprimée) est détachée, le lien retiré. */
async function finishDeletion(container: AppContainer, task: Task | null, link: AppleReminderLink): Promise<void> {
  await container.data.transaction(async (repos) => {
    if (task !== null) await repos.tasks.setAppleLink(task.id, { source: 'local', externalId: null, appleListId: task.appleListId ?? link.listId, appleRecurring: false });
    await repos.appleLinks.remove(link.taskId);
  });
}

