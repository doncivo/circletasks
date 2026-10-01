import { describe, expect, it } from 'vitest';
import { resolveDefaultSpaceId, TASK_TITLE_MAX_LENGTH, validateTaskTitle } from './taskRules';
import { asEntityId, type SpaceId } from './types';

const PRO = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000001');
const PERSO = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000002');

describe('validateTaskTitle (T-01)', () => {
  it('retire les espaces en début et en fin (critère 12)', () => {
    expect(validateTaskTitle('  Payer la facture  ')).toEqual({ ok: true, value: 'Payer la facture' });
  });

  it('refuse un titre vide ou uniquement composé d’espaces (critère 2)', () => {
    expect(validateTaskTitle('')).toEqual({ ok: false, error: 'empty-title' });
    expect(validateTaskTitle('   ')).toEqual({ ok: false, error: 'empty-title' });
  });

  it('accepte 200 caractères, refuse au-delà avec un code d’erreur distinct (critère 13)', () => {
    expect(validateTaskTitle('a'.repeat(TASK_TITLE_MAX_LENGTH))).toEqual({
      ok: true,
      value: 'a'.repeat(TASK_TITLE_MAX_LENGTH),
    });
    expect(validateTaskTitle('a'.repeat(TASK_TITLE_MAX_LENGTH + 1))).toEqual({ ok: false, error: 'title-too-long' });
  });

  it('conserve accents, emoji et caractères spéciaux à l’identique (critère 14)', () => {
    const title = 'Café ☕ & “test”';
    expect(validateTaskTitle(title)).toEqual({ ok: true, value: title });
  });

  it('n’effectue aucun dédoublonnage : deux appels identiques renvoient la même valeur valide (critère 15)', () => {
    expect(validateTaskTitle('Appeler le notaire')).toEqual(validateTaskTitle('Appeler le notaire'));
  });
});

describe('resolveDefaultSpaceId (ES-02, critère 10)', () => {
  it('renvoie l’espace du filtre actif quand il n’est pas « Tout »', () => {
    expect(resolveDefaultSpaceId(PRO, PERSO)).toBe(PRO);
    expect(resolveDefaultSpaceId(PERSO, PRO)).toBe(PERSO);
  });

  it('renvoie l’espace de repli quand le filtre vaut « Tout »', () => {
    expect(resolveDefaultSpaceId('all', PRO)).toBe(PRO);
  });
});
