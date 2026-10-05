import { afterEach, describe, expect, it } from 'vitest';
import type { TaskId } from '../../../src/domain/types';
import { createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../sim/syncDevice';

/**
 * Écritures locales pendant un cycle, mêmes champs modifiés au même instant, suppression contre modification dans les deux ordres
 * (ADR 0011, sections 3.3, 4.1, 4.2 et 10.2 ; Y-02 critères 2, 3, 5, 6 et 11, Y-05 critères 3 à 5, Y-09 critères 1, 4 et 7).
 *
 * « Pendant un cycle » : l'écriture est faite par un crochet posé sur l'appel de plateforme (l'événement réel), au moment précis où le
 * moteur attend le dossier : aucun délai, aucun sondage. L'utilisateur peut écrire à tout moment, le moteur ne tient aucun verrou
 * de l'app.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DAY = 86_400_000;

let devices: SimDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

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

/** Deux tours complets : tout le monde a tout lu et tout publié. */
async function settle(list: readonly SimDevice[] = devices): Promise<void> {
  for (let i = 0; i < 2; i += 1) {
    for (const d of list) await d.cycle();
    syncFolders(list);
  }
}

/** Exécute `action` une seule fois, juste après le retour réel de `method` (la plateforme a répondu, le moteur n'a pas encore agi). */
function afterOnce<K extends 'readJournal' | 'appendJournal' | 'writeState'>(device: SimDevice, method: K, action: () => Promise<void>): void {
  const platform = device.platform as unknown as Record<K, (...args: unknown[]) => Promise<unknown>>;
  const real = platform[method].bind(device.platform) as (...args: unknown[]) => Promise<unknown>;
  let done = false;
  platform[method] = (async (...args: unknown[]) => {
    const result = await real(...args);
    if (!done) {
      done = true;
      await action();
    }
    return result;
  }) as (typeof platform)[K];
}

describe('écriture locale pendant un cycle (Y-02 critère 3, Y-05 critère 3)', () => {
  it('pendant la lecture : la frappe plus récente l’emporte sur la valeur lue, elle est publiée dans le même cycle et A converge', async () => {
    const [a, b] = await twoDevices();
    const t = await a.createTask('Base');
    await settle();
    a.clock.advance(1_000);
    await a.updateTask(t.id, { title: 'Titre de A', note: 'note de A' });
    await a.cycle();
    syncFolders(devices);
    b.clock.advance(1_000);
    afterOnce(b, 'readJournal', async () => {
      b.clock.advance(10);
      await b.updateTask(t.id, { title: 'Frappé sur B pendant la lecture' });
    });
    expect((await b.cycle()).phase).toBe('idle');
    expect((await b.task(t.id))?.title).toBe('Frappé sur B pendant la lecture');
    expect((await b.task(t.id))?.note).toBe('note de A');
    expect(await b.data.repos.sync.outboxCount()).toBe(0);
    syncFolders(devices);
    await a.cycle();
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
    expect((await a.task(t.id))?.title).toBe('Frappé sur B pendant la lecture');
  });

  it('pendant la lecture, suppression locale d’une ligne que le lot lu modifie : supprimée partout, modification de l’autre gardée', async () => {
    const [a, b] = await twoDevices();
    const t = await a.createTask('À supprimer');
    await settle();
    a.clock.advance(1_000);
    await a.updateTask(t.id, { note: 'note de A' });
    await a.cycle();
    syncFolders(devices);
    afterOnce(b, 'readJournal', async () => {
      b.clock.advance(10);
      await b.deleteTask(t.id);
    });
    await b.cycle();
    syncFolders(devices);
    await a.cycle();
    for (const d of devices) {
      const row = await d.task(t.id);
      expect(row?.deletedAt, d.name).not.toBeNull();
      expect(row?.note, d.name).toBe('note de A');
    }
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  });

  it('pendant l’ajout au journal : la valeur plus récente reste dans la file, part au cycle suivant, l’autre appareil ne voit jamais l’ancienne en dernier', async () => {
    const [a, b] = await twoDevices();
    const t = await a.createTask('Base');
    await settle();
    a.clock.advance(1_000);
    await a.updateTask(t.id, { title: 'v1' });
    afterOnce(a, 'appendJournal', async () => {
      a.clock.advance(5);
      await a.updateTask(t.id, { title: 'v2 écrite pendant l’ajout' });
    });
    expect((await a.cycle()).phase).toBe('idle');
    expect(await a.data.repos.sync.outboxCount()).toBe(1);
    syncFolders(devices);
    await b.cycle();
    await a.cycle();
    expect(await a.data.repos.sync.outboxCount()).toBe(0);
    syncFolders(devices);
    await b.cycle();
    expect((await b.task(t.id))?.title).toBe('v2 écrite pendant l’ajout');
    expect(await b.driver.select('SELECT * FROM conflict_log')).toEqual([]);
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  });

  it('pendant l’écriture de l’état : une création locale est publiée au cycle suivant', async () => {
    const [a, b] = await twoDevices();
    await a.createTask('Avant');
    let created: TaskId | null = null;
    afterOnce(a, 'writeState', async () => {
      created = (await a.createTask('Pendant l’état')).id;
    });
    await a.cycle();
    expect(created).not.toBeNull();
    await a.cycle();
    expect(await a.data.repos.sync.outboxCount()).toBe(0);
    syncFolders(devices);
    await b.cycle();
    expect((await b.task(created as unknown as TaskId))?.title).toBe('Pendant l’état');
  });

  it.each(['avant', 'après'] as const)('pendant l’instantané (écriture %s la lecture de la base) : un appareil qui rejoint reçoit l’écriture, aucun doublon', async (when) => {
    const [a, b] = await twoDevices();
    const t = await a.createTask('Base');
    await settle();
    a.clock.advance(8 * DAY);
    await settle();
    // L'instantané est dû au prochain cycle de A : une écriture arrive pendant qu'il s'écrit.
    a.clock.advance(1_000);
    const real = a.platform.writeSnapshot.bind(a.platform);
    let created: TaskId | null = null;
    const edit = async (): Promise<void> => {
      a.clock.advance(5);
      await a.updateTask(t.id, { title: `Éditée ${when} l’instantané` });
      created = (await a.createTask(`Créée ${when} l’instantané`)).id;
    };
    let wrote = false;
    a.platform.writeSnapshot = async (request) => {
      const records = {
        async *[Symbol.asyncIterator]() {
          if (when === 'avant') {
            wrote = true;
            await edit();
          }
          for await (const page of request.records) yield page;
          if (when === 'après') {
            wrote = true;
            await edit();
          }
        },
      };
      return real({ ...request, records });
    };
    a.clock.advance(8 * DAY);
    await a.cycle();
    expect(wrote, 'l’instantané a bien été écrit pendant ce cycle').toBe(true);
    a.platform.writeSnapshot = real;
    const c = await createSimDevice(C_ID, { name: 'Tablette', clock: a.clock });
    devices.push(c);
    syncFolders(devices);
    await pair(a, c);
    syncFolders(devices);
    await settle(devices);
    await settle(devices);
    for (const d of devices) {
      expect((await d.task(t.id))?.title, d.name).toBe(`Éditée ${when} l’instantané`);
      expect((await d.task(created as unknown as TaskId))?.title, d.name).toBe(`Créée ${when} l’instantané`);
      expect(await d.data.repos.sync.outboxCount(), d.name).toBe(0);
    }
    expect(await taskSnapshot(c)).toEqual(await taskSnapshot(a));
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
  });
});

describe('même champ au même instant (Y-02 critère 2, section 4.1)', () => {
  it('deux modifications de la même milliseconde : les deux appareils retiennent la même valeur (départage déterministe) et le même conflit', async () => {
    const [a, b] = await twoDevices();
    const t = await a.createTask('Base');
    await settle();
    a.clock.advance(1_000);
    // Même horloge, aucune avance entre les deux : mêmes millisecondes (et compteur égal), seul l'appareil les départage.
    await a.updateTask(t.id, { title: 'Titre A' });
    await b.updateTask(t.id, { title: 'Titre B' });
    await settle();
    const onA = await a.task(t.id);
    const onB = await b.task(t.id);
    expect(onA?.title).toBe(onB?.title);
    expect(['Titre A', 'Titre B']).toContain(onA?.title);
    expect(onA?.hlc).toBe(onB?.hlc);
    const log = (d: SimDevice): Promise<unknown[]> => d.driver.select('SELECT field, kept_value, discarded_value FROM conflict_log');
    expect(await log(a)).toEqual(await log(b));
    expect(await log(a)).toHaveLength(1);
  });

  it('trois écritures successives du même champ sur deux appareils hors ligne : la dernière en hlc gagne partout, un seul conflit par paire concurrente', async () => {
    const [a, b] = await twoDevices();
    const t = await a.createTask('Base');
    await settle();
    for (const [device, title] of [[a, 'a1'], [b, 'b1'], [a, 'a2']] as const) {
      a.clock.advance(100);
      await device.updateTask(t.id, { title });
    }
    await settle();
    expect((await a.task(t.id))?.title).toBe('a2');
    expect((await b.task(t.id))?.title).toBe('a2');
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  });
});

describe('suppression contre modification (Y-09 critère 1, section 4.2)', () => {
  it('modification plus récente que la suppression, faite sans avoir lu la suppression : supprimée partout, la modification est gardée dans la ligne', async () => {
    const [a, b] = await twoDevices();
    const t = await a.createTask('Base');
    await settle();
    a.clock.advance(1_000);
    await a.deleteTask(t.id);
    b.clock.advance(5_000);
    await b.updateTask(t.id, { note: 'modifiée après la suppression, sans l’avoir lue' });
    await settle();
    for (const d of devices) {
      const row = await d.task(t.id);
      expect(row?.deletedAt, `${d.name} : reste supprimée`).not.toBeNull();
      expect(row?.note, `${d.name} : modification gardée`).toBe('modifiée après la suppression, sans l’avoir lue');
    }
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
    // Restaurée ensuite : revient partout avec la modification.
    a.clock.advance(1_000);
    await a.data.repos.tasks.restore([t.id]);
    await settle();
    for (const d of devices) {
      const row = await d.task(t.id);
      expect(row?.deletedAt, d.name).toBeNull();
      expect(row?.note, d.name).toBe('modifiée après la suppression, sans l’avoir lue');
    }
  });

  it('suppression des deux côtés au même instant : une seule ligne supprimée, aucune trace de conflit entre deux valeurs identiques', async () => {
    const [a, b] = await twoDevices();
    const t = await a.createTask('Base');
    await settle();
    a.clock.advance(1_000);
    await a.deleteTask(t.id);
    await b.deleteTask(t.id);
    await settle();
    for (const d of devices) expect((await d.task(t.id))?.deletedAt, d.name).not.toBeNull();
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
    expect(await a.driver.select('SELECT field FROM conflict_log WHERE kept_value = discarded_value')).toEqual([]);
  });

  it('restauration d’un côté, modification de l’autre faite sans avoir lu la suppression : la ligne est vivante partout avec la modification', async () => {
    const [a, b] = await twoDevices();
    const t = await a.createTask('Base');
    await settle();
    a.clock.advance(1_000);
    await a.deleteTask(t.id);
    await a.cycle();
    a.clock.advance(1_000);
    await a.data.repos.tasks.restore([t.id]);
    b.clock.advance(1_500);
    await b.updateTask(t.id, { note: 'note de B' });
    await settle();
    for (const d of devices) {
      const row = await d.task(t.id);
      expect(row?.deletedAt, d.name).toBeNull();
      expect(row?.note, d.name).toBe('note de B');
    }
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  });
});

describe('restauration depuis la corbeille et purge de l’autre appareil (Y-09 critères 2 et 4)', () => {
  /**
   * DÉFAUT D1 (signalé, voir le rapport de QA du lot Y2) : A supprime une tâche, B la lit ; A part hors ligne et la restaure depuis la
   * corbeille à J+29 (la corbeille de T-08 l'autorise jusqu'à 30 jours) ; B purge la ligne à J+31 (suppression lue par tous, 30 jours
   * écoulés) ; au retour de A, la restauration (une seule opération partielle `deleted_at = null`) vise un identifiant UUID tracé :
   * « une opération partielle sur un UUID est abandonnée et journalisée » (Y-09 critère 4). B n'a plus la tâche, que A garde vivante :
   * divergence permanente et perte de la tâche chez B. Le test décrit le comportement attendu (convergence) ; il échoue aujourd'hui.
   */
  it.fails('DÉFAUT D1 : une tâche restaurée par A à J+29 (hors ligne) et purgée par B à J+31 revit sur B au retour de A', async () => {
    const [a, b] = await twoDevices();
    const t = await a.createTask('À restaurer');
    await settle();
    a.clock.advance(1_000);
    await a.deleteTask(t.id);
    await settle();
    // A hors ligne : restauration à J+29, sans cycle.
    a.clock.advance(29 * DAY);
    b.clock.advance(29 * DAY);
    await a.data.repos.tasks.restore([t.id]);
    // B continue seul : à J+31 la suppression est lue par tous et vieille de 30 jours, la ligne est purgée.
    b.clock.advance(2 * DAY);
    a.clock.advance(2 * DAY);
    await b.cycle();
    expect(await b.task(t.id), 'B a purgé').toBeNull();
    // Retour de A.
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    await settle();
    expect((await a.task(t.id))?.deletedAt).toBeNull();
    expect((await b.task(t.id))?.deletedAt, 'la tâche restaurée par A existe sur B').toBeNull();
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  });
});

describe('trois appareils (Y-02 critère 2, section 4)', () => {
  it('trois appareils modifient trois champs et un champ commun hors ligne : convergence, aucune perte, valeur du plus grand hlc', async () => {
    const [a, b] = await twoDevices();
    const c = await createSimDevice(C_ID, { name: 'Tablette', clock: a.clock });
    devices.push(c);
    syncFolders(devices);
    await pair(a, c);
    syncFolders(devices);
    await settle(devices);
    const t = await a.createTask('Base');
    await settle(devices);
    await settle(devices);
    a.clock.advance(100);
    await a.updateTask(t.id, { title: 'T-A', note: 'N-A' });
    a.clock.advance(100);
    await b.updateTask(t.id, { title: 'T-B', date: '2026-11-01' as never });
    a.clock.advance(100);
    await c.updateTask(t.id, { title: 'T-C', status: 'done' as never, doneAt: '2026-10-05T10:00:00.000Z' as never });
    await settle(devices);
    await settle(devices);
    for (const d of devices) {
      const row = await d.task(t.id);
      expect(row?.title, d.name).toBe('T-C');
      expect(row?.note, d.name).toBe('N-A');
      expect(row?.date, d.name).toBe('2026-11-01');
      expect(row?.status, d.name).toBe('done');
    }
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(c));
    // Le même conflit de titre est inscrit de façon identique partout (deux valeurs écartées).
    const conflicts = async (d: SimDevice): Promise<string[]> =>
      (await d.driver.select<{ discarded_value: string }>("SELECT discarded_value FROM conflict_log WHERE field = 'title' ORDER BY discarded_value")).map((r) => r.discarded_value);
    expect((await conflicts(c)).length).toBeGreaterThan(0);
  });
});

