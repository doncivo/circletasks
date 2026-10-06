import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DeviceId } from '../../../../src/domain/types';
import type { IsoDateTime } from '../../../../src/domain/types';
import { propagate } from '../../../sim/syncCloudSim';
import { createSimDevice, pair, syncFolders, warmSimDevices, type SimDevice } from '../../../sim/syncDevice';
import { B_ID, C_ID, closeAll, publishedState, reassociate, settle, setupRoom, type Room } from './resetKit';

/**
 * Y-TECH-02, ADR 0011 §21 point 4 : changement d'époque en fusion (réassociation après une réinitialisation, Y-11), ligne d'un autre
 * appareil **sans époque** : `positionFromCover` (« l'accusé suit la base »), jamais {cible, 0, 0}. Lignes non nulles d'une autre époque
 * gardées (accusés figés, §18 point 14). Horloge simulée, aucun délai réel.
 */

const room: Room = { devices: [] };
beforeAll(warmSimDevices);
afterEach(() => closeAll(room));

/** Appareil connu de `sync_state` mais jamais lu (fantôme, appareil tout juste associé ailleurs). */
const P_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' as DeviceId;
/** Appareil sans position dont le dernier état accepté est déjà dans l'époque visée. */
const Q_ID = '11111111-1111-4111-8111-111111111111' as DeviceId;
/** Quatrième appareil, resté dans l'époque n (ligne non nulle). */
const D_ID = '99999999-9999-4999-8999-999999999999';

type Row = { epoch: string | null; cursor_segment: number; cursor_record: number };
const rowOf = async (d: SimDevice, id: string): Promise<Row | undefined> =>
  (await d.driver.select<Row>('SELECT epoch, cursor_segment, cursor_record FROM sync_state WHERE device_id = ?', [id]))[0];

describe('fusion, ligne sans époque (§21 point 4)', () => {
  it('ligne nulle avec covers en n → position covers ; ligne nulle sans entrée → aucune position ; ligne nulle, état déjà dans la cible → début de la cible ; ligne en n → gardée', async () => {
    const [a, b, c, d] = (await setupRoom(room, [B_ID, C_ID, D_ID])) as [SimDevice, SimDevice, SimDevice, SimDevice];
    await c.createTask('C1');
    await c.cycle();
    syncFolders(room.devices);
    await a.cycle();
    await b.cycle();
    expect((await rowOf(b, C_ID))?.epoch).toMatch(/^e0001-/);

    expect((await a.service.resetSync()).kind).toBe('started');
    const target = a.platform.testing.resetRecord()?.epoch as string;
    expect(target).toMatch(/^e0002-/);
    syncFolders([a, b]);
    expect((await b.cycle()).phase).toBe('reset-required');
    // Trois associations viennent d'ouvrir la boîte native : plafond de 3 par 10 minutes (horloge simulée).
    a.clock.advance(10 * 60_000);
    await reassociate(a, b, [a, b]);
    // Avant la fusion : B ne garde aucune position sur C (époque nulle), connaît un fantôme jamais lu (P) et un appareil sans position
    // dont le dernier état accepté est déjà dans la cible (Q) ; D garde sa position dans n.
    await b.driver.execute('UPDATE sync_state SET epoch = NULL, cursor_segment = 0, cursor_record = 0, ack_hlc = NULL WHERE device_id = ?', [C_ID]);
    await b.data.repos.sync.saveState(P_ID, { status: 'active' });
    await b.data.repos.sync.saveState(Q_ID, { status: 'active', stateEpoch: target });
    const keptD = await rowOf(b, d.id);
    expect(keptD?.epoch).toMatch(/^e0001-/);
    await b.cycle();
    expect(publishedState(b, b.id, 'next')?.epoch).toBe(target);

    // C : position de l'instantané d'ouverture de A (époque n), jamais {cible, 0, 0}.
    const c2 = await rowOf(b, C_ID);
    expect(c2?.epoch).toMatch(/^e0001-/);
    // P : aucune position, aucun accusé publié.
    expect((await rowOf(b, P_ID))?.epoch ?? null).toBeNull();
    // Q : son état est déjà dans la cible, il y est lu depuis le début.
    expect(await rowOf(b, Q_ID)).toEqual({ epoch: target, cursor_segment: 0, cursor_record: 0 });
    // D (ligne non nulle d'une autre époque), relu après la fusion : gardée telle quelle (accusé figé, §18 point 14).
    expect(await rowOf(b, d.id)).toEqual(keptD);
    const acks = (JSON.parse(b.folder.devices.get(b.id)?.nextState?.lines[0]?.text ?? '{}') as { acks?: Record<string, { epoch: string; segment: number; record: number }> }).acks ?? {};
    expect(acks[P_ID]).toBeUndefined();
    expect(acks[C_ID]).not.toMatchObject({ epoch: target, segment: 0, record: 0 });
  });

  it('simulation : réinitialisation après un « Appliquer partout » qui a laissé X sans position, puis oubli de X → suppression non bloquée', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    // X est associé par B et ne s'échange qu'avec B : A ne l'a jamais lu (aucune ligne, aucun accusé).
    const x = await createSimDevice(C_ID, { name: 'X', clock: a.clock });
    room.devices.push(x);
    await pair(b, x);
    // X reçoit le dossier de A (il le lit) ; A ne reçoit jamais celui de X.
    syncFolders([a, b]);
    for (const from of [a, b]) propagate(from.folder, x.folder, from.id);
    await x.cycle();
    await x.createTask('X1');
    await x.cycle();
    syncFolders([b, x]);
    await b.cycle();
    expect((await rowOf(b, x.id))?.epoch).toMatch(/^e0001-/);

    // A applique partout une restauration : covers de l'époque 2 sans entrée pour X ; B suit par remplacement, X sans position.
    a.platform.testing.setRestoreMarker({ backup: 'b', backupTakenAt: '2026-10-05T07:00:00.000Z' as IsoDateTime, restoredAt: '2026-10-05T07:30:00.000Z' as IsoDateTime, schemaVersion: 1 });
    await a.service.chooseRestoreOption('apply-everywhere');
    syncFolders([a, b]);
    await b.cycle();
    expect((await rowOf(b, x.id))?.epoch ?? null).toBeNull();
    await settle([a, b], 2);

    // A réinitialise ; B se réassocie (fusion) : X reste sans position, jamais {n+1, 0, 0}.
    expect((await a.service.resetSync()).kind).toBe('started');
    syncFolders([a, b]);
    expect((await b.cycle()).phase).toBe('reset-required');
    a.clock.advance(10 * 60_000);
    await reassociate(a, b, [a, b]);
    await settle([a, b], 4);
    expect(a.service.status().reset).toMatchObject({ step: 'done' });
    expect((await rowOf(b, x.id))?.epoch ?? null).toBeNull();

    // B oublie X : la suppression de ses fichiers n'est bloquée par aucun accusé {n+1, 0, 0}.
    expect(await b.service.forgetDevice(x.id)).toEqual({ kind: 'done' });
    await settle([a, b], 4);
    expect(b.folder.devices.has(x.id)).toBe(false);
    expect(b.service.status().forget?.deletions ?? []).toEqual([]);
    expect(b.service.status().forget?.failure ?? null).toBeNull();
  });
});
