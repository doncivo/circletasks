import { describe, expect, it } from 'vitest';
import { orphansOutsideAccounts, parseOrphanSecrets, withOrphan, withoutOrphan } from './orphanSecrets';

const G = 'circletasks.calendar.google.a0000000-0000-4000-8000-000000000001';
const I = 'circletasks.calendar.icloud.a0000000-0000-4000-8000-000000000002';

describe('orphanSecrets (K-01, seconde revue PR #25)', () => {
  it('valeur brute : seules les références valables au format du coffre et du même fournisseur, sans doublon', () => {
    expect(parseOrphanSecrets(null)).toEqual([]);
    expect(parseOrphanSecrets('x')).toEqual([]);
    expect(
      parseOrphanSecrets([
        { provider: 'google', tokenRef: G },
        { provider: 'google', tokenRef: G },
        { provider: 'icloud', tokenRef: I },
        { provider: 'icloud', tokenRef: G },
        { provider: 'outlook', tokenRef: G },
        { provider: 'google', tokenRef: '' },
        { provider: 'google', tokenRef: 'circletasks.calendar.google.' },
        { provider: 'google', tokenRef: 42 },
        null,
      ]),
    ).toEqual([
      { provider: 'google', tokenRef: G },
      { provider: 'icloud', tokenRef: I },
    ]);
  });

  it('ajout sans doublon, retrait, et jamais la référence d’un compte', () => {
    const list = withOrphan(withOrphan([], { provider: 'google', tokenRef: G }), { provider: 'google', tokenRef: G });
    expect(list).toEqual([{ provider: 'google', tokenRef: G }]);
    expect(withoutOrphan(list, G)).toEqual([]);
    const both = withOrphan(list, { provider: 'icloud', tokenRef: I });
    expect(orphansOutsideAccounts(both, [G, ''])).toEqual([{ provider: 'icloud', tokenRef: I }]);
  });
});
