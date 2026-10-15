import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DataAccess, Repositories } from '../../../../src/db/repositories';
import { SyncStateUnreadableError } from '../../../../src/domain/sync/stored';
import type { DeviceId, IsoDateTime } from '../../../../src/domain/types';
import type { ForgetStep, SyncPlatform } from '../../../../src/platform/sync/types';
import { createMemorySyncLogger, createSyncService } from '../../../../src/sync';
import type { SyncDeps } from '../../../../src/sync/deps';
import { cancelForgetRequest, declareForget, FORGET_META, readForgetStatus } from '../../../../src/sync/forget';
import { createSimDevice, pair, SCHEMA_VERSION, setupFirst, syncFolders, type SimDevice } from '../../../sim/syncDevice';

/**
 * Y-10-FIX-01 « Annuler la demande » (critères 3 à 7, 9, 12, 13) : partie moteur.
 * - `cancelForgetRequest` seule, sur de faux dépôts (`sync_meta` en mémoire) et une plateforme dont tout accès fait échouer le test
 *   (critère 4) ;
 * - la façade `service.cancelForgetRequest` sous la même plateforme interdite (relecture de l'état comprise) ;
 * - scénario réel sur des appareils simulés (vrai service, plateforme mémoire dans le rôle de Rust : boîte native refusée puis
 *   `rate-limited`, blocage de 10 minutes) : annulation, redémarrage, aucune reprise automatique. Horloge contrôlée, aucun délai réel.
 *
 * D2 (corrigée en revue, 2026-10-15) : l'annulation ne modifie **jamais** l'intention `forgetPublish` (`declareForget` la restaure déjà).
 */

const PC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as DeviceId;
const PHONE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as DeviceId;
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as DeviceId;
const AT = '2026-10-10T08:00:00.000Z' as IsoDateTime;
const TEN_MINUTES = 10 * 60_000;

// ---------------------------------------------------------------------------------------------------------------------------------
// Faux dépôts et plateforme interdite
// ---------------------------------------------------------------------------------------------------------------------------------

interface FakeStore {
  readonly meta: Map<string, string>;
  readonly writes: string[];
  /** Toute écriture est refusée (base occupée, disque plein). */
  failWrites: boolean;
}

function fakeData(store: FakeStore): DataAccess {
  const repos = {
    sync: {
      getMeta: async (key: string) => store.meta.get(key) ?? null,
      setMeta: async (key: string, value: string | null) => {
        if (store.failWrites) throw Object.assign(new Error('écriture refusée'), { code: 'io' });
        store.writes.push(key);
        if (value === null) store.meta.delete(key);
        else store.meta.set(key, value);
      },
    },
  } as unknown as Repositories;
  return { repos, transaction: (work) => work(repos) };
}

/** Plateforme dont tout accès (Rust, boîte native, iCloud) fait échouer le test (même méthode que `forgetScope.test.ts`). */
function forbiddenPlatform(touched: string[]): SyncPlatform {
  return new Proxy({} as SyncPlatform, {
    get(_target, property) {
      touched.push(String(property));
      throw new Error(`plateforme appelée : ${String(property)}`);
    },
  });
}

function setup(meta: Record<string, unknown> = {}, platform?: SyncPlatform): { deps: SyncDeps; store: FakeStore; touched: string[]; logger: ReturnType<typeof createMemorySyncLogger> } {
  const store: FakeStore = { meta: new Map(Object.entries(meta).map(([k, v]) => [k, JSON.stringify(v)])), writes: [], failWrites: false };
  const touched: string[] = [];
  const logger = createMemorySyncLogger();
  const deps = {
    data: fakeData(store),
    platform: platform ?? forbiddenPlatform(touched),
    clock: { nowMs: () => Date.parse(AT) },
    deviceId: PHONE,
    devicePlatform: 'ios',
    appVersion: '0.3.1',
    sv: 1,
    logger,
  } as unknown as SyncDeps;
  return { deps, store, touched, logger };
}

const failureOf = (deviceId: DeviceId, step: ForgetStep, code = 'rate-limited') => ({ deviceId, code, at: AT, step });
const metaOf = (store: FakeStore, key: string): unknown => (store.meta.has(key) ? (JSON.parse(store.meta.get(key) as string) as unknown) : null);

describe('cancelForgetRequest : effet (critère 3)', () => {
  it.each([true, null])('intention forgetPublish = %s : mémo effacé, intention inchangée (D2), forget-cancelled sans contenu, aucun appel plateforme', async (publish) => {
    const { deps, store, touched, logger } = setup({ [FORGET_META.failure]: failureOf(PC, 'declare'), ...(publish === null ? {} : { [FORGET_META.publish]: publish }) });
    expect(await cancelForgetRequest(deps, PC)).toEqual({ kind: 'cancelled' });
    expect(metaOf(store, FORGET_META.failure)).toBeNull();
    expect(metaOf(store, FORGET_META.publish)).toBe(publish);
    expect(store.writes).toEqual([FORGET_META.failure]);
    expect(logger.entries).toEqual([{ event: 'forget-cancelled', detail: { device: PC } }]);
    expect(touched).toEqual([]);
  });
});

describe('cancelForgetRequest : idempotence et portée (critère 6)', () => {
  it('échec déjà disparu : nothing, rien écrit, rien journalisé, aucun appel plateforme ; deux annulations de suite : la seconde ne fait rien', async () => {
    const { deps, store, touched, logger } = setup({ [FORGET_META.failure]: failureOf(PC, 'declare'), [FORGET_META.publish]: true });
    expect(await cancelForgetRequest(deps, PC)).toEqual({ kind: 'cancelled' });
    const writes = store.writes.length;
    expect(await cancelForgetRequest(deps, PC)).toEqual({ kind: 'nothing' });
    expect(store.writes).toHaveLength(writes);
    expect(logger.entries.filter((e) => e.event === 'forget-cancelled')).toHaveLength(1);
    expect(touched).toEqual([]);
  });

  it('échec d’un autre appareil : jamais touché', async () => {
    const { deps, store } = setup({ [FORGET_META.failure]: failureOf(OTHER, 'declare'), [FORGET_META.publish]: true });
    expect(await cancelForgetRequest(deps, PC)).toEqual({ kind: 'nothing' });
    expect(metaOf(store, FORGET_META.failure)).toEqual(failureOf(OTHER, 'declare'));
    expect(store.writes).toEqual([]);
  });

  it.each<ForgetStep>(['delete', 'rejoin', 'overflow', 'revived'])('étape %s : rien n’est annulé (l’oubli publié ne s’annule pas)', async (step) => {
    const { deps, store } = setup({ [FORGET_META.failure]: failureOf(PC, step) });
    expect(await cancelForgetRequest(deps, PC)).toEqual({ kind: 'nothing' });
    expect(store.writes).toEqual([]);
  });

  it('QA 7 (a), inverse : échec de déclaration d’un autre appareil, puis oubli du PC réussi : l’échec de l’autre appareil reste', async () => {
    const platform = { forget: { device: async () => undefined } } as unknown as SyncPlatform;
    const { deps, store } = setup({ [FORGET_META.failure]: failureOf(OTHER, 'declare') }, platform);
    expect(await declareForget(deps, PC)).toEqual({ kind: 'done' });
    expect(metaOf(store, FORGET_META.failure)).toEqual(failureOf(OTHER, 'declare'));
  });
});

describe('cancelForgetRequest : lecture illisible et écriture refusée (critère 12)', () => {
  it('écriture refusée : l’erreur est propagée, l’échec d’origine et l’intention restent, rien n’est journalisé comme annulé', async () => {
    const { deps, store, logger } = setup({ [FORGET_META.failure]: failureOf(PC, 'declare'), [FORGET_META.publish]: true });
    store.failWrites = true;
    await expect(cancelForgetRequest(deps, PC)).rejects.toMatchObject({ code: 'io' });
    expect(metaOf(store, FORGET_META.failure)).toEqual(failureOf(PC, 'declare'));
    expect(metaOf(store, FORGET_META.publish)).toBe(true);
    expect(logger.entries).toEqual([]);
  });

  it('mémo d’échec illisible (JSON invalide) : jamais lu comme absent ; state-unreadable journalisé par le journal du moteur, propagé, rien écrit', async () => {
    const { deps, store, logger } = setup();
    store.meta.set(FORGET_META.failure, '{pas du json');
    await expect(cancelForgetRequest(deps, PC)).rejects.toBeInstanceOf(SyncStateUnreadableError);
    expect(store.writes).toEqual([]);
    expect(logger.entries).toEqual([{ event: 'state-unreadable', detail: { where: `sync_meta.${FORGET_META.failure}` } }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Scénario réel : iPhone qui oublie le PC (séance 0.3.0)
// ---------------------------------------------------------------------------------------------------------------------------------

let devices: SimDevice[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

/**
 * PC et iPhone associés (et un second PC si demandé), à jour ; puis la séance 0.3.0 : boîte native refusée, puis « trop de demandes »
 * (rate-limited) sur l'oubli de `target`.
 */
async function rateLimitedPhone(options: { readonly withOther?: boolean; readonly target?: DeviceId } = {}): Promise<{ pc: SimDevice; phone: SimDevice }> {
  const target = options.target ?? PC;
  const pc = await createSimDevice(PC, { name: 'PC' });
  devices = [pc];
  await setupFirst(pc);
  await pc.cycle();
  const phone = await createSimDevice(PHONE, { name: 'iPhone', clock: pc.clock, devicePlatform: 'ios' });
  devices.push(phone);
  await pair(pc, phone);
  if (options.withOther) {
    const other = await createSimDevice(OTHER, { name: 'PC2', clock: pc.clock });
    devices.push(other);
    await pair(pc, other);
  }
  for (let i = 0; i < 2; i += 1) {
    for (const d of devices) {
      syncFolders(devices);
      d.clock.advance(1_000);
      await d.cycle();
    }
  }
  phone.platform.testing.setConsent(false);
  expect(await phone.service.forgetDevice(target)).toEqual({ kind: 'cancelled' });
  phone.platform.testing.setConsent(true);
  expect(await phone.service.forgetDevice(target)).toEqual({ kind: 'failed', code: 'rate-limited' });
  expect(phone.service.status().forget?.failure).toMatchObject({ deviceId: target, code: 'rate-limited', step: 'declare' });
  return { pc, phone };
}

/** Valeurs de `sync_meta` propres à l'oubli (texte brut). */
const forgetMeta = async (d: SimDevice): Promise<(string | null)[]> => Promise.all([FORGET_META.failure, FORGET_META.publish, FORGET_META.declarations].map((k) => d.data.repos.sync.getMeta(k)));

describe('façade service.cancelForgetRequest (critère 4, QA 6)', () => {
  it('plateforme sous Proxy intégral (tout accès fait échouer le test) : annulation et relecture de l’état sans un seul accès', async () => {
    const { phone } = await rateLimitedPhone();
    const touched: string[] = [];
    const service = createSyncService({
      data: phone.data,
      platform: forbiddenPlatform(touched),
      hlc: phone.hlc,
      clock: phone.clock,
      deviceId: PHONE,
      devicePlatform: 'ios',
      sv: SCHEMA_VERSION,
      appVersion: '0.4.0',
      logger: createMemorySyncLogger(),
      setTimeout: () => 0,
      clearTimeout: () => undefined,
    });
    expect(await service.cancelForgetRequest(PC)).toEqual({ kind: 'cancelled' });
    expect(touched).toEqual([]);
    expect(service.status().forget ?? null).toBeNull();
    expect(service.status().stateUnreadable).toBeUndefined();
    expect(await phone.data.repos.sync.getMeta(FORGET_META.failure)).toBeNull();
  });

  it('QA 7 (b) : deux annulations enfilées : cancelled puis nothing, un seul forget-cancelled', async () => {
    const { phone } = await rateLimitedPhone();
    const before = phone.logger.entries.length;
    expect(await Promise.all([phone.service.cancelForgetRequest(PC), phone.service.cancelForgetRequest(PC)])).toEqual([{ kind: 'cancelled' }, { kind: 'nothing' }]);
    expect(phone.logger.entries.slice(before).filter((e) => e.event === 'forget-cancelled')).toHaveLength(1);
  });

  it('QA 7 (d) : mémo d’échec illisible : failed rendu, state-unreadable affiché, rien écrit', async () => {
    const { phone } = await rateLimitedPhone();
    await phone.data.repos.sync.setMeta(FORGET_META.failure, '{pas du json');
    const setMeta = vi.spyOn(phone.data.repos.sync, 'setMeta');
    expect(await phone.service.cancelForgetRequest(PC)).toEqual({ kind: 'failed', code: 'io' });
    expect(phone.service.status().stateUnreadable).toBe(true);
    expect(setMeta).not.toHaveBeenCalled();
    expect(await phone.data.repos.sync.getMeta(FORGET_META.failure)).toBe('{pas du json');
    expect(phone.logger.entries.map((e) => e.event)).toEqual(expect.arrayContaining(['state-unreadable', 'forget-cancel-failed']));
  });

  it('écriture refusée par la base : rendue à l’écran (failed), l’échec d’origine reste affiché, rien de silencieux (critère 12)', async () => {
    const { phone } = await rateLimitedPhone();
    vi.spyOn(phone.data.repos.sync, 'setMeta').mockRejectedValueOnce(Object.assign(new Error('base occupée'), { code: 'io' }));
    expect(await phone.service.cancelForgetRequest(PC)).toEqual({ kind: 'failed', code: 'io' });
    expect(phone.service.status().forget?.failure).toMatchObject({ deviceId: PC, step: 'declare' });
    expect(phone.logger.entries.at(-1)).toEqual({ event: 'forget-cancel-failed', detail: { device: PC, code: 'io' } });
  });
});

describe('scénario de la séance 0.3.0 (critères 4, 5, 7, 9)', () => {
  it('« Annuler la demande » : ligne effacée aussitôt, aucun appel à Rust, aucun cycle ; le PC n’est pas oublié', async () => {
    const { phone } = await rateLimitedPhone();
    const prompts = phone.platform.testing.consentPrompts();
    const spies = [
      vi.spyOn(phone.platform.forget, 'device'),
      vi.spyOn(phone.platform.forget, 'deleteFiles'),
      vi.spyOn(phone.platform, 'scan'),
      vi.spyOn(phone.platform, 'writeState'),
      vi.spyOn(phone.platform, 'appendJournal'),
      vi.spyOn(phone.platform, 'deleteOwn'),
    ];
    const before = phone.logger.entries.length;
    expect(await phone.service.cancelForgetRequest(PC)).toEqual({ kind: 'cancelled' });
    expect(phone.service.status().forget?.failure ?? null).toBeNull();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(phone.platform.testing.consentPrompts()).toBe(prompts);
    const events = phone.logger.entries.slice(before).map((e) => e.event);
    expect(events).toEqual(['forget-cancelled']);
    expect(phone.service.status().devices.find((d) => d.deviceId === PC)?.status).toBe('active');
    // Critère 12 : journal sans contenu, clé ni chemin.
    expect(JSON.stringify(phone.logger.entries.slice(before))).not.toMatch(/[\\/]|kid|key/i);
  });

  it('redémarrage : l’échec relu de sync_meta ne revient pas, ni avant ni après le premier cycle (critère 5)', async () => {
    const { phone } = await rateLimitedPhone();
    await phone.service.cancelForgetRequest(PC);
    await phone.restart();
    expect((await readForgetStatus(phone.data.repos))?.failure ?? null).toBeNull();
    await phone.cycle();
    expect(phone.service.status().forget?.failure ?? null).toBeNull();
  });

  it('le blocage de 10 minutes de Rust n’est pas levé (critère 7) : un nouvel oubli redonne rate-limited et la ligne revient', async () => {
    const { phone } = await rateLimitedPhone();
    await phone.service.cancelForgetRequest(PC);
    phone.clock.advance(60_000);
    expect(await phone.service.forgetDevice(PC)).toEqual({ kind: 'failed', code: 'rate-limited' });
    expect(phone.service.status().forget?.failure).toMatchObject({ deviceId: PC, step: 'declare', code: 'rate-limited' });
    // Fin du blocage (horloge simulée) : la boîte native s'ouvre de nouveau (refusée ici : rien n'est oublié).
    phone.clock.advance(TEN_MINUTES);
    const prompts = phone.platform.testing.consentPrompts();
    phone.platform.testing.setConsent(false);
    expect(await phone.service.forgetDevice(PC)).toEqual({ kind: 'cancelled' });
    expect(phone.platform.testing.consentPrompts()).toBe(prompts + 1);
  });

  it('QA 7 (c) : après le blocage, « Réessayer » puis boîte native refusée : cancelled, mémo, intention et ligne inchangés, aucun forget-declared', async () => {
    const { phone } = await rateLimitedPhone();
    const failureBefore = phone.service.status().forget?.failure;
    phone.clock.advance(TEN_MINUTES);
    const metaBefore = await forgetMeta(phone);
    const before = phone.logger.entries.length;
    phone.platform.testing.setConsent(false);
    expect(await phone.service.forgetDevice(PC)).toEqual({ kind: 'cancelled' });
    // `declareForget` pose l'intention avant la boîte native puis la restaure (Y-10) : les valeurs gardées sont identiques.
    expect(await forgetMeta(phone)).toEqual(metaBefore);
    expect(phone.service.status().forget?.failure).toEqual(failureBefore);
    expect(phone.logger.entries.slice(before).map((e) => e.event)).not.toContain('forget-declared');
  });

  it('QA 7 (a) : échec de déclaration du PC, puis oubli d’un autre appareil réussi : l’échec du PC reste, annulable', async () => {
    const { phone } = await rateLimitedPhone({ withOther: true });
    phone.clock.advance(TEN_MINUTES);
    expect(await phone.service.forgetDevice(OTHER)).toEqual({ kind: 'done' });
    expect(phone.service.status().forget?.failure).toMatchObject({ deviceId: PC, step: 'declare' });
    expect(await phone.service.cancelForgetRequest(OTHER)).toEqual({ kind: 'nothing' });
    expect(phone.service.status().forget?.failure).toMatchObject({ deviceId: PC, step: 'declare' });
    expect(await phone.service.cancelForgetRequest(PC)).toEqual({ kind: 'cancelled' });
    expect(phone.service.status().forget?.failure ?? null).toBeNull();
  });

  it('aucune reprise automatique d’un oubli en échec : cycles, redémarrage, fin du blocage, sans geste : declare jamais rappelé (critère 9)', async () => {
    const { pc, phone } = await rateLimitedPhone();
    const device = vi.spyOn(phone.platform.forget, 'device');
    for (let i = 0; i < 3; i += 1) {
      syncFolders([pc, phone]);
      phone.clock.advance(5 * 60_000);
      await phone.cycle();
    }
    await phone.restart();
    phone.clock.advance(11 * 60_000);
    await phone.service.syncNow('open');
    await phone.service.syncNow('timer');
    await phone.service.syncNow('hide');
    expect(device).not.toHaveBeenCalled();
    // L'échec reste affiché tant qu'Ali ne l'a ni réessayé ni annulé.
    expect(phone.service.status().forget?.failure).toMatchObject({ deviceId: PC, step: 'declare' });
    // Et l'annulation elle-même ne relance rien.
    await phone.service.cancelForgetRequest(PC);
    expect(device).not.toHaveBeenCalled();
  });
});
