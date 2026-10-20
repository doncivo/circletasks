import { describe, expect, it } from 'vitest';
import { parsePublishRotation } from './publishRotation';
import { SyncStateUnreadableError } from './stored';

const state = { epoch: 'e0001-ef50b6f7-bbbb-4bbb-8bbb-bbbbbbbbbbbb', segment: 2, code: 'cloud-pending', maxHlc: '001792476000000-0000-ef50b6f7-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
describe('intention de rotation persistée', () => {
  it('accepte uniquement une absence de clé ou une intention reconnue', () => {
    expect(parsePublishRotation(null)).toBeNull();
    expect(parsePublishRotation(JSON.stringify(state))).toEqual(state);
  });
  it.each(['null', '{}', '[]', '{bad', JSON.stringify({ ...state, segment: 0 }), JSON.stringify({ ...state, code: 'unknown' }), JSON.stringify({ ...state, epoch: 'broken' }), JSON.stringify({ ...state, maxHlc: 'broken' })])('un état illisible ne devient pas une absence (%s)', (raw) => {
    expect(() => parsePublishRotation(raw)).toThrow(SyncStateUnreadableError);
  });
});
