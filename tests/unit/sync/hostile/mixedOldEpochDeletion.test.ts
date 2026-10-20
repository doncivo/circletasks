import { afterEach, beforeAll, expect, it } from 'vitest';
import { compareEpochs, type EpochId } from '../../../../src/domain/sync/format';
import { statusLine } from '../../../../src/features/sync/syncText';
import { createSimDevice, setupFirst, warmSimDevices, type SimDevice } from '../../../sim/syncDevice';

const SELF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OLD = 'e0001-11111111-1111-4111-8111-111111111111' as EpochId;
let device: SimDevice | null = null;
beforeAll(warmSimDevices);
afterEach(async () => { await device?.close(); device = null; });

it('REL-02 : une suppression partielle ne dit pas À jour quand un substitut ancien reste après un échec', async () => {
  const a = await createSimDevice(SELF, { name: 'iPhone', devicePlatform: 'ios' });
  device = a;
  await setupFirst(a);
  await a.createTask('Témoin');
  await a.cycle();
  const current = JSON.parse((await a.data.repos.sync.getMeta('epoch')) ?? 'null') as EpochId;
  expect(compareEpochs(OLD, current)).toBeLessThan(0);
  const dir = a.folder.devices.get(a.id);
  const source = dir?.epochs.get(current)?.snapshots.values().next().value;
  if (!dir || !source) throw new Error('instantané initial absent');
  // Restes d'une ancienne époque : mêmes données, en-tête et fin adaptés ; ils ne sont plus annoncés par l'état courant.
  const copy = (n: number) => ({
    ...source,
    header: { ...source.header, e: OLD, n },
    lines: source.lines.map((line) => ({ ...line, text: line.text.replaceAll(current, OLD) })),
  });
  dir.epochs.set(OLD, { segments: new Map(), snapshots: new Map([[1, copy(1)], [2, copy(2)]]) });
  const first = `${OLD}/s-00000001.cts`;
  const left = `${OLD}/s-00000002.cts`;
  a.folder.armFaults({ name: 'suppression-ancienne-partielle', options: { removeLeavesPlaceholder: true }, faults: [
    { id: 'substitut', op: 'list', file: `devices/${SELF}/${left}`, nth: 1, effect: 'placeholder' },
    { id: 'premier-refus', op: 'remove', file: `devices/${SELF}/${first}`, nth: 1, effect: 'error', code: 'io' },
  ] });
  const refused = await a.cycle();
  expect(refused.ownDelete).toMatchObject([{ epoch: OLD, code: 'io' }]);
  expect(statusLine(refused, a.clock.nowMs())).not.toContain('À jour');

  // Le refus ponctuel est consommé ; le premier fichier part, le substitut reste. Aucun délai réel ni nouvelle panne.
  const retried = await a.cycle();
  const files = a.folder.fileNames(a.id);
  expect(files).not.toContain(first);
  expect(files).toContain(left);
  const line = statusLine(retried, a.clock.nowMs());
  const persistedFailure = await a.data.repos.sync.getMeta('ownDeleteFailure');
  expect(line, JSON.stringify({ line, ownDelete: retried.ownDelete ?? [], pending: retried.pendingFiles, persistedFailure, left })).not.toContain('À jour');
});
