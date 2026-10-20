import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createSimDevice, SCHEMA_VERSION, setupFirst, warmSimDevices, type SimDevice } from '../../sim/syncDevice';
import { publishOutbox } from '../../../src/sync/publisher';
import { META, readJson } from '../../../src/sync/meta';
import { SyncPlatformError } from '../../../src/platform/sync/types';
import type { SyncDeps } from '../../../src/sync/deps';
import type { DeviceAck } from '../../../src/domain/sync/format';

vi.mock('../../../src/sync/publishRotation', () => { throw new Error('bloc de lecture indisponible'); });

let d: SimDevice;
let head: DeviceAck;
let deps: SyncDeps;
beforeAll(warmSimDevices);
beforeEach(async () => {
  d = await createSimDevice('ef50b6f7-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { devicePlatform: 'ios' });
  await setupFirst(d);
  await d.cycle();
  await d.createTask('Avant');
  await d.cycle();
  const value = await readJson<DeviceAck>(d.data.repos, META.head);
  if (!value || value.segment < 1) throw new Error('tête absente');
  head = value;
  d.folder.setAvailability(d.id, `${head.epoch}/j-${String(head.segment).padStart(8, '0')}.ctj`, 'cloud');
  await d.createTask('Après');
  deps = { data: d.data, platform: d.platform, deviceId: d.id, devicePlatform: d.devicePlatform, hlc: d.hlc, clock: d.clock, logger: d.logger, sv: SCHEMA_VERSION, appVersion: '0.3.3' };
});
afterEach(async () => { await d.close(); });

it('le premier ajout après éviction ne dépend pas du bloc de lecture du mémo', async () => {
  const result = await publishOutbox(deps, head.epoch, head, head.segment);
  expect(result.error).toBeNull();
  expect(result.head.segment).toBe(head.segment + 1);
  expect(await d.data.repos.sync.readOutbox()).toEqual([]);
});

it('un échec sur la cible est mémorisé même si le bloc de lecture ne charge pas', async () => {
  const append = d.platform.appendJournal.bind(d.platform);
  deps = { ...deps, platform: { ...d.platform, appendJournal: (request) => request.segment > head.segment ? Promise.reject(new SyncPlatformError('io')) : append(request) } };
  const result = await publishOutbox(deps, head.epoch, head, head.segment);
  expect(result.error).toBe('io');
  expect(JSON.parse((await d.data.repos.sync.getMeta('publishRotation')) ?? 'null')).toMatchObject({ code: 'io', segment: head.segment + 1 });
  expect((await d.data.repos.sync.readOutbox()).length).toBeGreaterThan(0);
});
