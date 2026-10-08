import {
  appleLinkState,
  createTargetFor,
  sameAppleValues,
  valuesOfItem,
  valuesOfTask,
  type AppleNoticeKind,
  type AppleValues,
  holdRemainingMs,
  massDeletionBlocked,
  type MergeResult,
  type ReminderItem,
  type ReminderList,
} from '../../../domain/appleReminders';
import { nowIso } from '../../../domain/clock';
import type { Task } from '../../../domain/model';
import type { IsoDateTime, TaskId } from '../../../domain/types';
import type { AppleReminderLink } from '../../../db/repositories';
import { t } from '../../../i18n';
import { logFailure } from '../../../platform/desktop/log';
import { RemindersError, type UpsertInput } from '../../../platform/reminders';
import type { AppContainer } from '../../app/container';
import { applyValuesToTask } from './appleTaskWrites';
import { appleRemindersState } from './appleRemindersState';
import { applyRemoteChanges } from '../../sync/remoteChanges';
import { EMPTY_REPORT, type DueWrite, type PassReport, type SendContext, type SendDue, type SendResult } from './remindersPass';

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
  /** Retenues de la garde de suppression massive (null : suppressions non évaluées). */
  held: SendResult['held'];
  /** Fenêtre d'annulation (T-13) : plus long temps restant parmi les écritures retenues. */
  holdMs: number;
  /** Échéance du passage (masquage de l'iPhone) ; absente : aucune. */
  deadlineAt?: number;
  /** Échec qui vaudra pour tous les envois suivants (accès, magasin) : on n'insiste pas. */
  stop: boolean;
}

/** Codes qui ne se résolvent pas en réessayant dans le même passage. */
const GLOBAL_FAILURES: readonly string[] = ['access-denied', 'store-unavailable'];

const dueOf = (values: Pick<AppleValues, 'date' | 'time'>): UpsertInput['due'] => (values.date === null ? null : { date: values.date, time: values.time });

export function createSender(container: AppContainer): SendDue {
  return async (context) => {
    const tally: Tally = { sent: 0, pending: 0, code: null, touched: new Set(), notices: new Map(), createOff: false, held: null, holdMs: 0, stop: false, ...(context.deadlineAt === undefined ? {} : { deadlineAt: context.deadlineAt }) };
    await sendDueFields(container, context, tally);
    if (!tally.stop) await sendCreations(container, context, tally);
    if (!tally.stop) await sendDeletions(container, context, tally);
    const result: SendResult = { sent: tally.sent, pending: tally.pending, code: tally.code, touched: [...tally.touched], notices: [...tally.notices].map(([kind, count]) => ({ kind, count })), createOff: tally.createOff, holdMs: tally.holdMs, held: tally.held };
    return result;
  };
}

/** Passage borné (masquage de l'iPhone) : plus aucune écriture n'est entamée après l'échéance ; elle reste due et comptée, la reprise est à l'ouverture suivante. */
function late(container: AppContainer, tally: Tally): boolean {
  if (tally.deadlineAt === undefined || container.clock.nowMs() <= tally.deadlineAt) return false;
  tally.pending += 1;
  return true;
}

/** Écriture retenue : la dernière écriture locale date de moins de 5 s (« Annuler » reste possible) ; elle reste due et un nouveau passage est demandé. */
function held(container: AppContainer, tally: Tally, at: IsoDateTime | null): boolean {
  const remaining = holdRemainingMs(at, container.clock.nowMs());
  if (remaining === 0) return false;
  tally.pending += 1;
  tally.holdMs = Math.max(tally.holdMs, remaining);
  return true;
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
    if (late(container, tally) || held(container, tally, write.localAt)) continue;
    try {
      const item = onlyStatus(write.toApple)
        ? await platform.setCompleted({ id: write.item.id, completed: write.next.completed, completedAt: write.next.doneAt })
        : await platform.upsert({ id: write.item.id, listId: write.item.listId, title: write.next.title, due: dueOf(write.next), completed: write.next.completed, completedAt: write.next.doneAt });
      await recordWritten(container, write, item);
      tally.sent += 1;
      tally.touched.add(write.task.id);
    } catch (error) {
      const code = error instanceof RemindersError ? error.code : '';
      if (code === 'not-found' || code === 'invalid-input') {
        // Rappel disparu entre la lecture et l'écriture, ou valeur que Rappels refuse (elle se reproduirait à l'identique à chaque passage) : la tâche est
        // détachée (jamais supprimée), avec message.
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
    if (late(container, tally) || held(container, tally, task.updatedAt)) continue;
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
      if (code === 'invalid-input') {
        // Valeur refusée par Rappels : la tâche reste ordinaire (jamais de boucle), avec message.
        await revertToOrdinary(container, task);
        note(tally, 'detached');
        tally.touched.add(task.id);
      } else if (code === 'list-not-found') {
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
  const read = await container.reminders.fetch({ listIds: [listId], limitPerList: 500, includeCompleted: true, ids: [] });
  // Créés après le début de la création, de même échéance, hors rappels déjà adoptés (terminés compris). Le titre a pu changer entre-temps (dans Rappels ou ici) :
  // un titre identique est préféré ; sinon un seul candidat est adopté, jamais un choix au hasard parmi plusieurs.
  const created = (read.lists.find((entry) => entry.listId === listId)?.items ?? []).filter((item) => (item.due?.date ?? null) === values.date && (item.due?.time ?? null) === values.time && item.createdAt !== null && Date.parse(item.createdAt) >= started);
  // Un rappel déjà adopté par une autre tâche n'est pas un candidat.
  const taken = new Set((await container.data.repos.appleLinks.listAll()).map((entry) => entry.reminderId));
  const free = created.filter((item) => !taken.has(item.id));
  const exact = free.filter((item) => item.title.trim() === task.title.trim());
  const pool = (exact.length > 0 ? exact : free.length === 1 ? free : []).sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id));
  const [first, ...others] = pool;
  if (first === undefined) return null;
  if (others.length > 0) note(tally, 'duplicate-created', others.length);
  return first;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Suppression (K-06 critère 7)
// ---------------------------------------------------------------------------------------------------------------------------------

interface DeletionCandidate {
  readonly link: AppleReminderLink;
  readonly task: Task | null;
}

interface DeletionScan {
  readonly candidates: DeletionCandidate[];
  /** Liens dont la tâche est absente de la base sans suppression connue : jamais une suppression dans Rappels. */
  readonly orphans: AppleReminderLink[];
}

/**
 * Liens dont le rappel doit être supprimé : tâche supprimée (ici ou reçue de la synchro) ou lien « suppression en cours » (écrit par ce
 * module après avoir vu la tâche supprimée). Une tâche ABSENTE de la base sans lien « suppression en cours » n'est jamais une suppression
 * connue (pas de pierre tombale vue ici) : rien n'est supprimé dans Rappels.
 */
async function scanDeletions(container: AppContainer, links: readonly AppleReminderLink[], alive: ReadonlySet<TaskId>): Promise<DeletionScan> {
  const out: DeletionCandidate[] = [];
  const orphans: AppleReminderLink[] = [];
  for (const link of links) {
    if (link.state === 'creating') continue;
    if (link.state === 'linked' && alive.has(link.taskId)) continue;
    const task = await container.data.repos.tasks.getById(link.taskId, { includeDeleted: true });
    if (task !== null && task.deletedAt === null) continue; // tâche vivante hors de la liste (écartée) : rien à envoyer
    if (task === null && link.state !== 'deleting') {
      orphans.push(link);
      continue;
    }
    out.push({ link, task });
  }
  return { candidates: out, orphans };
}

const deletionCandidates = async (container: AppContainer, links: readonly AppleReminderLink[], alive: ReadonlySet<TaskId>): Promise<DeletionCandidate[]> => (await scanDeletions(container, links, alive)).candidates;

/** Suppressions confirmées par l'utilisateur (listId → nombre affiché) : la garde de suppression massive ne les retient plus tant qu'elles ne sont pas toutes parties. */
const confirmedDeletions = new WeakMap<AppContainer, Map<string, number>>();

async function sendDeletions(container: AppContainer, context: SendContext, tally: Tally): Promise<void> {
  const now = nowIso(container.clock);
  const alive = new Set(context.tasks.map((task) => task.id));
  const { candidates, orphans } = await scanDeletions(container, context.links, alive);
  if (orphans.length > 0) {
    // Lien sans tâche et sans suppression connue : jamais un silence ni une suppression dans Rappels. Le lien est retiré avec un message ; le rappel, resté dans Rappels,
    // est réimporté (ou relié si la tâche arrive de la synchro).
    await container.data.transaction(async (tx) => {
      for (const link of orphans) await tx.appleLinks.remove(link.taskId);
    });
    note(tally, 'orphan-link', orphans.length);
  }
  // Garde symétrique par liste : au-delà de max(10, 25 %) des tâches liées de la liste, rien n'est envoyé sans confirmation (écran Agendas).
  const byList = new Map<string, DeletionCandidate[]>();
  for (const candidate of candidates) byList.set(candidate.link.listId, [...(byList.get(candidate.link.listId) ?? []), candidate]);
  const blocked = new Set<string>();
  const heldLists: NonNullable<SendResult['held']>[number][] = [];
  for (const [listId, group] of byList) {
    const linkedHere = context.tasks.filter((task) => appleLinkState(task) === 'linked' && task.appleListId === listId).length;
    const confirmed = confirmedDeletions.get(container)?.get(listId) ?? 0;
    if (massDeletionBlocked(linkedHere + group.length, group.length) && confirmed < group.length) {
      blocked.add(listId);
      heldLists.push({ listId, count: group.length, at: now, send: true });
      tally.pending += group.length;
    }
  }
  tally.held = heldLists;
  for (const candidate of candidates) {
    if (blocked.has(candidate.link.listId)) continue;
    await deleteOne(container, candidate, tally, now);
  }
}

/** Supprime le rappel d'une tâche supprimée (fenêtre d'annulation respectée) ; un échec global arrête les envois suivants. */
async function deleteOne(container: AppContainer, { link, task }: DeletionCandidate, tally: Tally, now: IsoDateTime): Promise<void> {
  if (tally.stop) {
    tally.pending += 1;
    return;
  }
  if (late(container, tally)) return;
  if (task !== null && held(container, tally, task.deletedAt)) return;
  if (link.reminderId === null || task?.appleRecurring === true) {
    // Création interrompue puis tâche supprimée : rien n'existe. Rappel récurrent : jamais supprimé d'ici.
    await finishDeletion(container, task, link);
    return;
  }
  try {
    if (link.state !== 'deleting') await container.data.transaction((tx) => tx.appleLinks.upsert({ ...link, state: 'deleting', startedAt: now }));
    await container.reminders.delete({ id: link.reminderId });
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

/**
 * Geste de l'utilisateur sur une retenue de suppressions vers Rappels (écran Agendas) : « Supprimer dans Rappels » supprime les rappels des
 * tâches supprimées de la liste, « Garder les rappels » les laisse (les tâches supprimées sont détachées, rien n'est renvoyé). La retenue
 * est levée seulement quand tout est traité ; un échec reste visible (état persistant d'écriture).
 */
export async function resolveHeldSend(container: AppContainer, listId: string, choice: 'delete' | 'keep', expected?: number): Promise<PassReport> {
  const state = appleRemindersState(container);
  if (!container.reminders.available) return { ...EMPTY_REPORT, status: 'skipped', reason: 'unavailable' };
  try {
    await state.load();
    const now = nowIso(container.clock);
    const alive = new Set((await container.data.repos.tasks.listAppleSourced()).map((task) => task.id));
    const candidates = (await deletionCandidates(container, await container.data.repos.appleLinks.listAll(), alive)).filter((candidate) => candidate.link.listId === listId);
    const tally: Tally = { sent: 0, pending: 0, code: null, touched: new Set(), notices: new Map(), createOff: false, held: null, holdMs: 0, stop: false };
    if (choice === 'delete' && expected !== undefined && candidates.length !== expected) {
      // Le nombre a changé depuis l'affichage : rien n'est supprimé, la question est reposée avec le nouveau nombre.
      await state.patchStatus((current) => ({
        ...current,
        held: [...current.held.filter((entry) => !(entry.send === true && entry.listId === listId)), ...(candidates.length === 0 ? [] : [{ listId, count: candidates.length, at: now, send: true as const }])],
      }));
      return { ...EMPTY_REPORT, pending: candidates.length };
    }
    if (choice === 'delete') {
      if ((await container.reminders.status()) !== 'full') {
        await state.fail('access-denied');
        return { ...EMPTY_REPORT, status: 'failed', code: 'access-denied' };
      }
      const confirmed = confirmedDeletions.get(container) ?? new Map<string, number>();
      confirmed.set(listId, candidates.length);
      confirmedDeletions.set(container, confirmed);
      for (const candidate of candidates) await deleteOne(container, candidate, tally, now);
      if (tally.pending === 0) confirmed.delete(listId);
    } else {
      for (const candidate of candidates) {
        await finishDeletion(container, candidate.task, candidate.link);
        if (candidate.task !== null) tally.touched.add(candidate.task.id);
      }
    }
    if (tally.touched.size > 0) await applyRemoteChanges(container, { tables: new Set(['task']), ids: new Map([['task', new Set(tally.touched)]]) });
    await state.patchStatus((current) => ({
      ...current,
      held: tally.pending === 0 ? current.held.filter((entry) => !(entry.send === true && entry.listId === listId)) : current.held,
      failure: tally.code === null ? current.failure : { code: tally.code, at: now, write: true as const },
    }));
    return { ...EMPTY_REPORT, sent: tally.sent, pending: tally.pending, ...(tally.holdMs > 0 ? { holdMs: tally.holdMs } : {}), ...(tally.code === null ? {} : { status: 'failed' as const, code: tally.code }) };
  } catch (error) {
    const code = error instanceof RemindersError ? error.code : 'pass-failed';
    logFailure('apple-reminders', `held-failed ${code}`);
    await state.fail(code);
    return { ...EMPTY_REPORT, status: 'failed', code };
  }
}

/** Fin d'une suppression : la tâche (même supprimée) est détachée, le lien retiré. */
async function finishDeletion(container: AppContainer, task: Task | null, link: AppleReminderLink): Promise<void> {
  await container.data.transaction(async (repos) => {
    if (task !== null) await repos.tasks.setAppleLink(task.id, { source: 'local', externalId: null, appleListId: task.appleListId ?? link.listId, appleRecurring: false });
    await repos.appleLinks.remove(link.taskId);
  });
}

