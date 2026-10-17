// ADR 0011 §22 point 4 (Y-IOS-01 critère 2) : les cas de la table de conformité de `SyncFs` observables par `SyncPlatform` (fichier absent,
// partiel, dans le nuage) rejoués sur `memory.ts` : mêmes statuts de `readJournal` et `readSnapshot` que Rust sur ses trois implémentations
// (`src-tauri/tests/desktop/sync_fs_conformance.rs`).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DeviceId, Hlc } from '../../domain/types';
import { epochId, type DeviceAck, type EpochId, type PublishedDeviceState } from '../../domain/sync/format';
import { createMemorySyncPlatform, MemorySyncFolder, type MemorySyncPlatform } from './memory';
import { SyncPlatformError } from './types';

const A = '0f8fad5b-d9cb-469f-a165-70867728950e' as DeviceId;
const B = '7c9e6679-7425-40de-944b-e07fc1f90ae7' as DeviceId;
const E1 = epochId(1, A);
const SEGMENT = `${E1}/j-00000001.ctj`;
const SNAPSHOT = `${E1}/s-00000001.cts`;
const hlc = (ms: number): Hlc => `${String(ms).padStart(15, '0')}-0000-${A}` as Hlc;

const table = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'fixtures', 'sync', 'syncfs-conformance.json'), 'utf8')) as {
  readonly cases: readonly { readonly name: string; readonly observable?: boolean }[];
};
const observable = table.cases.filter((c) => c.observable === true).map((c) => c.name);

let nowMs = 1_800_000_000_000;

function state(snapshot: boolean): PublishedDeviceState {
  return {
    deviceId: A,
    platform: 'windows',
    appVersion: '0.1.1',
    sm: 1,
    sv: 14,
    epoch: E1,
    stateSeq: 1,
    head: { epoch: E1, segment: 1, record: 2, hlc: hlc(20), stateSeq: 1 },
    acks: new Map<DeviceId, DeviceAck>(),
    snapshot: snapshot ? { seq: 1, endHlc: hlc(30) } : null,
    purgeHorizon: null,
    lastSyncHlc: hlc(40),
    forgotten: [],
    reset: null,
  };
}

/** A publie deux enregistrements, un instantané et son état ; B, associé par la clé de secours, lit. */
async function twoDevices(): Promise<{ folder: MemorySyncFolder; b: MemorySyncPlatform }> {
  const folder = new MemorySyncFolder();
  const a = createMemorySyncPlatform({ folder, nowMs: () => nowMs });
  await a.folder.choose();
  await a.bindDevice(A);
  await a.key.create();
  await a.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(20), records: ['{"k":"ops","n":1}', '{"k":"ops","n":2}'] });
  await a.writeSnapshot({
    epoch: E1,
    seq: 1,
    sv: 14,
    records: (async function* () {
      yield ['{"k":"snap-rows"}', '{"k":"snap-end"}'];
    })(),
  });
  await a.writeState({ sv: 14, state: state(true) });
  await a.key.openPairing('show');
  const { recoveryKey } = await a.key.pairingPayload();
  await a.key.closePairing();
  const b = createMemorySyncPlatform({ folder, nowMs: () => nowMs });
  await b.folder.choose();
  await b.bindDevice(B);
  await b.key.openPairing('import');
  await b.key.import({ recoveryKey });
  await b.scan({ keep: [] });
  return { folder, b };
}

const journal = (b: MemorySyncPlatform) => b.readJournal({ deviceId: A, epoch: E1, from: { segment: 0, record: 0 } });
const tail = (b: MemorySyncPlatform) => b.readSnapshot({ deviceId: A, epoch: E1, seq: 1, fromRecord: 0, tail: true });

beforeEach(() => {
  nowMs = 1_800_000_000_000;
});

describe('table de conformité de SyncFs, cas observables (ADR 0011 §22 point 4)', () => {
  it('la table désigne les trois cas observables rejoués ici', () => {
    expect(observable).toEqual(['fichier absent', 'fichier partiel (dernière ligne incomplète)', 'fichier dans le nuage sans hydratation']);
  });

  it('fichier absent : en attente d’iCloud, jamais sauté', async () => {
    const { folder, b } = await twoDevices();
    expect((await journal(b)).status).toBe('complete');
    folder.removeFile(A, SEGMENT);
    expect(await journal(b)).toMatchObject({ records: [], status: 'cloud-pending' });
    folder.removeFile(A, SNAPSHOT);
    expect((await tail(b)).status).toBe('cloud-pending');
  });

  it('fichier partiel (dernière ligne incomplète) : en attente, rien d’inventé', async () => {
    const { folder, b } = await twoDevices();
    folder.setPartialTail(A, SNAPSHOT, true);
    expect(await tail(b)).toMatchObject({ records: [], status: 'cloud-pending' });
    folder.setPartialTail(A, SNAPSHOT, false);
    expect((await tail(b)).status).toBe('complete');
  });

  it('fichier dans le nuage sans hydratation, puis avec, puis délai dépassé', async () => {
    const { folder, b } = await twoDevices();
    folder.setAvailability(A, SEGMENT, 'cloud');
    expect((await journal(b)).status).toBe('cloud-pending');
    // Téléchargement de 70 s : au-delà des 60 s par fichier.
    b.testing.setHydrationDelay(70_000);
    await b.scan({ keep: [] });
    expect((await journal(b)).status).toBe('cloud-pending');
    // Téléchargement de 1 s : lu.
    b.testing.setHydrationDelay(1_000);
    await b.scan({ keep: [] });
    expect(await journal(b)).toMatchObject({ status: 'complete', records: ['{"k":"ops","n":1}', '{"k":"ops","n":2}'] });
  });
});

describe('sync_scan({ hydrateBudgetMs }) sur memory.ts (ADR 0011 §22 point 4)', () => {
  it('hors bornes : bad-name ; dans les bornes : accepté', async () => {
    const { b } = await twoDevices();
    for (const bad of [0, -1, 180_001, 1.5, Number.NaN, '25000' as unknown as number]) {
      await expect(b.scan({ keep: [], hydrateBudgetMs: bad })).rejects.toMatchObject({ code: 'bad-name' });
    }
    for (const good of [1, 25_000, 180_000]) await b.scan({ keep: [], hydrateBudgetMs: good });
  });

  it('le budget réduit borne les téléchargements du cycle', async () => {
    const { folder, b } = await twoDevices();
    folder.setAvailability(A, SEGMENT, 'cloud');
    b.testing.setHydrationDelay(30_000);
    await b.scan({ keep: [], hydrateBudgetMs: 20_000 });
    expect((await journal(b)).status).toBe('cloud-pending');
    expect(b.testing.hydrationBudgetLeft()).toBe(0);
    await b.scan({ keep: [] });
    expect(b.testing.hydrationBudgetLeft()).toBe(180_000);
    expect((await journal(b)).status).toBe('complete');
    expect(b.testing.hydrationBudgetLeft()).toBe(150_000);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Y-TECH-03 (B13, critère 16) : cas de pannes de la table (`faultCases`) rejoués sur memory.ts par une vue fichier de `MemorySyncFolder`
// qui passe par les mêmes points de panne que la plateforme (listage, lecture, hydratation, écriture, suppression, cycles d'iCloud).
// ---------------------------------------------------------------------------------------------------------------------------------

interface FaultStep {
  readonly op: string;
  readonly path?: readonly string[];
  readonly text?: string;
  readonly create?: boolean;
  readonly hydrate?: boolean;
  readonly expect: { readonly ok?: boolean; readonly names?: readonly string[]; readonly text?: string; readonly removed?: boolean; readonly error?: string };
}
interface FaultCase {
  readonly name: string;
  readonly requires?: readonly string[];
  readonly plan: unknown;
  readonly setup: readonly { readonly file: readonly string[]; readonly text: string; readonly cloud?: boolean }[];
  readonly steps: readonly FaultStep[];
  readonly notApplicable?: Record<string, string>;
}
const faultCases = (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'fixtures', 'sync', 'syncfs-conformance.json'), 'utf8')) as { readonly faultCases: readonly FaultCase[] }).faultCases;

/** Résultat d'une étape, comparable à `expect`. */
type Outcome = { readonly ok: true } | { readonly names: string[] } | { readonly text: string } | { readonly removed: boolean } | { readonly error: string };

/** Lignes complètes d'un texte de la table (`a\nb\n` → `a`, `b`). */
function linesOf(text: string): string[] {
  if (!text.endsWith('\n')) throw new Error(`texte de la table sans \\n final : ${JSON.stringify(text)}`);
  return text.slice(0, -1).split('\n');
}

/** Vue fichier de `MemorySyncFolder` : `devices/<appareil>/<nom strict>` ; erreurs rendues par leur nom (`io`, `cloud-pending`, `cloud-error`). */
function memoryView(folder: MemorySyncFolder): { put(path: readonly string[], text: string, cloud: boolean): void; step(step: FaultStep): Outcome } {
  const where = (path: readonly string[]): { deviceId: string; file: string } => {
    if (path[0] !== 'devices' || path.length < 2) throw new Error(`chemin hors de devices/ : ${path.join('/')}`);
    return { deviceId: path[1] as string, file: path.slice(2).join('/') };
  };
  const exists = (deviceId: string, file: string): boolean => folder.fileNames(deviceId).includes(file);
  const step = (s: FaultStep): Outcome => {
    if (s.op === 'advanceCycle') {
      folder.advanceCycle();
      return { ok: true };
    }
    const { deviceId, file } = where(s.path ?? []);
    switch (s.op) {
      case 'list': {
        // Dossier d'appareil (`file` vide) ou d'époque.
        const epoch = file === '' ? null : (file as EpochId);
        folder.listGate(deviceId, epoch);
        const names = folder
          .fileNames(deviceId)
          .filter((n) => (epoch === null ? !n.includes('/') : n.startsWith(`${epoch}/`)))
          .map((n) => {
            const base = epoch === null ? n : n.slice(epoch.length + 1);
            return folder.availabilityOf(deviceId, n) === 'cloud' ? `${base}~` : base;
          });
        if (epoch === null) names.push(...[...(folder.devices.get(deviceId)?.epochs.keys() ?? [])].map((e) => `${e}/`));
        return { names: names.sort() };
      }
      case 'read': {
        if (!exists(deviceId, file)) return { error: 'not-found' };
        const fault = folder.readGate(deviceId, file);
        if (fault?.effect === 'error') return { error: fault.code ?? 'io' };
        if (folder.availabilityOf(deviceId, file) === 'cloud') {
          if (s.hydrate !== true) return { error: 'cloud-pending' };
          if (folder.hydrateFails(deviceId, file)) return { error: 'cloud-error' };
          folder.setAvailability(deviceId, file, 'local');
        }
        const text = folder.records(deviceId, file).map((l) => `${l}\n`).join('');
        if (fault?.effect === 'evict-after-read') folder.evict(deviceId, file);
        return { text };
      }
      case 'writeAtomic': {
        const refused = folder.writeGate(deviceId, file);
        if (refused?.effect === 'error') return { error: refused.code ?? 'io' };
        folder.putLines(deviceId, file, linesOf(s.text ?? ''));
        return { ok: true };
      }
      case 'append': {
        if (s.create === true && exists(deviceId, file)) return { error: 'exists' };
        if (s.create !== true && !exists(deviceId, file)) return { error: 'not-found' };
        const refused = folder.writeGate(deviceId, file);
        if (refused?.effect === 'error') return { error: refused.code ?? 'io' };
        folder.putLines(deviceId, file, [...(exists(deviceId, file) ? folder.records(deviceId, file) : []), ...linesOf(s.text ?? '')]);
        return { ok: true };
      }
      case 'remove':
        return { removed: folder.removeWithFaults(deviceId, file) };
      default:
        throw new Error(`opération inconnue de la vue mémoire : ${s.op}`);
    }
  };
  return {
    put(path, text, cloud) {
      const { deviceId, file } = where(path);
      folder.putLines(deviceId, file, linesOf(text), cloud ? 'cloud' : 'local');
    },
    step(s) {
      try {
        return step(s);
      } catch (error) {
        if (error instanceof SyncPlatformError) return { error: error.code };
        throw error;
      }
    },
  };
}

describe('Y-TECH-03 : cas de pannes de la table de conformité rejoués sur memory.ts (critère 16)', () => {
  it('la table porte des cas de pannes, chacun avec un plan valide, aucun déclaré non applicable à memory.ts', () => {
    expect(faultCases.length).toBeGreaterThanOrEqual(12);
    for (const c of faultCases) {
      expect(() => new MemorySyncFolder().armFaults(c.plan), c.name).not.toThrow();
      expect(c.notApplicable?.['memory.ts'], c.name).toBeUndefined();
    }
  });

  it('les plans de référence de fault-plan.json s’arment sur memory.ts par le même analyseur que les plans de la table', () => {
    const reference = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'fixtures', 'sync', 'fault-plan.json'), 'utf8')) as { readonly plans: readonly unknown[] };
    expect(reference.plans.length).toBeGreaterThan(0);
    for (const p of reference.plans) expect(() => new MemorySyncFolder().armFaults(p)).not.toThrow();
  });

  for (const c of faultCases) {
    it(c.name, () => {
      const folder = new MemorySyncFolder();
      const view = memoryView(folder);
      for (const item of c.setup) view.put(item.file, item.text, item.cloud === true);
      folder.armFaults(c.plan);
      c.steps.forEach((s, index) => {
        expect(view.step(s), `memory.ts : « ${c.name} », étape ${String(index)}`).toEqual(s.expect);
      });
      // Aucune panne armée restée sans effet (une entrée jamais déclenchée serait une panne ignorée en silence).
      expect(folder.unfiredFaults(), c.name).toEqual([]);
    });
  }
});
