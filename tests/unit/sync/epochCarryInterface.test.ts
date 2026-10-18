import { describe, expect, it } from 'vitest';
import { EPOCH_CARRY_HELD_EVENT, EPOCH_CARRY_HELD_MARK, EPOCH_CARRY_HELD_REASON, EPOCH_CARRY_NOTICE_MAX_ITEMS, EPOCH_CARRY_NOTICE_META, EPOCH_CARRY_REATTACHED_EVENT, addToEpochCarryNotice } from '../../../src/domain/sync/epochCarryNotice';
import { SYNC_WARNINGS } from '../../../src/domain/syncBanners';
import { CARRY_HELD_MARK } from '../../../src/sync/apply';
import { META } from '../../../src/sync/meta';

/**
 * Y-FIX-04 (critère 16) : interface livrée à Y-TECH-05 (fiche Y-FIX-04, « Interface attendue par Y-TECH-05 »), figée : un nom ou un champ
 * renommé fait échouer ce test ; mettre alors à jour `docs/stories/Y-TECH-05.md`.
 */
describe('interface du report d’époque vers Y-TECH-05', () => {
  it('noms d’événements, motif, clé, marque et avertissements', () => {
    expect(EPOCH_CARRY_REATTACHED_EVENT).toBe('epoch-carry-reattached');
    expect(EPOCH_CARRY_HELD_EVENT).toBe('epoch-carry-held');
    expect(EPOCH_CARRY_HELD_REASON).toBe('missing-parent');
    expect(EPOCH_CARRY_NOTICE_META).toBe('epochCarryNotice');
    // Copies lues au démarrage (hors du module chargé à la demande) : égales à l'interface.
    expect(META.epochCarryNotice).toBe(EPOCH_CARRY_NOTICE_META);
    expect(CARRY_HELD_MARK).toBe(EPOCH_CARRY_HELD_MARK);
    expect(EPOCH_CARRY_NOTICE_MAX_ITEMS).toBe(200);
    expect(SYNC_WARNINGS).toContain('carry-reattached');
    expect(SYNC_WARNINGS).toContain('carry-held');
  });

  it('forme de la notice (version 1) et d’un item', () => {
    const notice = addToEpochCarryNotice(null, {
      epoch: 'e00000002-aaaa',
      at: '2026-10-17T08:00:00.000Z',
      reattached: [{ table: 'task', rowId: 'r', column: 'project_id', parentId: 'p', space: 's', label: 'T', hlc: 'h' as never }],
      held: [],
    });
    expect(Object.keys(notice).sort()).toEqual(['at', 'epoch', 'held', 'overflow', 'reattached', 'v']);
    expect(notice.v).toBe(1);
    expect(Object.keys(notice.reattached[0] ?? {}).sort()).toEqual(['column', 'hlc', 'label', 'parentId', 'rowId', 'space', 'table']);
  });
});
