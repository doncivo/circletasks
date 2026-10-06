import { describe, expect, it } from 'vitest';
import { CONSENT_BLOCK_MS, CONSENT_WINDOW_MS, epochId, type DeviceAck, type EpochId, type ForgottenDevice, type PublishedDeviceState } from '../../../../src/domain/sync/format';
import type { DeviceId, Hlc } from '../../../../src/domain/types';
import { createMemorySyncPlatform, MemorySyncFolder, nextDeclarationHlc, type MemorySyncPlatform } from '../../../../src/platform/sync/memory';
import { SyncPlatformError } from '../../../../src/platform/sync/types';

/**
 * Y-10 critères 3, 5, 6, 11 et 12 sur la plateforme mémoire (rôle de Rust dans Vitest et Playwright) : mêmes contrôles et mêmes codes que
 * `sync_device_forget`, `sync_write_state` et `sync_forgotten_delete` (`src-tauri/tests/desktop/sync_forget.rs`), tests d'attaque compris.
 * Un seul dossier partagé (iCloud propage tout aussitôt), horloge contrôlée : aucune attente réelle.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as DeviceId;
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as DeviceId;
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as DeviceId;
const D = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' as DeviceId;
const X = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' as DeviceId;
const E1 = epochId(1, A);
const hlc = (ms: number, dev: DeviceId): Hlc => `${String(ms).padStart(15, '0')}-0000-${dev}` as Hlc;

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof SyncPlatformError ? error.code : `autre : ${String(error)}`;
  }
};

const ackOf = (dev: DeviceId, segment: number, record: number, stateSeq: number, epoch: EpochId = E1): DeviceAck => ({
  epoch,
  segment,
  record,
  hlc: segment === 0 ? null : hlc(segment * 100 + record, dev),
  stateSeq,
});

interface Dev {
  readonly id: DeviceId;
  readonly p: MemorySyncPlatform;
  seq: number;
  head: { segment: number; record: number; hlc: Hlc | null };
}

class Room {
  readonly folder = new MemorySyncFolder('partagé');
  nowMs = 1_800_000_000_000;
  readonly devs = new Map<DeviceId, Dev>();

  async first(id: DeviceId): Promise<Dev> {
    const p = createMemorySyncPlatform({ folder: this.folder, nowMs: () => this.nowMs });
    await p.folder.choose();
    await p.bindDevice(id);
    await p.key.create();
    const dev: Dev = { id, p, seq: 0, head: { segment: 0, record: 0, hlc: null } };
    this.devs.set(id, dev);
    await this.publish(id);
    return dev;
  }

  async join(id: DeviceId, owner: DeviceId = A): Promise<Dev> {
    const p = createMemorySyncPlatform({ folder: this.folder, nowMs: () => this.nowMs });
    await p.folder.choose();
    const o = this.devs.get(owner) as Dev;
    await o.p.key.openPairing('show');
    const payload = await o.p.key.pairingPayload();
    await o.p.key.closePairing();
    await p.key.openPairing('import');
    await p.key.import({ recoveryKey: payload.recoveryKey });
    await p.bindDevice(id);
    const dev: Dev = { id, p, seq: 0, head: { segment: 0, record: 0, hlc: null } };
    this.devs.set(id, dev);
    await this.publish(id);
    return dev;
  }

  /** Publie l'état de `id` : accusés donnés, `forgotten` envoyé par le moteur (vide par défaut : Rust complète). */
  async publish(id: DeviceId, acks: Record<string, DeviceAck> = {}, forgotten: readonly ForgottenDevice[] = []): Promise<void> {
    const dev = this.devs.get(id) as Dev;
    const seq = dev.seq + 1;
    const state: PublishedDeviceState = {
      deviceId: id,
      platform: 'windows',
      appVersion: '0.4.0',
      sm: 1,
      sv: 17,
      epoch: E1,
      stateSeq: seq,
      head: { epoch: E1, ...dev.head, stateSeq: seq },
      acks: new Map(Object.entries(acks) as [DeviceId, DeviceAck][]),
      snapshot: null,
      purgeHorizon: null,
      lastSyncHlc: hlc(this.nowMs, id),
      forgotten,
      reset: null,
    };
    await dev.p.writeState({ sv: 17, state });
    dev.seq = seq;
  }

  /** X publie trois enregistrements (segment 1 : 2, segment 2 : 1). */
  async writeJournal(id: DeviceId): Promise<void> {
    const dev = this.devs.get(id) as Dev;
    for (const [segment, expectRecords, n] of [
      [1, 0, 101],
      [1, 1, 102],
      [2, 0, 201],
    ] as const) {
      await dev.p.appendJournal({ epoch: E1, segment, expectRecords, sv: 17, maxHlc: hlc(n, id), records: ['{}'] });
    }
    dev.head = { segment: 2, record: 1, hlc: hlc(201, id) };
    await this.publish(id);
  }

  published(id: DeviceId): PublishedDeviceState | null {
    const copy = this.folder.takeState(id);
    return copy.file ? (JSON.parse(copy.file.lines[0]?.text ?? 'null') as PublishedDeviceState | null) : null;
  }

  upToDate(id: DeviceId, x: [number, number]): Record<string, DeviceAck> {
    const acks: Record<string, DeviceAck> = {};
    for (const [other, dev] of this.devs) if (other !== id && other !== X) acks[other] = ackOf(other, 0, 0, dev.seq);
    acks[X] = ackOf(X, x[0], x[1], (this.devs.get(X) as Dev).seq);
    return acks;
  }

  /** A, B, X ; X a publié ; A oublie X puis tous publient des accusés à jour. */
  static async settled(): Promise<Room> {
    const room = await Room.started();
    const a = room.devs.get(A) as Dev;
    await a.p.forget.device(X);
    await room.settle();
    return room;
  }

  static async started(): Promise<Room> {
    const room = new Room();
    await room.first(A);
    await room.join(B);
    await room.join(X);
    await room.writeJournal(X);
    return room;
  }

  async settle(): Promise<void> {
    for (const id of [A, B, A, B]) await this.publish(id, this.upToDate(id, [2, 1]), id === A ? (this.published(A)?.forgotten ?? []) : []);
  }

  files(id: DeviceId): string[] {
    return this.folder.fileNames(id);
  }
}

describe('forget.device (sync_device_forget)', () => {
  it('refus avant toute boîte : sans dossier, sans clé, sans liaison, identifiant mal formé, appareil local ou inconnu, réinitialisation en cours', async () => {
    const lone = createMemorySyncPlatform({ folder: new MemorySyncFolder() });
    expect(await codeOf(lone.forget.device(X))).toBe('not-configured');
    await lone.folder.choose();
    expect(await codeOf(lone.forget.device(X))).toBe('key-missing');
    await lone.key.create();
    expect(await codeOf(lone.forget.device(X))).toBe('not-bound');
    const room = await Room.started();
    const a = (room.devs.get(A) as Dev).p;
    const prompts = a.testing.consentPrompts();
    for (const bad of ['', '..', String(X).toUpperCase(), `../${X}`, `devices/${X}`]) expect(await codeOf(a.forget.device(bad as DeviceId))).toBe('bad-name');
    expect(await codeOf(a.forget.device(A))).toBe('bad-name');
    expect(await codeOf(a.forget.device(C))).toBe('bad-name');
    a.testing.setResetInProgress(true);
    expect(await codeOf(a.forget.device(X))).toBe('state-mismatch');
    a.testing.setResetInProgress(false);
    expect(a.testing.consentPrompts()).toBe(prompts);
    expect(a.testing.forgottenDeclarations()).toEqual([]);
  });

  it('pas au premier plan, refus de la boîte, blocage : rien n’est écrit ; acceptée : déclaration datée après tout hlc connu ; déjà oublié : sans boîte', async () => {
    const room = await Room.started();
    const a = (room.devs.get(A) as Dev).p;
    const prompts = a.testing.consentPrompts();
    a.testing.setForeground(false);
    expect(await codeOf(a.forget.device(X))).toBe('not-foreground');
    a.testing.setForeground(true);
    a.testing.setConsent(false);
    expect(await codeOf(a.forget.device(X))).toBe('consent-denied');
    expect(a.testing.forgottenDeclarations()).toEqual([]);
    a.testing.setConsent(true);
    expect(await codeOf(a.forget.device(X))).toBe('rate-limited');
    room.nowMs += CONSENT_BLOCK_MS;
    await a.forget.device(X);
    const [entry] = a.testing.forgottenDeclarations();
    expect(entry?.deviceId).toBe(X);
    expect(entry?.at.endsWith(A)).toBe(true);
    expect(entry && entry.at > hlc(room.nowMs - 1, X)).toBe(true);
    expect(entry?.lastAck).toBeNull();
    expect(a.testing.consentPrompts()).toBe(prompts + 2);
    await a.forget.device(X);
    expect(a.testing.consentPrompts()).toBe(prompts + 2);
    expect(a.testing.forgottenDeclarations()).toHaveLength(1);
  });

  it('trois ouvertures par 10 minutes, la quatrième est refusée (rate-limited)', async () => {
    const room = await Room.started();
    await room.join(C);
    await room.join(D, B);
    const a = (room.devs.get(A) as Dev).p;
    for (const target of [X, B, C]) await a.forget.device(target);
    expect(await codeOf(a.forget.device(D))).toBe('rate-limited');
    room.nowMs += CONSENT_WINDOW_MS;
    await a.forget.device(D);
  });

  it('hlc de la déclaration : après l’horloge et après tout hlc lu (même milliseconde : compteur suivant)', () => {
    expect(nextDeclarationHlc(5_000, [], A)).toBe(hlc(5_000, A));
    expect(nextDeclarationHlc(5_000, [hlc(9_000, B)], A)).toBe(`${String(9_000).padStart(15, '0')}-0001-${A}`);
    expect(nextDeclarationHlc(5_000, [hlc(4_000, B), 'pas un hlc'], A)).toBe(hlc(5_000, A));
  });
});

describe('writeState : Rust maître de forgotten (critère 6)', () => {
  it('liste vide complétée, liste égale acceptée, toute autre liste refusée ; forgotten.json perdu : reconstruit depuis l’état authentifié', async () => {
    const room = await Room.started();
    const a = room.devs.get(A) as Dev;
    const forged: ForgottenDevice = { deviceId: X, at: hlc(5, A), lastAck: null };
    expect(await codeOf(room.publish(A, {}, [forged]))).toBe('state-mismatch');
    await a.p.forget.device(X);
    await room.publish(A);
    const published = room.published(A)?.forgotten ?? [];
    expect(published.map((f) => f.deviceId)).toEqual([X]);
    await room.publish(A, {}, published);
    expect(await codeOf(room.publish(A, {}, [{ ...(published[0] as ForgottenDevice), at: hlc(1, A) }]))).toBe('state-mismatch');
    expect(await codeOf(room.publish(A, {}, [...published, { deviceId: B, at: hlc(9e12, A), lastAck: null }]))).toBe('state-mismatch');
    a.p.testing.dropForgottenFile();
    await room.publish(A);
    expect(room.published(A)?.forgotten).toEqual(published);
  });
});

describe('forget.deleteFiles (sync_forgotten_delete)', () => {
  it('refus un par un, rien n’est supprimé ; conditions réunies : seuls les fichiers de devices/<X>/, idempotent', async () => {
    const room = await Room.started();
    const a = (room.devs.get(A) as Dev).p;
    const b = (room.devs.get(B) as Dev).p;
    for (const bad of ['', '..', String(X).toUpperCase(), `../${X}`]) expect(await codeOf(a.forget.deleteFiles(bad as DeviceId))).toBe('bad-name');
    expect(await codeOf(a.forget.deleteFiles(A))).toBe('bad-name');
    const xFiles = room.files(X);
    expect(await codeOf(a.forget.deleteFiles(X))).toBe('state-mismatch');
    await a.forget.device(X);
    // Déclaration confirmée, pas encore publiée.
    expect(await codeOf(a.forget.deleteFiles(X))).toBe('state-mismatch');
    await room.publish(A, room.upToDate(A, [2, 1]));
    // B en retard sur la coupure.
    await room.publish(B, room.upToDate(B, [1, 2]));
    expect(await codeOf(b.forget.deleteFiles(X))).toBe('state-mismatch');
    // B à jour de la coupure mais pas de l'état de A qui porte la déclaration.
    const stale = room.upToDate(B, [2, 1]);
    stale[A] = ackOf(A, 0, 0, (room.devs.get(A) as Dev).seq - 1);
    await room.publish(B, stale);
    expect(await codeOf(a.forget.deleteFiles(X))).toBe('state-mismatch');
    // A en retard sur la coupure atteinte par B (maximum des accusés).
    await room.publish(B, room.upToDate(B, [2, 1]));
    await room.publish(A, room.upToDate(A, [1, 1]), room.published(A)?.forgotten ?? []);
    expect(await codeOf(a.forget.deleteFiles(X))).toBe('state-mismatch');
    await room.settle();
    // État d'un actif dans le nuage, réinitialisation en cours.
    room.folder.setAvailability(B, 'state.ctx', 'cloud');
    expect(await codeOf(a.forget.deleteFiles(X))).toBe('cloud-pending');
    room.folder.setAvailability(B, 'state.ctx', 'local');
    a.testing.setResetInProgress(true);
    expect(await codeOf(a.forget.deleteFiles(X))).toBe('state-mismatch');
    a.testing.setResetInProgress(false);
    expect(room.files(X)).toEqual(xFiles);
    const others = [room.files(A), room.files(B)];
    room.folder.addStrayEntries(X, 1);
    expect(await a.forget.deleteFiles(X)).toEqual({ deleted: 4, complete: true });
    expect(room.files(X)).toEqual([]);
    expect(room.folder.devices.has(X)).toBe(true);
    expect([room.files(A), room.files(B)]).toEqual(others);
    expect(await b.forget.deleteFiles(X)).toEqual({ deleted: 0, complete: true });
  });
});

describe('attaques', () => {
  it('état rejoué : ne fait pas avancer la suppression', async () => {
    const room = await Room.started();
    const a = (room.devs.get(A) as Dev).p;
    await a.forget.device(X);
    await room.publish(A, room.upToDate(A, [2, 1]));
    await room.publish(B, room.upToDate(B, [1, 1]));
    const oldB = room.folder.takeState(B);
    await room.settle();
    await a.scan({ keep: [] });
    room.folder.putState(oldB);
    expect(await codeOf(a.forget.deleteFiles(X))).toBe('state-mismatch');
    expect(room.files(X).length).toBeGreaterThan(0);
  });

  it('appareil oublié : ne peut ni oublier celui qui l’a oublié, ni supprimer ses fichiers ; ses propres fichiers peuvent l’être', async () => {
    const room = await Room.settled();
    const x = (room.devs.get(X) as Dev).p;
    expect(await codeOf(x.forget.device(A))).toBe('state-mismatch');
    expect(await codeOf(x.forget.deleteFiles(A))).toBe('state-mismatch');
    expect(await codeOf((room.devs.get(B) as Dev).p.forget.deleteFiles(A))).toBe('state-mismatch');
    expect(room.files(A).length).toBeGreaterThan(0);
    expect((await (room.devs.get(B) as Dev).p.forget.deleteFiles(X)).complete).toBe(true);
  });

  it('oublis croisés : seule la plus ancienne déclaration compte', async () => {
    const room = await Room.started();
    const x = room.devs.get(X) as Dev;
    await x.p.forget.device(A);
    await room.publish(X, { [A]: ackOf(A, 0, 0, 1), [B]: ackOf(B, 0, 0, 1) });
    room.nowMs += 60_000;
    const a = (room.devs.get(A) as Dev).p;
    expect(await codeOf(a.forget.device(X))).toBe('state-mismatch');
    expect(await codeOf((room.devs.get(B) as Dev).p.forget.deleteFiles(X))).toBe('state-mismatch');
  });

  it('faux state.ctx étranger : n’oublie personne et ne débloque aucune suppression', async () => {
    const room = await Room.started();
    // Un autre dossier, une autre clé : son état recopié ici est « étranger ».
    const other = new MemorySyncFolder('ailleurs');
    const stranger = createMemorySyncPlatform({ folder: other, nowMs: () => room.nowMs });
    await stranger.folder.choose();
    await stranger.bindDevice(C);
    await stranger.key.create();
    await stranger.writeState({
      sv: 17,
      state: { ...(room.published(A) as PublishedDeviceState), deviceId: C, acks: new Map<DeviceId, DeviceAck>(), forgotten: [], head: { epoch: E1, segment: 0, record: 0, hlc: null, stateSeq: 1 }, stateSeq: 1 },
    });
    room.folder.putState(other.takeState(C));
    const a = (room.devs.get(A) as Dev).p;
    const scan = await a.scan({ keep: [] });
    expect(scan.devices.find((d) => d.deviceId === C)?.stateStatus).toBe('foreign');
    await a.forget.device(X);
    await room.settle();
    const xFiles = room.files(X);
    expect(await codeOf(a.forget.deleteFiles(X))).toBe('state-mismatch');
    expect(room.files(X)).toEqual(xFiles);
    room.folder.devices.delete(C);
    expect((await a.forget.deleteFiles(X)).complete).toBe(true);
  });
});
