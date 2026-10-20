import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSimDevice, pair, setupFirst, syncFolders, warmSimDevices, SCHEMA_VERSION, type SimDevice } from '../../../sim/syncDevice';
import { META, readJson } from '../../../../src/sync/meta';
import type { DeviceAck } from '../../../../src/domain/sync/format';

const A = '56d4eec1-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'ef50b6f7-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let devices: SimDevice[] = [];
beforeAll(warmSimDevices);
afterEach(async () => { await Promise.all(devices.map((d) => d.close())); devices = []; });
async function paired() {
  const a = await createSimDevice(A);
  const b = await createSimDevice(B, { devicePlatform: 'ios', clock: a.clock });
  devices = [a, b];
  a.platform.testing.setHydrationDelay(1_000);
  await setupFirst(a);
  await a.cycle();
  await pair(a, b);
  await b.createTask('Première écriture');
  await b.cycle();
  syncFolders(devices);
  await a.cycle();
  return { a, b };
}
const headOf = async (d: SimDevice) => {
  const head = await readJson<DeviceAck>(d.data.repos, META.head);
  if (!head) throw new Error('tête absente');
  return head;
};
const fileOf = (head: DeviceAck) => `${head.epoch}/j-${String(head.segment).padStart(8, '0')}.ctj`;

describe('Y-IOS-07 : lecture et purge après rotation', () => {
  it('le PC ne traverse pas le segment évincé tant que son dernier enregistrement manque', async () => {
    const { a, b } = await paired();
    const unread = await b.createTask('Ancien segment non lu');
    await b.cycle();
    const old = await headOf(b);
    b.folder.setAvailability(b.id, fileOf(old), 'cloud');
    const late = await b.createTask('Segment suivant');
    await b.cycle();
    expect((await headOf(b)).segment).toBe(old.segment + 1);
    syncFolders(devices);
    a.folder.armFaults({ name: 'lecture-sans-trou', faults: [{ id: 'pending-old', op: 'hydrate', file: `devices/${B}/${fileOf(old)}`, nth: 1, effect: 'download-error' }] });
    const waiting = await a.cycle();
    expect(waiting.phase).not.toBe('idle');
    expect(a.folder.faultLog().map((f) => f.id)).toContain('pending-old');
    expect(await a.task(unread.id)).toBeNull();
    expect(await a.task(late.id)).toBeNull();
    a.folder.disarmFaults();
    await a.cycle();
    expect((await a.task(unread.id))?.title).toBe('Ancien segment non lu');
    expect((await a.task(late.id))?.title).toBe('Segment suivant');
    const scan = await b.platform.scan({ keep: [] });
    expect(scan.devices.find((d) => d.deviceId === b.id)?.state?.closed).toContainEqual({ segment: old.segment, records: old.record });
  });

  it('vingt segments courts sont conservés avant accusé puis purgés, jamais la tête', async () => {
    const { a, b } = await paired();
    const tasks = [];
    for (let n = 0; n < 20; n += 1) {
      b.folder.setAvailability(b.id, fileOf(await headOf(b)), 'cloud');
      tasks.push(await b.createTask(`Court ${String(n)}`));
      await b.cycle();
    }
    const current = await headOf(b);
    expect(b.folder.fileNames(b.id).filter((name) => name.endsWith('.ctj'))).toHaveLength(21);
    a.clock.advance(31 * 86_400_000);
    // Le PC est actif mais n'a pas lu ces segments : annonce fraîche, accusés inchangés.
    const own = (await a.platform.scan({ keep: [] })).devices.find((d) => d.deviceId === a.id)?.state;
    if (!own) throw new Error('état PC absent');
    await a.platform.writeState({ sv: SCHEMA_VERSION, state: { ...own, stateSeq: own.stateSeq + 1, head: { ...own.head, stateSeq: own.stateSeq + 1 }, lastSyncHlc: a.hlc.now() } });
    syncFolders(devices);
    const beforeAck = await b.cycle();
    expect(beforeAck.warnings ?? []).not.toContain('folder-large');
    expect(b.folder.fileNames(b.id).filter((name) => name.endsWith('.ctj'))).toHaveLength(21);
    syncFolders(devices);
    await a.cycle();
    for (const task of tasks) expect((await a.task(task.id))?.title).toBe(task.title);
    syncFolders(devices);
    await b.cycle();
    expect(b.folder.fileNames(b.id).filter((name) => name.endsWith('.ctj'))).toEqual([fileOf(current)]);
    expect((await headOf(b)).segment).toBe(current.segment);
  });
});
