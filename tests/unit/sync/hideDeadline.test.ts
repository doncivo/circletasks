import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createManualClock } from '../../../src/domain/clock';
import type { SyncNowOptions, SyncReason } from '../../../src/platform/sync/types';
import { createSyncService, HIDE_SYNC_DEADLINE_MS, startSyncScheduler, type DeadlineUnit } from '../../../src/sync';
import { createSimDevice, pair, SCHEMA_VERSION, setupFirst, syncFolders, taskSnapshot, warmSimDevices, type SimDevice } from '../../sim/syncDevice';

/**
 * Cycle borné du passage de l'iPhone en arrière-plan (ADR 0011 §22 point 6 ; Y-IOS-01 critères 9 à 11). L'échéance est comparée à
 * l'horloge injectée avant chaque unité atomique : propriété (modèle de la section 12) : un arrêt à chacune des frontières du cycle, puis
 * un cycle complet, donne des bases identiques à celles d'un cycle ininterrompu ; aucune écriture partielle, file gardée, aucun cycle
 * complet marqué, aucune erreur ni bandeau.
 */

const PC_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const IPHONE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DAY = 86_400_000;

let devices: SimDevice[] = [];
beforeAll(async () => {
  await warmSimDevices();
});
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

/** Service de l'iPhone dont l'échéance est observée (et, pour `stopAt`, atteinte juste avant la frontière de ce rang). */
function boundedService(device: SimDevice, stopAt: number | null, units: DeadlineUnit[]): void {
  let seen = 0;
  device.service = createSyncService({
    data: device.data,
    platform: device.platform,
    hlc: device.hlc,
    clock: device.clock,
    deviceId: device.id,
    devicePlatform: 'ios',
    sv: SCHEMA_VERSION,
    appVersion: '0.4.0',
    logger: device.logger,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    deadlineProbe: (unit) => {
      units.push(unit);
      if (stopAt !== null && seen === stopAt) device.clock.advance(HIDE_SYNC_DEADLINE_MS);
      seen += 1;
    },
  });
}

const hide = (device: SimDevice): Promise<void> => device.service.syncNow('hide', { deadlineAt: device.clock.nowMs() + HIDE_SYNC_DEADLINE_MS });

/**
 * PC et iPhone associés ; l'iPhone a des écritures à publier (dont un champ en conflit), le PC des lots à faire lire, et 38 jours plus
 * tard un instantané est dû (pages d'instantané) et une suppression purgeable (suppression de fichiers).
 */
async function scenario(): Promise<{ pc: SimDevice; iphone: SimDevice }> {
  const pc = await createSimDevice(PC_ID, { name: 'PC' });
  const iphone = await createSimDevice(IPHONE_ID, { name: 'iPhone', clock: pc.clock });
  devices = [pc, iphone];
  await setupFirst(pc);
  await pc.cycle();
  await pair(pc, iphone);
  await iphone.cycle();
  syncFolders(devices);
  await pc.cycle();
  syncFolders(devices);
  const shared = await pc.createTask('Partagée');
  const gone = await pc.createTask('Supprimée');
  await pc.cycle();
  syncFolders(devices);
  await iphone.cycle();
  syncFolders(devices);
  pc.clock.advance(1_000);
  await pc.deleteTask(gone.id);
  await pc.updateTask(shared.id, { note: 'note du PC' });
  await pc.createTask('Nouvelle du PC');
  await pc.cycle();
  syncFolders(devices);
  pc.clock.advance(38 * DAY);
  await iphone.createTask('Écrite sur l’iPhone');
  await iphone.updateTask(shared.id, { title: 'Titre de l’iPhone' });
  return { pc, iphone };
}

async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    for (const d of devices) {
      expect((await d.cycle()).phase).toBe('idle');
      syncFolders(devices);
    }
  }
}

/** Heure de dernière synchro complète gardée (`sync_state`, ligne de cet appareil). */
async function lastSyncRow(device: SimDevice): Promise<string | null> {
  return (await device.data.repos.sync.getStates()).find((row) => row.isSelf)?.lastSyncAt ?? null;
}

/** Bases après convergence (tâches des deux appareils, files, intentions, conflits). */
async function converged(): Promise<unknown> {
  const out: unknown[] = [];
  for (const d of devices) {
    // Identifiants tirés d'un compteur du simulateur (différents d'une exécution à l'autre) : comparaison par valeurs.
    const rows = (await taskSnapshot(d)) as Record<string, unknown>[];
    out.push(rows.map(({ id: _id, ...rest }) => rest).sort((x, y) => String(x['title']).localeCompare(String(y['title']))));
    expect(await d.data.repos.sync.outboxCount(), `file de ${d.name}`).toBe(0);
    expect(await d.data.repos.sync.getMeta('inflight'), `intention de ${d.name}`).toBeNull();
    expect(await d.driver.select('SELECT field FROM conflict_log WHERE kept_value = discarded_value'), `conflit inventé sur ${d.name}`).toEqual([]);
  }
  return out;
}

// Frontières du cycle `hide` de l'iPhone dans le scénario (mesurées à la collecte : le moteur peut changer, la couverture suit).
const BOUNDARIES: DeadlineUnit[] = [];
let BASELINE: unknown = null;
{
  await warmSimDevices();
  const { iphone } = await scenario();
  boundedService(iphone, null, BOUNDARIES);
  await hide(iphone);
  expect(iphone.service.status().phase).toBe('idle');
  await settle();
  BASELINE = await converged();
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
}

describe('Y-IOS-01 critère 9 : arrêt à chaque frontière du cycle borné, puis cycle complet', () => {
  it('le cycle passe par chaque type d’unité atomique', () => {
    for (const unit of ['scan', 'read-page', 'append', 'write-state', 'snapshot', 'finish'] satisfies DeadlineUnit[]) {
      expect(BOUNDARIES, unit).toContain(unit);
    }
  });

  it.each(BOUNDARIES.map((unit, index) => [index, unit] as const))('arrêt avant la frontière %i (%s) : rien de perdu, bases identiques au cycle ininterrompu', async (index) => {
    const { iphone } = await scenario();
    const queued = await iphone.data.repos.sync.outboxCount();
    expect(queued).toBeGreaterThan(0);
    const synced = await lastSyncRow(iphone);
    const units: DeadlineUnit[] = [];
    boundedService(iphone, index, units);
    const before = iphone.service.status();
    await hide(iphone);
    const after = iphone.service.status();
    // Critère 11 : ni panne ni bandeau, aucun cycle complet marqué, heure de dernière synchro inchangée.
    expect(after.phase).not.toBe('error');
    expect(after.phase).not.toBe('syncing');
    expect(after.errorCode ?? null).toBeNull();
    expect(after.lastSyncAt).toBe(before.lastSyncAt);
    expect(await lastSyncRow(iphone), 'sync_state : dernière synchro inchangée').toBe(synced);
    expect(iphone.logger.entries.filter((e) => e.event === 'cycle-interrupted')).toHaveLength(1);
    expect(units).toHaveLength(index + 1);
    // Critère 10 : le cycle d'ouverture suivant, non borné, reprend sans doublon.
    await settle();
    expect(await converged()).toEqual(BASELINE);
  });
});

describe('Y-IOS-01 critères 10 et 11 : seule la fermeture est bornée', () => {
  it('les cycles d’ouverture, périodique, manuel et « Quitter » ignorent une échéance', async () => {
    const { iphone } = await scenario();
    const units: DeadlineUnit[] = [];
    boundedService(iphone, 0, units);
    for (const reason of ['open', 'timer', 'manual', 'quit', 'tray'] satisfies SyncReason[]) {
      await iphone.service.syncNow(reason, { deadlineAt: iphone.clock.nowMs() - 1 });
    }
    expect(units).toEqual([]);
    expect(iphone.service.status().phase).toBe('idle');
  });

  it('trois interruptions de suite : aucune erreur, aucune heure de synchro avancée ; le cycle d’ouverture conclut', async () => {
    const { iphone } = await scenario();
    const before = await lastSyncRow(iphone);
    for (let i = 0; i < 3; i += 1) {
      boundedService(iphone, i, []);
      await hide(iphone);
      expect(iphone.service.status().phase).not.toBe('error');
      expect(iphone.service.status().lastSyncAt).toBeNull();
      expect(await lastSyncRow(iphone)).toBe(before);
    }
    const status = await iphone.cycle();
    expect(status.phase).toBe('idle');
    expect(status.lastSyncAt).not.toBeNull();
    expect(await lastSyncRow(iphone)).not.toBe(before);
  });

  it('une demande non bornée qui attend avec le cycle de fermeture le rend non borné', async () => {
    const { iphone } = await scenario();
    const units: DeadlineUnit[] = [];
    boundedService(iphone, 0, units);
    // Un cycle en cours, puis « fermeture » et « ouverture » demandées pendant lui : un seul cycle de plus, non borné.
    const first = iphone.service.syncNow('manual');
    const hidden = hide(iphone);
    const opened = iphone.service.syncNow('open');
    await Promise.all([first, hidden, opened]);
    expect(units).toEqual([]);
    expect(iphone.service.status().phase).toBe('idle');
  });
});

describe('planificateur de l’iPhone (ADR 0011 §22 point 6)', () => {
  function fakeDocument() {
    const listeners = new Set<() => void>();
    const doc = {
      visibilityState: 'visible' as DocumentVisibilityState,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
      set(state: DocumentVisibilityState) {
        doc.visibilityState = state;
        for (const l of listeners) l();
      },
    };
    return doc;
  }

  it('iPhone : masquage → cycle `hide` borné à 25 s, lancé dans le gestionnaire ; retour → cycle `open`', () => {
    const clock = createManualClock('2026-10-05T08:00:00.000Z');
    const calls: [SyncReason, SyncNowOptions | undefined][] = [];
    const doc = fakeDocument();
    const scheduler = startSyncScheduler(
      { syncNow: async (r, o) => void calls.push([r, o]) },
      { document: doc as unknown as Document, clock, setInterval: () => 0, clearInterval: () => undefined, hideDeadlineMs: HIDE_SYNC_DEADLINE_MS },
    );
    expect(HIDE_SYNC_DEADLINE_MS).toBe(25_000);
    doc.set('hidden');
    // Synchrone : l'appel part avant que la WebView soit suspendue.
    expect(calls.at(-1)).toEqual(['hide', { deadlineAt: clock.nowMs() + 25_000 }]);
    clock.advance(60_000);
    doc.set('visible');
    expect(calls.at(-1)).toEqual(['open', undefined]);
    scheduler.dispose();
  });

  it('PC : masquage → cycle `hide` sans échéance ; retour → sondage des 5 minutes seulement', () => {
    const clock = createManualClock('2026-10-05T08:00:00.000Z');
    const calls: [SyncReason, SyncNowOptions | undefined][] = [];
    const doc = fakeDocument();
    const scheduler = startSyncScheduler({ syncNow: async (r, o) => void calls.push([r, o]) }, { document: doc as unknown as Document, clock, setInterval: () => 0, clearInterval: () => undefined });
    doc.set('hidden');
    expect(calls.at(-1)).toEqual(['hide', undefined]);
    doc.set('visible');
    expect(calls).toHaveLength(2);
    scheduler.dispose();
  });
});

describe('Y-IOS-01 QA : cycles `hide` successifs, chacun coupé à une frontière différente', () => {
  it('aucune perte, aucun doublon : la file ne grossit jamais, la dernière synchro n’avance pas, le cycle suivant reprend', async () => {
    const { iphone } = await scenario();
    const before = await lastSyncRow(iphone);
    let queued = await iphone.data.repos.sync.outboxCount();
    expect(queued).toBeGreaterThan(0);
    // Une coupure par frontière, dans l'ordre, sans cycle complet entre elles (l'iPhone repasse en arrière-plan à chaque fois).
    for (let index = 0; index < BOUNDARIES.length; index += 1) {
      const units: DeadlineUnit[] = [];
      boundedService(iphone, index, units);
      await hide(iphone);
      const status = iphone.service.status();
      expect(status.phase, `coupure ${String(index)}`).not.toBe('error');
      expect(status.errorCode ?? null).toBeNull();
      // Le travail déjà publié raccourcit le cycle : au-delà de sa dernière frontière il va à son terme (légitime, et seulement là).
      if (units.length !== index + 1) {
        expect(index, 'un cycle ne finit plus tôt que si le travail précédent l’a raccourci').toBeGreaterThan(0);
        break;
      }
      expect(await lastSyncRow(iphone), `coupure ${String(index)} : aucun cycle complet marqué`).toBe(before);
      const left = await iphone.data.repos.sync.outboxCount();
      expect(left, `coupure ${String(index)} : la file ne grossit pas`).toBeLessThanOrEqual(queued);
      queued = left;
      syncFolders(devices);
    }
    await settle();
    expect(await converged()).toEqual(BASELINE);
  });

  it('même coupure à chaque passage en arrière-plan (3 unités par cycle) : le travail publié s’accumule, le cycle d’ouverture conclut sans doublon', async () => {
    const { iphone } = await scenario();
    for (let round = 0; round < 4; round += 1) {
      boundedService(iphone, 3, []);
      await hide(iphone);
      expect(iphone.service.status().phase).not.toBe('error');
      syncFolders(devices);
    }
    await settle();
    expect(await converged()).toEqual(BASELINE);
  });
});

describe('Y-IOS-01 QA : hydratation qui dépasse son budget (échéance moins 2 s)', () => {
  it('fichiers du PC encore dans le nuage, téléchargement de 30 s pour 23 s de budget : attente visible, pas de panne, rien de perdu ; l’ouverture suivante lit', async () => {
    const { pc, iphone } = await scenario();
    await pc.createTask('Arrivée tardive');
    await pc.cycle();
    syncFolders(devices, { placeholder: true });
    iphone.platform.testing.setHydrationDelay(30_000);
    boundedService(iphone, null, []);
    await hide(iphone);
    const status = iphone.service.status();
    expect(status.phase).not.toBe('error');
    expect(status.errorCode ?? null).toBeNull();
    expect(iphone.platform.testing.hydrationBudgetLeft(), 'budget du cycle épuisé, jamais dépassé').toBe(0);
    expect(status.pendingFiles.length, 'les fichiers attendus sont listés (« En attente d’iCloud »)').toBeGreaterThan(0);
    expect((await iphone.driver.select("SELECT id FROM task WHERE title = 'Arrivée tardive' AND deleted_at IS NULL")).length > 0).toBe(false);
    // L'écriture de l'iPhone n'a pas été perdue par l'attente.
    expect(await iphone.data.repos.sync.getMeta('inflight')).toBeNull();
    // Cycle d'ouverture (3 minutes de budget) : le téléchargement tient, la tâche arrive.
    iphone.platform.testing.setHydrationDelay(1_000);
    const reopened = await iphone.cycle();
    expect(reopened.phase).not.toBe('error');
    expect((await iphone.driver.select("SELECT id FROM task WHERE title = 'Arrivée tardive' AND deleted_at IS NULL")).length > 0).toBe(true);
    // Revue (QA) : les instantanés du PC jamais lus (restés dans le nuage, aucun épinglage sur iPhone) ne tiennent pas l'iPhone « en attente
    // d'iCloud » : seuls les fichiers dont le lecteur a besoin comptent.
    expect(reopened.pendingFiles).toEqual([]);
    expect(reopened.phase).toBe('idle');
  });
});
