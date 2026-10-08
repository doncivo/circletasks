import { describe, expect, it } from 'vitest';
import {
  APPLE_REMINDERS_PSEUDO_DEVICE,
  appleLinkState,
  createTargetFor,
  encodeSynced,
  isAppleRecurringLocked,
  isFollowed,
  massDeletionBlocked,
  mergeLinked,
  parseAppleCreate,
  parseAppleLists,
  parseApplePending,
  parseAppleStatus,
  parseSynced,
  syntheticHlc,
  taskScheduleOf,
  titleFromApple,
  validateCreateRule,
  valuesOfItem,
  valuesOfTask,
  type AppleValues,
  type MergeInput,
  type ReminderItem,
} from './appleReminders';
import { parseHlc } from './hlc';
import type { IsoDateTime, LocalDate, LocalTime, SpaceId } from './types';

const PRO = '00000000-0000-4000-8000-000000000001' as SpaceId;
const PERSO = '00000000-0000-4000-8000-000000000002' as SpaceId;
const D = (value: string): LocalDate => value as LocalDate;
const T = (value: string): LocalTime => value as LocalTime;
const I = (value: string): IsoDateTime => value as IsoDateTime;

const base: AppleValues = { title: 'Appeler le notaire', date: D('2026-10-09'), time: T('10:00'), completed: false, doneAt: null };
const clocks = { title: 1_000, date: 1_000, time: 1_000, status: 1_000 };

function merge(partial: Partial<MergeInput>) {
  return mergeLinked({ task: base, carriedOver: false, item: base, synced: base, appleModifiedMs: 1_000, localMs: clocks, ...partial });
}

describe('états d’une tâche (ADR 0008 §10.2)', () => {
  it('ordinaire, liée, à créer, détachée', () => {
    expect(appleLinkState({ source: 'local', externalId: null, appleListId: null })).toBe('ordinary');
    expect(appleLinkState({ source: 'apple_reminders', externalId: 'R1', appleListId: 'L1' })).toBe('linked');
    expect(appleLinkState({ source: 'apple_reminders', externalId: null, appleListId: 'L1' })).toBe('to-create');
    expect(appleLinkState({ source: 'local', externalId: null, appleListId: 'L1' })).toBe('detached');
    // Incohérences lues d'un autre appareil : jamais une tâche « liée » sans identifiant, jamais un identifiant sans origine.
    expect(appleLinkState({ source: 'apple_reminders', externalId: null, appleListId: null })).toBe('ordinary');
    expect(appleLinkState({ source: 'local', externalId: 'R1', appleListId: 'L1' })).toBe('ordinary');
  });

  it('une tâche liée à un rappel récurrent est verrouillée, pas une tâche seulement à créer ou ordinaire', () => {
    expect(isAppleRecurringLocked({ source: 'apple_reminders', externalId: 'R1', appleListId: 'L1', appleRecurring: true })).toBe(true);
    expect(isAppleRecurringLocked({ source: 'apple_reminders', externalId: 'R1', appleListId: 'L1', appleRecurring: false })).toBe(false);
    expect(isAppleRecurringLocked({ source: 'local', externalId: null, appleListId: 'L1', appleRecurring: true })).toBe(false);
  });
});

describe('valeurs comparées', () => {
  const item = (patch: Partial<ReminderItem> = {}): ReminderItem => ({
    id: 'R1', externalRef: null, listId: 'L1', title: 'Courses', due: { date: D('2026-10-09'), time: null }, completed: false, completedAt: null, recurring: false, modifiedAt: I('2026-10-08T08:00:00.000Z'), createdAt: null, ...patch,
  });

  it('un rappel sans échéance est « Un jour », avec échéance il ne l’est pas', () => {
    expect(valuesOfItem(item({ due: null }), 'Rappel sans titre')).toMatchObject({ date: null, time: null });
    expect(taskScheduleOf({ date: null, time: null })).toEqual({ date: null, time: null, someday: true });
    expect(taskScheduleOf({ date: D('2026-10-09'), time: T('10:00') })).toEqual({ date: '2026-10-09', time: '10:00', someday: false });
  });

  it('titre vide ou blanc : texte de repli ; titre trop long : tronqué à la limite du catalogue', () => {
    expect(titleFromApple('   ', 'Rappel sans titre')).toBe('Rappel sans titre');
    expect(titleFromApple('  Pain  ', 'x')).toBe('Pain');
    expect(titleFromApple('a'.repeat(5_000), 'x')).toHaveLength(4_096);
  });

  it('l’achèvement ne garde la date que si le rappel est terminé', () => {
    expect(valuesOfItem(item({ completed: true, completedAt: I('2026-10-08T09:00:00.000Z') }), 'x')).toMatchObject({ completed: true, doneAt: '2026-10-08T09:00:00.000Z' });
    expect(valuesOfItem(item({ completed: false, completedAt: I('2026-10-08T09:00:00.000Z') }), 'x').doneAt).toBeNull();
    expect(valuesOfTask({ title: 'a', date: null, time: null, status: 'done', doneAt: I('2026-10-08T09:00:00.000Z') })).toMatchObject({ completed: true });
  });

  it('l’empreinte fait l’aller-retour ; une empreinte illisible ou invalide est inconnue', () => {
    expect(parseSynced(encodeSynced(base))).toEqual(base);
    expect(parseSynced(null)).toBeNull();
    for (const bad of ['', '{', '[]', '{"title":1,"completed":false}', '{"title":"a","completed":false,"date":"2026-13-45","time":null,"doneAt":null}', '{"title":"a","completed":false,"date":null,"time":"25:00","doneAt":null}', '{"title":"a","completed":false,"date":null,"time":null,"doneAt":"hier"}']) {
      expect(parseSynced(bad), bad).toBeNull();
    }
  });
});

describe('fusion par champ (ADR 0008 §10.5, K-06 critères 2 à 4)', () => {
  it('rien n’a changé : rien à écrire (anti-boucle, second passage vide)', () => {
    const result = merge({});
    expect(result.idle).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.next).toEqual(base);
  });

  it('un seul côté a changé : il gagne, sans conflit', () => {
    const apple = merge({ item: { ...base, title: 'Appeler la notaire', date: D('2026-10-12') } });
    expect(apple.toTask).toEqual({ title: 'Appeler la notaire', date: '2026-10-12', carriedOver: false });
    expect(apple.toApple).toEqual({});
    expect(apple.conflicts).toEqual([]);
    expect(apple.next).toMatchObject({ title: 'Appeler la notaire', date: '2026-10-12' });
    const local = merge({ task: { ...base, title: 'Autre titre', time: T('11:30') } });
    expect(local.toApple).toEqual({ title: 'Autre titre', time: '11:30' });
    expect(local.toTask).toEqual({});
    expect(local.next).toMatchObject({ title: 'Autre titre', time: '11:30' });
  });

  it('des champs différents changés des deux côtés : les deux sont gardés, aucun conflit', () => {
    const result = merge({ task: { ...base, title: 'Titre local' }, item: { ...base, date: D('2026-10-20') } });
    expect(result.toApple).toEqual({ title: 'Titre local' });
    expect(result.toTask).toEqual({ date: '2026-10-20', carriedOver: false });
    expect(result.conflicts).toEqual([]);
    expect(result.next).toMatchObject({ title: 'Titre local', date: '2026-10-20' });
  });

  it('le même champ avec la même valeur des deux côtés : rien à écrire, empreinte rattrapée', () => {
    const result = merge({ task: { ...base, title: 'Pareil' }, item: { ...base, title: 'Pareil' } });
    expect(result.idle).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.next.title).toBe('Pareil');
  });

  it('même champ, valeurs différentes : le plus récent gagne et la valeur perdue est rendue pour le journal', () => {
    const appleWins = merge({ task: { ...base, title: 'Local' }, item: { ...base, title: 'Rappels' }, appleModifiedMs: 5_000, localMs: { ...clocks, title: 2_000 } });
    expect(appleWins.toTask).toEqual({ title: 'Rappels' });
    expect(appleWins.toApple).toEqual({});
    expect(appleWins.conflicts).toEqual([{ field: 'title', winner: 'apple', kept: 'Rappels', discarded: 'Local', discardedAtMs: 2_000 }]);
    expect(appleWins.next.title).toBe('Rappels');
    const localWins = merge({ task: { ...base, title: 'Local' }, item: { ...base, title: 'Rappels' }, appleModifiedMs: 2_000, localMs: { ...clocks, title: 5_000 } });
    expect(localWins.toApple).toEqual({ title: 'Local' });
    expect(localWins.toTask).toEqual({});
    expect(localWins.conflicts).toEqual([{ field: 'title', winner: 'local', kept: 'Local', discarded: 'Rappels', discardedAtMs: 2_000 }]);
    expect(localWins.next.title).toBe('Local');
  });

  it('à égalité de date, Rappels gagne ; sans heure de Rappels, le champ local connu gagne', () => {
    const tie = merge({ task: { ...base, title: 'Local' }, item: { ...base, title: 'Rappels' }, appleModifiedMs: 3_000, localMs: { ...clocks, title: 3_000 } });
    expect(tie.conflicts[0]?.winner).toBe('apple');
    const unknownApple = merge({ task: { ...base, title: 'Local' }, item: { ...base, title: 'Rappels' }, appleModifiedMs: null, localMs: { ...clocks, title: 3_000 } });
    expect(unknownApple.conflicts[0]?.winner).toBe('local');
    const unknownLocal = merge({ task: { ...base, title: 'Local' }, item: { ...base, title: 'Rappels' }, appleModifiedMs: 3_000, localMs: { ...clocks, title: null } });
    expect(unknownLocal.conflicts[0]?.winner).toBe('apple');
  });

  it('empreinte inconnue : chaque champ différent est un conflit, un champ égal ne l’est pas', () => {
    const result = merge({ synced: null, task: { ...base, title: 'Local', time: T('15:00') }, item: { ...base, title: 'Rappels' }, appleModifiedMs: 9_000 });
    expect(result.conflicts.map((conflict) => conflict.field)).toEqual(['title', 'time']);
    expect(result.next.date).toBe('2026-10-09');
  });

  it('terminer ici renvoie le statut ; terminer dans Rappels revient avec la date d’achèvement', () => {
    const done = I('2026-10-08T09:00:00.000Z');
    const local = merge({ task: { ...base, completed: true, doneAt: done } });
    expect(local.toApple).toEqual({ completed: true, doneAt: done });
    expect(local.next).toMatchObject({ completed: true, doneAt: done });
    const apple = merge({ item: { ...base, completed: true, doneAt: done } });
    expect(apple.toTask).toEqual({ completed: true, doneAt: done });
    expect(apple.toApple).toEqual({});
    // Rouvrir dans Rappels.
    const reopened = merge({ synced: { ...base, completed: true, doneAt: done }, task: { ...base, completed: true, doneAt: done }, item: { ...base, completed: false } });
    expect(reopened.toTask).toEqual({ completed: false, doneAt: null });
  });

  it('terminée ici et modifiée dans Rappels (autre champ) : les deux sont gardés (K-07 critère 4)', () => {
    const done = I('2026-10-08T09:00:00.000Z');
    const result = merge({ task: { ...base, completed: true, doneAt: done }, item: { ...base, title: 'Titre venu de Rappels' } });
    expect(result.toApple).toEqual({ completed: true, doneAt: done });
    expect(result.toTask).toEqual({ title: 'Titre venu de Rappels' });
    expect(result.conflicts).toEqual([]);
  });

  it('date retirée ici : l’échéance de Rappels est effacée avec son heure (K-06 D4)', () => {
    const result = merge({ task: { ...base, date: null, time: null } });
    expect(result.toApple).toEqual({ date: null, time: null });
    expect(result.next).toMatchObject({ date: null, time: null });
  });

  it('échéance retirée dans Rappels : la tâche passe sans date ni heure', () => {
    const result = merge({ item: { ...base, date: null, time: null } });
    expect(result.toTask).toEqual({ date: null, time: null, carriedOver: false });
  });

  it('jamais d’heure sans date, quel que soit le gagnant', () => {
    // Date retirée dans Rappels, heure changée ici : la date retirée l'emporte sur l'heure.
    const result = merge({ item: { ...base, date: null, time: null }, task: { ...base, time: T('18:00') }, appleModifiedMs: 5_000, localMs: clocks });
    expect(result.toTask.date).toBeNull();
    expect(result.toTask.time ?? null).toBeNull();
    expect(result.next.time).toBeNull();
    expect(result.toApple.time ?? null).toBeNull();
  });

  it('report automatique (T-06) : la date reportée n’est jamais renvoyée vers Rappels (D5)', () => {
    const carried = { ...base, date: D('2026-10-10') };
    const idle = merge({ task: carried, carriedOver: true });
    expect(idle.toApple).toEqual({});
    expect(idle.toTask).toEqual({});
    expect(idle.next.date).toBe('2026-10-09');
    // Rappels change l'échéance : Rappels gagne et le badge « reportée » tombe.
    const moved = merge({ task: carried, carriedOver: true, item: { ...base, date: D('2026-10-15') } });
    expect(moved.toTask).toEqual({ date: '2026-10-15', carriedOver: false });
    expect(moved.toApple).toEqual({});
    // Mais un autre champ changé ici est bien renvoyé.
    expect(merge({ task: { ...carried, title: 'Nouveau' }, carriedOver: true }).toApple).toEqual({ title: 'Nouveau' });
  });
});

describe('hlc synthétique des valeurs perdues côté Rappels', () => {
  it('forme `<ms sur 15 chiffres>-0000-<appareil fictif>`, lisible par l’analyseur de hlc', () => {
    const hlc = syntheticHlc(Date.parse('2026-10-08T08:00:00.000Z'));
    expect(hlc).toBe(`001791446400000-0000-${APPLE_REMINDERS_PSEUDO_DEVICE}`);
    expect(parseHlc(hlc)).toMatchObject({ ms: Date.parse('2026-10-08T08:00:00.000Z'), counter: 0, deviceId: APPLE_REMINDERS_PSEUDO_DEVICE });
    expect(syntheticHlc(null).startsWith('000000000000000-0000-')).toBe(true);
    expect(syntheticHlc(-5).startsWith('000000000000000-0000-')).toBe(true);
  });
});

describe('suppression et suivi', () => {
  it('garde de suppression massive : plus de max(10, 25 %) des tâches liées', () => {
    expect(massDeletionBlocked(100, 25)).toBe(false);
    expect(massDeletionBlocked(100, 26)).toBe(true);
    expect(massDeletionBlocked(20, 10)).toBe(false);
    expect(massDeletionBlocked(20, 11)).toBe(true);
    expect(massDeletionBlocked(3, 3)).toBe(false);
    expect(massDeletionBlocked(0, 0)).toBe(false);
    expect(massDeletionBlocked(1_000, 250)).toBe(false);
    expect(massDeletionBlocked(1_000, 251)).toBe(true);
  });

  it('suivi : à faire, terminée depuis moins de 30 jours, ou modifiée depuis le dernier passage', () => {
    const now = Date.parse('2026-10-08T10:00:00.000Z');
    const todo = { status: 'todo' as const, doneAt: null, updatedAt: I('2026-01-01T00:00:00.000Z') };
    expect(isFollowed(todo, now, I('2026-10-01T00:00:00.000Z'))).toBe(true);
    const doneRecently = { status: 'done' as const, doneAt: I('2026-09-20T00:00:00.000Z'), updatedAt: I('2026-09-20T00:00:00.000Z') };
    expect(isFollowed(doneRecently, now, I('2026-10-01T00:00:00.000Z'))).toBe(true);
    const doneLongAgo = { status: 'done' as const, doneAt: I('2026-08-01T00:00:00.000Z'), updatedAt: I('2026-08-01T00:00:00.000Z') };
    expect(isFollowed(doneLongAgo, now, I('2026-10-01T00:00:00.000Z'))).toBe(false);
    expect(isFollowed({ ...doneLongAgo, updatedAt: I('2026-10-05T00:00:00.000Z') }, now, I('2026-10-01T00:00:00.000Z'))).toBe(true);
    expect(isFollowed(doneLongAgo, now, null)).toBe(true);
  });
});

describe('réglages venus de la synchro : validés', () => {
  it('listes : plafonnées, sans doublon, `shown` exige un espace, textes bornés', () => {
    const parsed = parseAppleLists({
      lists: [
        { id: 'L1', name: 'Courses', spaceId: PERSO, shown: true },
        { id: 'L1', name: 'Doublon', spaceId: PRO, shown: true },
        { id: 'L2', name: 'Sans espace', spaceId: null, shown: true },
        { id: 'L3', name: 'x'.repeat(500), spaceId: 'pas-un-uuid', shown: true },
        { id: '', name: 'Vide' },
        { name: 'Sans id' },
        'texte',
      ],
    });
    expect(parsed.lists.map((list) => [list.id, list.spaceId, list.shown])).toEqual([
      ['L1', PERSO, true],
      ['L2', null, false],
      ['L3', null, false],
    ]);
    expect(parsed.lists[2]?.name).toHaveLength(200);
    expect(parseAppleLists(null).lists).toEqual([]);
    expect(parseAppleLists({ lists: 'non' }).lists).toEqual([]);
    expect(parseAppleLists({ lists: Array.from({ length: 150 }, (_, i) => ({ id: `L${String(i)}`, name: 'n', spaceId: PRO, shown: true })) }).lists).toHaveLength(100);
  });

  it('création : une règle par espace ; activée seulement avec une liste', () => {
    const parsed = parseAppleCreate({
      bySpace: [
        { spaceId: PERSO, enabled: true, listId: 'L1' },
        { spaceId: PERSO, enabled: true, listId: 'L2' },
        { spaceId: PRO, enabled: true, listId: null },
        { spaceId: 'x', enabled: true, listId: 'L1' },
      ],
    });
    expect(parsed.bySpace).toEqual([
      { spaceId: PERSO, enabled: true, listId: 'L1' },
      { spaceId: PRO, enabled: false, listId: null },
    ]);
    expect(parseAppleCreate(undefined).bySpace).toEqual([]);
  });

  it('liste de destination : activée, affichée, de cet espace ; sinon aucune', () => {
    const lists = parseAppleLists({ lists: [{ id: 'L1', name: 'Courses', spaceId: PERSO, shown: true }, { id: 'L2', name: 'Travail', spaceId: PRO, shown: false }] });
    const create = parseAppleCreate({ bySpace: [{ spaceId: PERSO, enabled: true, listId: 'L1' }, { spaceId: PRO, enabled: true, listId: 'L2' }] });
    expect(createTargetFor(PERSO, create, lists)).toBe('L1');
    expect(createTargetFor(PRO, create, lists)).toBeNull();
    expect(createTargetFor(PERSO, parseAppleCreate({ bySpace: [{ spaceId: PERSO, enabled: false, listId: 'L1' }] }), lists)).toBeNull();
    expect(validateCreateRule(PERSO, 'L1', lists)).toBeNull();
    expect(validateCreateRule(PERSO, null, lists)).toBe('no-list');
    expect(validateCreateRule(PRO, 'L2', lists)).toBe('list-not-in-space');
    expect(validateCreateRule(PRO, 'L1', lists)).toBe('list-not-in-space');
  });

  it('écritures dues et statut local : forme stricte, valeurs inconnues ignorées', () => {
    expect(parseApplePending({ count: 3, at: '2026-10-08T08:00:00.000Z' })).toEqual({ count: 3, at: '2026-10-08T08:00:00.000Z' });
    for (const bad of [null, {}, { count: -1, at: '2026-10-08T08:00:00.000Z' }, { count: 1.5, at: '2026-10-08T08:00:00.000Z' }, { count: 1, at: 'hier' }]) expect(parseApplePending(bad)).toBeNull();
    const status = parseAppleStatus({
      failure: { code: 'access-denied', at: '2026-10-08T08:00:00.000Z' },
      caps: [{ listId: 'L1', total: 740, imported: 500 }, { listId: 'L2', total: 'x', imported: 1 }],
      held: [{ listId: 'L1', count: 12, at: '2026-10-08T08:00:00.000Z' }],
      unknown: 4,
      missingLists: ['L9', 3],
      notices: [{ kind: 'deleted', count: 2, at: '2026-10-08T08:00:00.000Z' }, { kind: 'inconnu', count: 1, at: '2026-10-08T08:00:00.000Z' }],
    });
    expect(status).toEqual({
      failure: { code: 'access-denied', at: '2026-10-08T08:00:00.000Z' },
      caps: [{ listId: 'L1', total: 740, imported: 500 }],
      held: [{ listId: 'L1', count: 12, at: '2026-10-08T08:00:00.000Z' }],
      unknown: 4,
      missingLists: ['L9'],
      notices: [{ kind: 'deleted', count: 2, at: '2026-10-08T08:00:00.000Z' }],
    });
    expect(parseAppleStatus('x')).toEqual(parseAppleStatus(null));
    expect(parseAppleStatus(null).failure).toBeNull();
  });
});
