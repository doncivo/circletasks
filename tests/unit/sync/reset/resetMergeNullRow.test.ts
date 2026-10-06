import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DeviceId } from '../../../../src/domain/types';
import { syncFolders, warmSimDevices, type SimDevice } from '../../../sim/syncDevice';
import { B_ID, C_ID, closeAll, publishedState, reassociate, setupRoom, type Room } from './resetKit';

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

type Row = { epoch: string | null; cursor_segment: number; cursor_record: number };
const rowOf = async (d: SimDevice, id: string): Promise<Row | undefined> =>
  (await d.driver.select<Row>('SELECT epoch, cursor_segment, cursor_record FROM sync_state WHERE device_id = ?', [id]))[0];

describe('fusion, ligne sans époque (§21 point 4)', () => {
  it('ligne nulle avec covers en n → position covers ; ligne nulle sans entrée → aucune position ; ligne en n → gardée', async () => {
    const [a, b, c] = (await setupRoom(room, [B_ID, C_ID])) as [SimDevice, SimDevice, SimDevice];
    await c.createTask('C1');
    await c.cycle();
    syncFolders(room.devices);
    await a.cycle();
    await b.cycle();
    const before = await rowOf(b, C_ID);
    expect(before?.epoch).toMatch(/^e0001-/);

    expect((await a.service.resetSync()).kind).toBe('started');
    syncFolders([a, b]);
    expect((await b.cycle()).phase).toBe('reset-required');
    await reassociate(a, b, [a, b]);
    // Avant la fusion : B ne garde aucune position sur C (époque nulle), et connaît un fantôme jamais lu.
    await b.driver.execute('UPDATE sync_state SET epoch = NULL, cursor_segment = 0, cursor_record = 0, ack_hlc = NULL WHERE device_id = ?', [C_ID]);
    await b.data.repos.sync.saveState(P_ID, { status: 'active' });
    const kept = await rowOf(b, a.id);
    await b.cycle();
    const target = publishedState(b, b.id, 'next')?.epoch;
    expect(target).toMatch(/^e0002-/);

    // C : position de l'instantané d'ouverture de A (époque n), jamais {cible, 0, 0}.
    const c2 = await rowOf(b, C_ID);
    expect(c2?.epoch).toMatch(/^e0001-/);
    expect(c2?.epoch).not.toBe(target);
    // Fantôme : aucune position, aucun accusé publié.
    expect((await rowOf(b, P_ID))?.epoch ?? null).toBeNull();
    const acks = (JSON.parse((b.folder.devices.get(b.id)?.nextState?.lines[0]?.text ?? '{}')) as { acks?: Record<string, { epoch: string; segment: number; record: number }> }).acks ?? {};
    expect(acks[P_ID]).toBeUndefined();
    expect(acks[C_ID]).not.toMatchObject({ epoch: target, segment: 0, record: 0 });
    // A (ligne non nulle) : inchangé par la fusion (accusé figé en n, ou lu dans la cible ensuite).
    expect(kept?.epoch).toMatch(/^e0001-/);
  });
});
