import { describe, expect, it } from 'vitest';
import { asIsoDateTime } from './types';
import { TRASH_RETENTION_DAYS, isInTrash, isPurgeable, sortTrash, trashCutoff } from './taskTrash';

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const at = (iso: string) => ({ deletedAt: asIsoDateTime(iso) });

describe('corbeille 30 jours (T-08)', () => {
  it('la rétention est de 30 jours', () => {
    expect(TRASH_RETENTION_DAYS).toBe(30);
    expect(trashCutoff(NOW)).toBe('2026-10-01T12:00:00.000Z');
  });

  it('une tâche non supprimée n’est ni dans la corbeille ni purgeable', () => {
    expect(isInTrash({ deletedAt: null }, NOW)).toBe(false);
    expect(isPurgeable({ deletedAt: null }, NOW)).toBe(false);
  });

  it('supprimée il y a moins de 30 jours : dans la corbeille, pas purgeable', () => {
    expect(isInTrash(at('2026-10-30T12:00:00.000Z'), NOW)).toBe(true);
    expect(isPurgeable(at('2026-10-30T12:00:00.000Z'), NOW)).toBe(false);
  });

  it('exactement 30 jours : encore visible, jamais purgée plus tôt', () => {
    expect(isInTrash(at('2026-10-01T12:00:00.000Z'), NOW)).toBe(true);
    expect(isPurgeable(at('2026-10-01T12:00:00.000Z'), NOW)).toBe(false);
  });

  it('plus de 30 jours : hors corbeille et purgeable', () => {
    expect(isInTrash(at('2026-10-01T11:59:59.999Z'), NOW)).toBe(false);
    expect(isPurgeable(at('2026-10-01T11:59:59.999Z'), NOW)).toBe(true);
  });

  it('sortTrash : filtre l’expiré et trie de la plus récente à la plus ancienne', () => {
    const a = at('2026-10-10T08:00:00.000Z');
    const b = at('2026-10-20T08:00:00.000Z');
    const old = at('2026-08-01T08:00:00.000Z');
    expect(sortTrash([a, old, b], NOW)).toEqual([b, a]);
  });
});
