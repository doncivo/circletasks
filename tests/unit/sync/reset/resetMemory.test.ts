import { afterEach, describe, expect, it } from 'vitest';
import { SyncPlatformError } from '../../../../src/platform/sync/types';
import { createSimDevice, syncFolders, taskSnapshot, type SimDevice } from '../../../sim/syncDevice';
import { propagate } from '../../../sim/syncCloudSim';
import { B_ID, C_ID, closeAll, publishedState, recoveryOf, setupRoom, settle, type Room } from './resetKit';

/**
 * Y-11 critères 5, 7, 10 et D1 sur la plateforme mémoire (mêmes règles que Rust, `reset.rs` / `SyncCore`) : annonce maîtresse, clé de la
 * fenêtre `pairing` pendant la transition, refus de redonner l'ancienne clé, import vers `.next` (sans effet la seconde fois), appareil
 * associé pendant la transition avec la seule nouvelle clé.
 */

const room: Room = { devices: [] };
afterEach(() => closeAll(room));

const codeOf = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'ok',
    (error: unknown) => (error instanceof SyncPlatformError ? error.code : 'other'),
  );

function qrJson(qrText: string): { k: string; d: string; e: string | null } {
  return JSON.parse(Buffer.from(qrText.slice('CTPAIR1.'.length), 'base64url').toString('utf8')) as { k: string; d: string; e: string | null };
}

describe('annonce maîtresse et clé de la transition (critères 5 et 7, D1)', () => {
  it('la fenêtre pairing porte K2, e = n+1 et d = A ; B, qui a lu l’annonce, ne donne plus l’ancienne clé', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    expect((await a.service.resetSync()).kind).toBe('started');
    await a.platform.key.openPairing('show');
    const payload = await a.platform.key.pairingPayload();
    await a.platform.key.closePairing();
    const qr = qrJson(payload.qrText);
    expect(qr.d).toBe(a.id);
    expect(qr.e).toBe(publishedState(a, a.id, 'next')?.epoch);
    expect(qr.e).toMatch(/^e0002-/);
    syncFolders(room.devices);
    await b.cycle();
    const prompts = b.platform.testing.consentPrompts();
    expect(await codeOf(b.platform.key.openPairing('show'))).toBe('state-mismatch');
    expect(b.platform.testing.consentPrompts(), 'aucune boîte').toBe(prompts);
  });

  it('écriture d’état : annonce absente ou forgée refusée sous K ; annonce sous K2 refusée ; rien de K2 avant l’annonce', async () => {
    const [a] = (await setupRoom(room, [])) as [SimDevice];
    await a.cycle();
    await a.platform.reset.start();
    const scan = await a.platform.scan({ keep: [] });
    const notice = scan.reset?.notice;
    expect(notice).toBeTruthy();
    const own = scan.devices.find((d) => d.deviceId === a.id)?.state;
    if (!own || !notice) throw new Error('état');
    const write = (patch: Partial<typeof own>) => a.platform.writeState({ sv: own.sv, state: { ...own, stateSeq: own.stateSeq + 10, head: { ...own.head, stateSeq: own.stateSeq + 10 }, ...patch } });
    expect(await codeOf(write({ reset: null })), 'annonce absente').toBe('state-mismatch');
    expect(await codeOf(write({ reset: { ...notice, kid: '0000000000000000' } })), 'annonce forgée').toBe('state-mismatch');
    const early = await codeOf(a.platform.writeState({ sv: own.sv, state: { ...own, epoch: notice.epoch, stateSeq: own.stateSeq + 11, head: { epoch: notice.epoch, segment: 0, record: 0, hlc: null, stateSeq: own.stateSeq + 11 }, snapshot: null } }));
    expect(early, 'époque visée avant l’annonce').toBe('state-mismatch');
    expect(await codeOf(write({ reset: notice }))).toBe('ok');
    expect(a.platform.testing.resetRecord()?.stage).toBe('announced');
    expect(await codeOf(a.platform.writeState({ sv: own.sv, state: { ...own, epoch: notice.epoch, stateSeq: own.stateSeq + 12, head: { epoch: notice.epoch, segment: 0, record: 0, hlc: null, stateSeq: own.stateSeq + 12 }, snapshot: null, reset: notice } }))).toBe('state-mismatch');
  });
});

describe('réassociation vers .next (critère 10)', () => {
  it('B importe K2 sous .next (confirmation de remplacement), une seconde fois sans effet ni boîte ; .v1 intacte jusqu’à la bascule', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    const k = (await b.platform.key.status()).kid;
    expect((await a.service.resetSync()).kind).toBe('started');
    syncFolders(room.devices);
    const recovery = await recoveryOf(a);
    const prompts = b.platform.testing.consentPrompts();
    await b.platform.key.openPairing('import');
    await b.platform.key.import({ recoveryKey: recovery });
    expect(b.platform.testing.consentPrompts(), 'confirmation de remplacement de Y-08').toBe(prompts + 1);
    const status = await b.platform.key.status();
    expect(status.kid, '.v1 intacte').toBe(k);
    expect(status.nextKid).toBe((await a.platform.key.status()).nextKid);
    await b.platform.key.openPairing('import');
    await b.platform.key.import({ recoveryKey: recovery });
    expect(b.platform.testing.consentPrompts(), 'déjà importée : sans boîte').toBe(prompts + 1);
    // A, qui réinitialise, importe sa propre nouvelle clé : sans effet (déjà sous .next).
    await a.platform.key.openPairing('import');
    expect(await codeOf(a.platform.key.import({ recoveryKey: recovery }))).toBe('ok');
  });

  it('appareil associé pendant la transition avec la seule nouvelle clé (QR de A) : il rejoint l’époque n+1 et compte comme réassocié', async () => {
    const [a] = (await setupRoom(room, [])) as [SimDevice];
    await a.createTask('Avant');
    await a.cycle();
    const b = await createSimDevice(B_ID, { name: 'B', clock: a.clock });
    room.devices.push(b);
    // A a un autre appareil connu (C, jamais revenu) : la bascule attend ; l'iPhone neuf est associé avec K2.
    const c = await createSimDevice(C_ID, { name: 'C', clock: a.clock });
    room.devices.push(c);
    propagate(a.folder, c.folder, a.id);
    await c.platform.folder.choose();
    a.clock.advance(11 * 60_000);
    await c.platform.key.openPairing('import');
    await c.platform.key.import({ recoveryKey: await recoveryOf(a) });
    await c.cycle();
    syncFolders([a, c]);
    await a.cycle();
    expect((await a.service.resetSync()).kind).toBe('started');
    expect(a.service.status().reset?.waiting).toEqual([C_ID]);
    a.clock.advance(11 * 60_000);
    propagate(a.folder, b.folder, a.id);
    await b.platform.folder.choose();
    await b.platform.key.openPairing('import');
    await b.platform.key.import({ recoveryKey: await recoveryOf(a) });
    expect((await b.platform.key.status()).kid).toBe((await a.platform.key.status()).nextKid);
    await b.cycle();
    syncFolders([a, b]);
    await a.cycle();
    expect(a.service.status().reset?.waiting, 'B réassocié d’office (nouvelle clé)').toEqual([C_ID]);
    await settle([a, b], 2);
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
  });
});

const openImport = async (d: SimDevice): Promise<void> => {
  if (d.platform.testing.pairing()) await d.platform.key.closePairing();
  await d.platform.key.openPairing('import');
};

const epochAfter = (epoch: string, opener: string): string => `e${String(Number(epoch.slice(1, 5)) + 1).padStart(4, '0')}-${opener}`;

describe('ADR 0011 §18 points 14, 16 et 17 sur la plateforme mémoire (mêmes cas que sync_reset.rs)', () => {
  it('oubli pendant la transition : deux exceptions seulement (initiateur avant bascule ; cible auteur d’une annonce)', async () => {
    const [a, b, c] = (await setupRoom(room, [B_ID, C_ID])) as [SimDevice, SimDevice, SimDevice];
    expect((await a.service.resetSync()).kind).toBe('started');
    syncFolders(room.devices);
    await b.cycle();
    let prompts = b.platform.testing.consentPrompts();
    expect(await codeOf(b.platform.forget.device(C_ID as never)), 'non-annonceur').toBe('state-mismatch');
    expect(b.platform.testing.consentPrompts(), 'sans boîte').toBe(prompts);
    expect(await codeOf(b.platform.forget.device(a.id as never)), 'auteur d’une annonce').toBe('ok');
    expect(b.platform.testing.consentPrompts()).toBe(prompts + 1);
    // Réassocié : non-annonceur refusé sans boîte, auteur de la réinitialisation rejointe permis.
    a.clock.advance(11 * 60_000);
    syncFolders(room.devices);
    const recovery = await recoveryOf(a);
    await c.platform.key.openPairing('import');
    await c.platform.key.import({ recoveryKey: recovery });
    prompts = c.platform.testing.consentPrompts();
    expect(await codeOf(c.platform.forget.device(B_ID as never))).toBe('state-mismatch');
    expect(c.platform.testing.consentPrompts()).toBe(prompts);
    expect(await codeOf(c.platform.forget.device(a.id as never))).toBe('ok');
    // L'initiateur, bascule pas commencée : toute cible (boîte).
    expect(await codeOf(a.platform.forget.device(B_ID as never))).toBe('ok');
  });

  it('garde d’époque : rien dans l’époque visée avant l’annonce ; aucune autre époque pendant la réinitialisation ; annonce lue : aucune', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    await a.cycle();
    await a.platform.reset.start();
    const target = a.platform.testing.resetRecord()?.epoch as string;
    const snapshot = (p: SimDevice, epoch: string) =>
      p.platform.writeSnapshot({ epoch: epoch as never, seq: 1, sv: 14, records: (async function* () { yield ['{}']; })() });
    expect(await codeOf(snapshot(a, target)), 'audit 8').toBe('state-mismatch');
    expect(await codeOf(a.platform.appendJournal({ epoch: target as never, segment: 1, expectRecords: 0, sv: 14, maxHlc: `${String(a.clock.nowMs()).padStart(15, '0')}-0000-${a.id}` as never, records: ['{}'] })), 'audit 8').toBe('state-mismatch');
    await a.cycle();
    expect(a.platform.testing.resetRecord()?.stage).toBe('opened');
    expect(await codeOf(snapshot(a, epochAfter(target, a.id))), 'autre époque que celle de reset.json').toBe('state-mismatch');
    syncFolders(room.devices);
    await b.cycle();
    const own = (await b.platform.scan({ keep: [] })).devices.find((d) => d.deviceId === b.id)?.state;
    expect(await codeOf(snapshot(b, epochAfter(own?.epoch as string, b.id))), 'annonce lue').toBe('state-mismatch');
  });

  it('échec d’import persisté (importFailure) : écrit sur les refus, jamais sur not-foreground ni consent-denied ; effacé à la réussite et par l’oubli du dossier', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    expect((await b.platform.key.status()).importFailure ?? null).toBeNull();
    // Fenêtre `pairing` absente (wrong-window) : aucune entrée légitime traitée, rien d'écrit.
    expect(await codeOf(b.platform.key.import({ recoveryKey: 'CT1-AAAAA' }))).toBe('wrong-window');
    expect((await b.platform.key.status()).importFailure ?? null).toBeNull();
    await openImport(b);
    expect(await codeOf(b.platform.key.import({ recoveryKey: 'CT1-AAAAA' }))).toBe('invalid-pairing');
    const first = (await b.platform.key.status()).importFailure;
    expect(first?.code).toBe('invalid-pairing');
    expect(first?.at).toMatch(/Z$/);
    b.platform.testing.setForeground(false);
    expect(await codeOf(b.platform.key.import({ recoveryKey: 'CT1-AAAAA' }))).toBe('not-foreground');
    b.platform.testing.setForeground(true);
    expect((await b.platform.key.status()).importFailure?.code).toBe('invalid-pairing');
    expect((await a.service.resetSync()).kind).toBe('started');
    syncFolders(room.devices);
    await b.cycle();
    const recovery = await recoveryOf(a);
    b.platform.testing.setConsent(false);
    await openImport(b);
    expect(await codeOf(b.platform.key.import({ recoveryKey: recovery }))).toBe('consent-denied');
    expect((await b.platform.key.status()).importFailure?.code, 'choix de l’utilisateur : rien d’écrit').toBe('invalid-pairing');
    expect(await codeOf(b.platform.key.import({ recoveryKey: recovery }))).toBe('rate-limited');
    expect((await b.platform.key.status()).importFailure?.code).toBe('rate-limited');
    b.platform.testing.setConsent(true);
    b.clock.advance(11 * 60_000);
    await openImport(b);
    await b.platform.key.import({ recoveryKey: recovery });
    expect((await b.platform.key.status()).importFailure ?? null, 'effacé à la réussite').toBeNull();
    await openImport(b);
    expect(await codeOf(b.platform.key.import({ recoveryKey: 'CT1-AAAAA' }))).toBe('invalid-pairing');
    await b.platform.folder.forget({ eraseKey: false });
    expect((await b.platform.key.status()).importFailure ?? null, 'effacé par l’oubli du dossier').toBeNull();
  });

  it('ancienne clé de secours sur B, qui la détient déjà et a lu l’annonce : key-mismatch, jamais « associé »', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    const old = await recoveryOf(a);
    expect((await a.service.resetSync()).kind).toBe('started');
    syncFolders(room.devices);
    await b.cycle();
    await b.platform.key.openPairing('import');
    expect(await codeOf(b.platform.key.import({ recoveryKey: old }))).toBe('key-mismatch');
  });
});

describe('seconde revue, point 2 : don de la clé hors réinitialisation', () => {
  it('un oublié dont l’état attend iCloud ne bloque pas « Associer l’iPhone » ; un actif, si (cloud-pending)', async () => {
    const [a, b, c] = (await setupRoom(room, [B_ID, C_ID])) as [SimDevice, SimDevice, SimDevice];
    void a;
    b.folder.setAvailability(C_ID, 'state.ctx', 'cloud');
    expect(await codeOf(b.platform.key.openPairing('show'))).toBe('cloud-pending');
    b.folder.setAvailability(C_ID, 'state.ctx', 'local');
    expect(await b.service.forgetDevice(c.id)).toEqual({ kind: 'done' });
    b.folder.setAvailability(C_ID, 'state.ctx', 'cloud');
    expect(await codeOf(b.platform.key.openPairing('show'))).toBe('ok');
  });
});
