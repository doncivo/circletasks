import { afterEach, describe, expect, it } from 'vitest';
import type { TaskId } from '../../../src/domain/types';
import { armCrash } from '../../sim/syncCrash';
import { createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../sim/syncDevice';

/**
 * Arrêt brutal à chaque écriture d'un cycle (ADR 0011, sections 3.3, 5.5 et 10.2 ; Y-02 critères 3, 5, 6, 11 et 12, Y-05 critère 5,
 * Y-09 critères 2, 3 et 7). Pour chaque scénario, le cycle d'un appareil est d'abord compté (nombre d'écritures : journal, état,
 * instantané, suppression de fichiers, transactions et écritures hors transaction), puis rejoué autant de fois qu'il y a d'écritures,
 * le processus mourant juste avant la n-ième. Après le redémarrage, quelques cycles ordinaires doivent suffire à tout converger :
 * aucune écriture perdue, aucun doublon, aucune ligne supprimée ressuscitée, aucun conflit inventé, file vide, aucun appareil marqué
 * corrompu, `sync_guard` vide.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DAY = 86_400_000;

let devices: SimDevice[] = [];
afterEach(async () => {
  await closeAll();
});

async function closeAll(): Promise<void> {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
}

async function twoDevices(): Promise<[SimDevice, SimDevice]> {
  const a = await createSimDevice(A_ID, { name: 'PC' });
  const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock });
  devices = [a, b];
  await setupFirst(a);
  await a.cycle();
  await pair(a, b);
  await b.cycle();
  syncFolders(devices);
  await a.cycle();
  return [a, b];
}

/** Tout le monde a lu tout : deux tours complets. */
async function settle(): Promise<void> {
  for (let i = 0; i < 2; i += 1) {
    for (const d of devices) await d.cycle();
    syncFolders(devices);
  }
}

interface Ctx {
  readonly a: SimDevice;
  readonly b: SimDevice;
  /** Appareil dont le cycle sera interrompu. */
  readonly victim: SimDevice;
  /** Valeurs attendues partout après convergence : titre, note et suppression de chaque tâche suivie. */
  readonly expected: Record<string, { title: string; note?: string; deleted?: boolean; absentOrDeleted?: boolean }>;
}

type Scenario = (victim: 'a' | 'b') => Promise<Ctx>;

/** Écritures locales hors ligne de A (création, deux modifications de champs différents d'une ligne, suppression) : le cycle de A publie. */
const publishing: Scenario = async (victim) => {
  const [a, b] = await twoDevices();
  const edited = await a.createTask('Éditée');
  const gone = await a.createTask('À supprimer');
  await settle();
  a.clock.advance(1_000);
  const fresh = await a.createTask('Nouvelle');
  await a.updateTask(edited.id, { note: 'note de A' });
  a.clock.advance(5);
  await a.updateTask(edited.id, { title: 'Titre de A' });
  await a.deleteTask(gone.id);
  return {
    a,
    b,
    victim: victim === 'a' ? a : b,
    expected: {
      [fresh.id]: { title: 'Nouvelle' },
      [edited.id]: { title: 'Titre de A', note: 'note de A' },
      [gone.id]: { title: 'À supprimer', deleted: true },
    },
  };
};

/** B a des lots à lire (création, modification, suppression de A) et ses propres écritures non publiées, dont un même champ en conflit. */
const reading: Scenario = async (victim) => {
  const [a, b] = await twoDevices();
  const edited = await a.createTask('Éditée');
  const gone = await a.createTask('À supprimer');
  await settle();
  a.clock.advance(1_000);
  const fresh = await a.createTask('Nouvelle de A');
  await a.updateTask(edited.id, { title: 'Titre de A', note: 'note de A' });
  await a.deleteTask(gone.id);
  await a.cycle();
  syncFolders(devices);
  b.clock.advance(1_000);
  const local = await b.createTask('Locale de B');
  await b.updateTask(edited.id, { title: 'Titre de B' });
  return {
    a,
    b,
    victim: victim === 'a' ? a : b,
    expected: {
      [fresh.id]: { title: 'Nouvelle de A' },
      [local.id]: { title: 'Locale de B' },
      [edited.id]: { title: 'Titre de B', note: 'note de A' },
      [gone.id]: { title: 'À supprimer', deleted: true },
    },
  };
};

/**
 * 38 jours plus tard : instantané dû et suppression vieille de 38 jours lue par tous (purge due), en plus d'écritures locales à publier.
 * La tâche purgée n'a jamais le droit de réapparaître vivante.
 */
const maintenance: Scenario = async (victim) => {
  const [a, b] = await twoDevices();
  const old = await a.createTask('Supprimée il y a longtemps');
  const kept = await a.createTask('Gardée');
  await settle();
  a.clock.advance(1_000);
  await a.deleteTask(old.id);
  await settle();
  a.clock.advance(38 * DAY);
  await b.cycle();
  syncFolders(devices);
  const fresh = await a.createTask('Récente');
  return {
    a,
    b,
    victim: victim === 'a' ? a : b,
    expected: {
      [old.id]: { title: 'Supprimée il y a longtemps', absentOrDeleted: true },
      [kept.id]: { title: 'Gardée' },
      [fresh.id]: { title: 'Récente' },
    },
  };
};

async function writesOf(scenario: Scenario, victim: 'a' | 'b'): Promise<number> {
  const ctx = await scenario(victim);
  const probe = armCrash(ctx.victim, null);
  await ctx.victim.cycle();
  const writes = probe.writes;
  probe.disarm();
  await closeAll();
  return writes;
}

async function expectRecovered(ctx: Ctx, label: string): Promise<void> {
  const { a, b } = ctx;
  // Quelques cycles ordinaires : jamais plus de trois tours complets (le cycle interrompu ne doit pas laisser de travail caché).
  for (let round = 0; round < 3; round += 1) {
    for (const d of [a, b]) {
      const status = await d.cycle();
      expect(status.phase, `${label} : ${d.name} tour ${String(round)}`).toBe('idle');
      syncFolders(devices);
    }
  }
  for (const d of [a, b]) {
    expect(await d.data.repos.sync.outboxCount(), `${label} : file de ${d.name}`).toBe(0);
    expect(await d.driver.select('SELECT * FROM sync_guard'), `${label} : sync_guard de ${d.name}`).toEqual([]);
    expect(await d.data.repos.sync.getMeta('inflight'), `${label} : intention d'ajout de ${d.name}`).toBeNull();
    expect(await d.driver.select("SELECT device_id, status FROM sync_state WHERE status NOT IN ('active')"), `${label} : appareils anormaux vus par ${d.name}`).toEqual([]);
    for (const [id, want] of Object.entries(ctx.expected)) {
      const row = await d.task(id as TaskId);
      if (want.absentOrDeleted) {
        expect(row === null || row.deletedAt !== null, `${label} : ${want.title} ne revit pas sur ${d.name}`).toBe(true);
        continue;
      }
      expect(row?.title, `${label} : ${want.title} sur ${d.name}`).toBe(want.title);
      if (want.note !== undefined) expect(row?.note, `${label} : note de ${want.title} sur ${d.name}`).toBe(want.note);
      expect(row?.deletedAt !== null, `${label} : suppression de ${want.title} sur ${d.name}`).toBe(want.deleted === true);
    }
  }
  expect(await taskSnapshot(a), `${label} : convergence`).toEqual(await taskSnapshot(b));
  // Aucune ligne en double : le rejeu après l'arrêt ne crée ni tâche de plus ni conflit inventé entre deux valeurs identiques.
  const count = (d: SimDevice): Promise<unknown[]> => d.driver.select('SELECT COUNT(*) AS n FROM task');
  expect(await count(a)).toEqual(await count(b));
  for (const d of [a, b]) {
    const same = await d.driver.select('SELECT field FROM conflict_log WHERE kept_value = discarded_value');
    expect(same, `${label} : conflit entre valeurs identiques sur ${d.name}`).toEqual([]);
  }
}

const SCENARIOS: readonly { readonly name: string; readonly scenario: Scenario; readonly victim: 'a' | 'b' }[] = [
  { name: 'publication de A (écritures hors ligne)', scenario: publishing, victim: 'a' },
  { name: 'lecture de B (lots d’autrui et écritures locales en conflit)', scenario: reading, victim: 'b' },
  { name: 'entretien de A (instantané, purge, 38 jours)', scenario: maintenance, victim: 'a' },
  { name: 'entretien de B (instantané, purge, 38 jours)', scenario: maintenance, victim: 'b' },
];

// Le nombre d'écritures de chaque cycle est mesuré à la collecte : le moteur peut changer, la couverture suit.
const COUNTS: number[] = [];
for (const { scenario, victim } of SCENARIOS) COUNTS.push(await writesOf(scenario, victim));

SCENARIOS.forEach(({ name, scenario, victim }, index) => {
  const writes = COUNTS[index] as number;
  describe(`arrêt brutal pendant le cycle : ${name}`, () => {
    it('le cycle compte au moins une écriture (le scénario exerce bien le moteur)', () => {
      expect(writes).toBeGreaterThan(0);
    });

    it.each(Array.from({ length: writes }, (_, i) => i + 1))('Y-02 / Y-05 critère 5 : arrêt juste avant l’écriture %i, redémarrage, reprise sans perte ni doublon', async (n) => {
      const ctx = await scenario(victim);
      const probe = armCrash(ctx.victim, n);
      await ctx.victim.cycle();
      expect(probe.crashed, `l'écriture ${String(n)} existe`).toBe(true);
      probe.disarm();
      await ctx.victim.restart();
      await expectRecovered(ctx, `arrêt avant l'écriture ${String(n)}/${String(writes)}`);
    });
  });
});
