import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { compareEpochs, type EpochId } from '../../../src/domain/sync/format';
import { setEpochSwitchTestHooks, type SwitchStep } from '../../../src/sync/epochSwitch';
import { armCrash } from '../../sim/syncCrash';
import { syncFolders, taskSnapshot, warmSimDevices, type SimDevice } from '../../sim/syncDevice';
import { B_ID, backupOf, C_ID, closeAll, restoreBackup, setupRoom, type Room } from './reset/resetKit';

/**
 * Y-TECH-01, QA : positions locales après un remplacement ou « Appliquer partout » (aucun accusé {époque, 0, 0} sur un appareil qui n'a rien
 * publié dans l'époque ; jamais en recul), arrêt brutal à chaque écriture et à chaque étape (a, b, c) du changement d'époque, aucune lecture
 * sautée (bases identiques sur A, B et C, C revenu après coup). Aucun délai : compteur d'écritures et crochet `afterStep`.
 */

const room: Room = { devices: [] };
beforeAll(warmSimDevices);
afterEach(async () => {
  setEpochSwitchTestHooks({});
  await closeAll(room);
});

type Row = {
  readonly device_id: string;
  readonly is_self: number;
  readonly epoch: string | null;
  readonly cursor_segment: number;
  readonly cursor_record: number;
  readonly ack_hlc: string | null;
}
const rows = (d: SimDevice): Promise<Row[]> => d.driver.select<Row>('SELECT device_id, is_self, epoch, cursor_segment, cursor_record, ack_hlc FROM sync_state ORDER BY device_id');

interface PublishedAck {
  readonly epoch: string;
  readonly segment: number;
  readonly record: number;
  readonly hlc: string | null;
}
const publishedAcks = (of: SimDevice): Record<string, PublishedAck> => (JSON.parse(of.folder.devices.get(of.id)?.state?.lines[0]?.text ?? '{}') as { acks?: Record<string, PublishedAck> }).acks ?? {};

/** Ordre des positions : époque (absence la plus basse), puis segment, puis enregistrement. */
function compare(a: { epoch: string | null; segment: number; record: number }, b: { epoch: string | null; segment: number; record: number }): number {
  if (a.epoch === null || b.epoch === null) return a.epoch === b.epoch ? 0 : a.epoch === null ? -1 : 1;
  const e = compareEpochs(a.epoch as EpochId, b.epoch as EpochId);
  if (e !== 0) return e;
  return a.segment !== b.segment ? a.segment - b.segment : a.record - b.record;
}
const at = (r: Row): { epoch: string | null; segment: number; record: number } => ({ epoch: r.epoch, segment: r.cursor_segment, record: r.cursor_record });

/** Aucune ligne d'un autre appareil n'est un début d'époque `target` sans rien lu (un accusé {target, 0, 0} que personne n'a mérité). */
function expectNoZeroAck(list: readonly Row[], target: string, who: string, label: string, except: readonly string[] = []): void {
  for (const r of list) {
    if (r.is_self === 1 || except.includes(r.device_id)) continue;
    const zero = r.epoch === target && r.cursor_segment === 0 && r.cursor_record === 0 && r.ack_hlc === null;
    expect(zero, `${label} : ${who} garde une position {${target}, 0, 0} pour ${r.device_id.slice(0, 4)}`).toBe(false);
  }
}

interface Scene {
  readonly a: SimDevice;
  readonly b: SimDevice;
  readonly c: SimDevice;
  readonly target: string;
  /** Accusés publiés par A juste avant la restauration. */
  readonly aAcksBefore: Record<string, PublishedAck>;
  /** Accusés publiés par B avant le changement d'époque. */
  readonly bAcksBefore: Record<string, PublishedAck>;
}

/**
 * A, B, C synchronisés ; C s'éteint avec une écriture non publiée. A écrit, B lit et écrit, A relit ; A restaure une sauvegarde plus ancienne
 * et « Appliquer partout » (époque 2 ouverte par A, remplacement chez les autres).
 */
async function scene(): Promise<Scene> {
  const [a, b, c] = (await setupRoom(room, [B_ID, C_ID])) as [SimDevice, SimDevice, SimDevice];
  const online = [a, b];
  const copy = await backupOf(a);
  a.clock.advance(1_000);
  await a.createTask('A après la sauvegarde');
  for (let i = 0; i < 2; i += 1) {
    for (const d of online) {
      await d.cycle();
      syncFolders(online);
    }
  }
  b.clock.advance(1_000);
  await b.createTask('B publiée');
  for (let i = 0; i < 2; i += 1) {
    for (const d of online) {
      await d.cycle();
      syncFolders(online);
    }
  }
  await c.createTask('C hors ligne, jamais publiée');
  const aAcksBefore = publishedAcks(a);
  const bAcksBefore = publishedAcks(b);
  await restoreBackup(a, copy);
  const target = await a.service.chooseRestoreOption('apply-everywhere').then(async () => (await a.data.repos.sync.getMeta('epoch')) as string);
  const parsed = JSON.parse(target) as string;
  syncFolders(online);
  return { a, b, c, target: parsed, aAcksBefore, bAcksBefore };
}

describe('Y-TECH-01 QA : « Appliquer partout » (applyEverywhere), positions de l\'ouvreur', () => {
  it('aucun {époque, 0, 0} pour B et C (n\'ont rien publié dans la cible) ; jamais en recul sur le dernier état publié avant la restauration', async () => {
    const s = await scene();
    const list = await rows(s.a);
    expectNoZeroAck(list, s.target, 'A', 'ouvreur');
    for (const r of list) {
      if (r.is_self === 1) continue;
      const before = s.aAcksBefore[r.device_id];
      if (!before) continue;
      expect(compare(at(r), { epoch: before.epoch, segment: before.segment, record: before.record }), `A ne recule pas sur ${r.device_id.slice(0, 4)}`).toBeGreaterThanOrEqual(0);
    }
    // Le nouvel état publié ne porte aucun accusé {cible, 0, 0}.
    await s.a.cycle();
    for (const [id, ack] of Object.entries(publishedAcks(s.a))) {
      expect(ack.epoch === s.target && ack.segment === 0 && ack.record === 0, `accusé publié par A pour ${id.slice(0, 4)}`).toBe(false);
    }
  });
});

/** Écritures de `device` pendant un cycle (comptage seul) : points d'arrêt à éprouver. */
async function writesOfSwitch(): Promise<number> {
  const s = await scene();
  const probe = armCrash(s.b, null);
  await s.b.cycle();
  const n = probe.writes;
  probe.disarm();
  await closeAll(room);
  return n;
}

const SWITCH_WRITES = await writesOfSwitch();

/** Quatre tours A, B (iCloud A-B recopié après chacun) ; observe les lignes de B après chaque cycle. */
async function converge(s: Scene, observe: (label: string) => Promise<void>): Promise<void> {
  const online = [s.a, s.b];
  await s.a.createTask('A tardive');
  for (let round = 0; round < 4; round += 1) {
    for (const d of online) {
      await d.cycle();
      syncFolders(online);
      await observe(`tour ${String(round)} ${d.name}`);
    }
  }
  // C revient (avec son écriture hors ligne) : lui aussi converge, remplacement chez C compris.
  syncFolders(room.devices);
  for (let round = 0; round < 4; round += 1) {
    for (const d of room.devices) {
      await d.cycle();
      syncFolders(room.devices);
      await observe(`retour de C, tour ${String(round)} ${d.name}`);
    }
  }
}

async function expectConverged(s: Scene, label: string): Promise<void> {
  const expected = await taskSnapshot(s.a);
  for (const d of [s.b, s.c]) expect(await taskSnapshot(d), `${label} : ${d.name} identique à A`).toEqual(expected);
  const titles = (await s.a.driver.select<{ title: string }>('SELECT title FROM task WHERE deleted_at IS NULL ORDER BY title')).map((r) => r.title);
  expect(titles, `${label} : écritures d'après la restauration et de C hors ligne`).toEqual(expect.arrayContaining(['A tardive', 'C hors ligne, jamais publiée']));
  for (const d of room.devices) {
    expect(await d.data.repos.sync.outboxCount(), `${label} : file de ${d.name}`).toBe(0);
    expect(await d.driver.select('SELECT * FROM sync_guard'), `${label} : sync_guard de ${d.name}`).toEqual([]);
  }
}

/** Observateur des lignes d'un appareil : jamais en recul d'une observation à l'autre, jamais {cible, 0, 0} pour un appareil qui n'y a rien publié. */
function watcher(s: Scene, who: SimDevice): { observe: (label: string) => Promise<void>; seen: Map<string, { epoch: string | null; segment: number; record: number }> } {
  const seen = new Map<string, { epoch: string | null; segment: number; record: number }>();
  const observe = async (label: string): Promise<void> => {
    const list = await rows(who);
    // Les appareils qui ont publié dans la cible (A, l'ouvreur) peuvent légitimement être au début de la cible ; C n'y a rien publié tant qu'il est éteint.
    const published = [s.a.id, who.id];
    if (!s.c.folder.devices.get(s.c.id)?.state || (JSON.parse(s.c.folder.devices.get(s.c.id)?.state?.lines[0]?.text ?? '{}') as { epoch?: string }).epoch !== s.target) {
      expectNoZeroAck(list, s.target, who.name, label, published);
    }
    for (const r of list) {
      const now = at(r);
      const before = seen.get(r.device_id);
      if (before) expect(compare(now, before), `${label} : position de ${who.name} sur ${r.device_id.slice(0, 4)} en recul (${JSON.stringify(before)} -> ${JSON.stringify(now)})`).toBeGreaterThanOrEqual(0);
      seen.set(r.device_id, now);
    }
    for (const [id, ack] of Object.entries(publishedAcks(who))) {
      if (id === s.a.id || id === who.id) continue;
      expect(ack.epoch === s.target && ack.segment === 0 && ack.record === 0, `${label} : accusé publié par ${who.name} pour ${id.slice(0, 4)}`).toBe(false);
    }
  };
  return { observe, seen };
}

describe('Y-TECH-01 QA : remplacement chez B, arrêt brutal avant chaque écriture du cycle', () => {
  it('le cycle de changement d\'époque compte au moins une écriture', () => {
    expect(SWITCH_WRITES).toBeGreaterThan(0);
  });

  it.each(Array.from({ length: SWITCH_WRITES }, (_, i) => i + 1))('arrêt juste avant l\'écriture %i : positions jamais en recul, aucun {cible, 0, 0} pour C, bases identiques', async (n) => {
    const s = await scene();
    const w = watcher(s, s.b);
    await w.observe('avant le cycle');
    const probe = armCrash(s.b, n);
    await s.b.cycle();
    expect(probe.crashed, `l'écriture ${String(n)} existe`).toBe(true);
    probe.disarm();
    await w.observe(`juste après l'arrêt avant l'écriture ${String(n)}`);
    await s.b.restart();
    await converge(s, w.observe);
    await expectConverged(s, `arrêt avant l'écriture ${String(n)}`);
  });

  it.each<SwitchStep>(['a', 'b', 'c'])('arrêt juste après l\'étape (%s) du changement d\'époque : même garanties, lecture de A reprise sans saut', async (step) => {
    const s = await scene();
    const w = watcher(s, s.b);
    await w.observe('avant le cycle');
    setEpochSwitchTestHooks({
      afterStep: (done) => {
        if (done === step) throw new Error('arrêt simulé');
      },
    });
    await s.b.cycle();
    setEpochSwitchTestHooks({});
    await w.observe(`juste après l'arrêt après l'étape ${step}`);
    await s.b.restart();
    await converge(s, w.observe);
    await expectConverged(s, `arrêt après l'étape ${step}`);
  });

  it('sans arrêt : même garanties (référence)', async () => {
    const s = await scene();
    const w = watcher(s, s.b);
    await w.observe('avant le cycle');
    await converge(s, w.observe);
    await expectConverged(s, 'sans arrêt');
  });
});

describe('Y-TECH-01 QA : positions de B juste après le remplacement (cas de référence chiffré)', () => {
  it('B a bien remplacé sa base ; sa ligne de C reste dans l\'ancienne époque (ou absente), celle de A (ouvreur) démarre la cible', async () => {
    const s = await scene();
    const before = (await rows(s.b)).find((r) => r.device_id === s.c.id);
    expect(before?.epoch, 'avant : C lu dans l\'ancienne époque').not.toBe(s.target);
    await s.b.cycle();
    expect(s.b.logger.entries.some((e) => e.event === 'epoch-switched'), 'B a changé d\'époque').toBe(true);
    const after = await rows(s.b);
    const ofC = after.find((r) => r.device_id === s.c.id);
    expect(ofC?.epoch === s.target, 'C n\'est pas placé au début de la cible').toBe(false);
    if (ofC?.epoch !== null && ofC?.epoch !== undefined) expect(compare(at(ofC), { epoch: before?.epoch ?? null, segment: before?.cursor_segment ?? 0, record: before?.cursor_record ?? 0 }), 'jamais en recul sur la position précédente').toBeGreaterThanOrEqual(0);
    const ofA = after.find((r) => r.device_id === s.a.id);
    expect(ofA?.epoch, 'A, l\'ouvreur, est lu depuis le début de la cible').toBe(s.target);
  });
});
