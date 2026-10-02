import { describe, expect, it } from 'vitest';
import { taskLineSegments } from './taskLine';
import { asEntityId, asLocalTime, type SpaceId } from './types';

const PRO = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000001');
const task = (over: { time?: string | null; carriedOver?: boolean } = {}) => ({
  spaceId: PRO,
  carriedOver: over.carriedOver ?? false,
  time: over.time === undefined || over.time === null ? null : asLocalTime(over.time),
});
const kinds = (segments: readonly { kind: string }[]): string[] => segments.map((s) => s.kind);

describe('taskLineSegments (A-01 critère 5, note de revue T-02)', () => {
  it('« HH:MM · Espace » en filtre Tout', () => {
    expect(taskLineSegments(task({ time: '09:00' }), { showSpace: true, hasRule: false })).toEqual([
      { kind: 'time', time: '09:00' },
      { kind: 'space', spaceId: PRO },
    ]);
  });

  it('en filtre d’espace, l’espace est omis', () => {
    expect(kinds(taskLineSegments(task({ time: '09:00' }), { showSpace: false, hasRule: false }))).toEqual(['time']);
  });

  it('sans heure : espace seul en filtre Tout, rien sinon', () => {
    expect(kinds(taskLineSegments(task(), { showSpace: true, hasRule: false }))).toEqual(['space']);
    expect(taskLineSegments(task(), { showSpace: false, hasRule: false })).toEqual([]);
  });

  it('ordre heure, reportée, espace, répétition', () => {
    expect(kinds(taskLineSegments(task({ time: '09:00', carriedOver: true }), { showSpace: true, hasRule: true }))).toEqual(['time', 'carried', 'space', 'repeat']);
  });
});
