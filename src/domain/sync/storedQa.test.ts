import { describe, expect, it } from 'vitest';
import { parseStoredOwnStateMarks, parseStoredResumeTried, parseStoredSegmentGaps, SyncStateUnreadableError } from './stored';

// Y-TECH-02, QA de fin d'ordre 4 : analyse des valeurs locales de trou, d'instantané essayé et de repères (jamais lues comme « aucune »).
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EPOCH = `e0001-${A}`;
const log = { log: (): void => undefined };
const gap = { epoch: EPOCH, segment: 2, author: A, seq: 1, since: '2026-10-05T08:00:00.000Z' };

describe('parseStoredSegmentGaps', () => {
  it('QA-D1 absent : aucun trou ; entrée valide (auteur et numéro nuls permis) : lue', () => {
    expect(parseStoredSegmentGaps(null, 'x', log).size).toBe(0);
    expect(parseStoredSegmentGaps(JSON.stringify({ [A]: gap }), 'x', log).get(A as never)).toEqual(gap);
    expect(parseStoredSegmentGaps(JSON.stringify({ [A]: { ...gap, author: null, seq: null } }), 'x', log).size).toBe(1);
  });
  it.each([
    ['json cassé', '{oups'],
    ['tableau', '[]'],
    ['nul', 'null'],
    ['identifiant invalide', JSON.stringify({ x: gap })],
    ['entrée non objet', JSON.stringify({ [A]: 3 })],
    ['époque invalide', JSON.stringify({ [A]: { ...gap, epoch: 'e1' } })],
    ['segment négatif', JSON.stringify({ [A]: { ...gap, segment: -1 } })],
    ['segment fractionnaire', JSON.stringify({ [A]: { ...gap, segment: 1.5 } })],
    ['auteur invalide', JSON.stringify({ [A]: { ...gap, author: 'zz' } })],
    ['numéro texte', JSON.stringify({ [A]: { ...gap, seq: '1' } })],
    ['date absente', JSON.stringify({ [A]: { ...gap, since: undefined } })],
    ['date non ISO', JSON.stringify({ [A]: { ...gap, since: 'hier' } })],
  ])('QA-D2 %s : illisible, journalisé', (_n, raw) => {
    expect(() => parseStoredSegmentGaps(raw, 'sync_meta.segmentGaps', log)).toThrow(SyncStateUnreadableError);
  });
});

describe('parseStoredResumeTried', () => {
  it('QA-D3 absent : null ; auteur et numéro tous deux nuls ou tous deux présents : lus', () => {
    expect(parseStoredResumeTried(null, 'x', log)).toBeNull();
    expect(parseStoredResumeTried(JSON.stringify({ epoch: EPOCH, author: null, seq: null }), 'x', log)).toEqual({ epoch: EPOCH, author: null, seq: null });
    expect(parseStoredResumeTried(JSON.stringify({ epoch: EPOCH, author: A, seq: 0 }), 'x', log)?.seq).toBe(0);
  });
  it.each([
    ['json cassé', 'nope'],
    ['tableau', '[]'],
    ['auteur sans numéro', JSON.stringify({ epoch: EPOCH, author: A, seq: null })],
    ['numéro sans auteur', JSON.stringify({ epoch: EPOCH, author: null, seq: 2 })],
    ['époque absente', JSON.stringify({ author: null, seq: null })],
  ])('QA-D4 %s : illisible', (_n, raw) => {
    expect(() => parseStoredResumeTried(raw, 'x', log)).toThrow(SyncStateUnreadableError);
  });
});

describe('parseStoredOwnStateMarks', () => {
  const hlc = '2026-10-05T08:00:00.000Z-0000-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  it('QA-D5 absent : liste vide ; liste vide valide : vide', () => {
    expect(parseStoredOwnStateMarks(null, 'x', log)).toEqual([]);
    expect(parseStoredOwnStateMarks('[]', 'x', log)).toEqual([]);
  });
  it.each([
    ['json cassé', '['],
    ['objet', '{}'],
    ['paire trop courte', '[[1]]'],
    ['hlc invalide', '[[1,"x"]]'],
    ['numéro négatif', `[[-1,"${hlc}"]]`],
    ['numéros non croissants', `[[2,"${hlc}"],[2,"${hlc}"]]`],
  ])('QA-D6 %s : illisible', (_n, raw) => {
    expect(() => parseStoredOwnStateMarks(raw, 'x', log)).toThrow(SyncStateUnreadableError);
  });
});
