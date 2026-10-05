import { describe, expect, it } from 'vitest';
import { acceptsUnknownFrom, canRead, compareVersions, keepsUnknownFields, newerDevices, newerKind, type VersionRelation } from './compat';
import { SYNC_FORMAT_MAJOR } from './format';

/** Y-07 critère 1 : classement d'un appareil distant (ADR 0011 §7.2). */

const LOCAL = { sm: 1, sv: 17 };

describe('compareVersions (Y-07 critère 1)', () => {
  const cases: readonly [label: string, remote: { sm: number | null | undefined; sv: number | null | undefined }, expected: VersionRelation][] = [
    ['même majeure, même sv', { sm: 1, sv: 17 }, 'same'],
    ['même majeure, sv inférieur', { sm: 1, sv: 16 }, 'older'],
    ['même majeure, sv bien inférieur', { sm: 1, sv: 1 }, 'older'],
    ['même majeure, sv supérieur', { sm: 1, sv: 18 }, 'newer-schema'],
    ['majeure supérieure, sv supérieur', { sm: 2, sv: 30 }, 'newer-major'],
    ['majeure supérieure, sv inférieur (le sm prime)', { sm: 2, sv: 3 }, 'newer-major'],
    ['majeure supérieure, même sv', { sm: 2, sv: 17 }, 'newer-major'],
    ['sm non entier', { sm: 0.5, sv: 18 }, 'invalid'],
    ['sm absent', { sm: undefined, sv: 17 }, 'invalid'],
    ['sm nul', { sm: null, sv: 17 }, 'invalid'],
    ['sm à 0', { sm: 0, sv: 17 }, 'invalid'],
    ['sv absent', { sm: 1, sv: undefined }, 'invalid'],
    ['sv nul', { sm: 1, sv: null }, 'invalid'],
    ['sv à 0', { sm: 1, sv: 0 }, 'invalid'],
    ['sv négatif', { sm: 1, sv: -1 }, 'invalid'],
    ['sv non entier', { sm: 1, sv: 17.5 }, 'invalid'],
    ['sv NaN', { sm: 1, sv: Number.NaN }, 'invalid'],
    ['sm infini', { sm: Number.POSITIVE_INFINITY, sv: 17 }, 'invalid'],
  ];
  it.each(cases)('%s', (_label, remote, expected) => {
    expect(compareVersions(LOCAL, remote)).toBe(expected);
  });

  it('majeure inférieure : plus ancien, quel que soit le sv (un appareil plus récent lit les majeures plus anciennes)', () => {
    const local = { sm: 3, sv: 40 };
    expect(compareVersions(local, { sm: 2, sv: 50 })).toBe('older');
    expect(compareVersions(local, { sm: 1, sv: 1 })).toBe('older');
    expect(canRead(compareVersions(local, { sm: 2, sv: 50 }))).toBe(true);
  });

  it('version locale invalide : rien n’est classé', () => {
    expect(compareVersions({ sm: 0, sv: 17 }, { sm: 1, sv: 17 })).toBe('invalid');
    expect(compareVersions({ sm: 1, sv: null }, { sm: 1, sv: 17 })).toBe('invalid');
  });

  it('antisymétrie : older d’un côté, newer de l’autre ; same des deux côtés', () => {
    const versions = [
      { sm: 1, sv: 1 },
      { sm: 1, sv: 17 },
      { sm: 1, sv: 18 },
      { sm: 2, sv: 3 },
      { sm: 2, sv: 30 },
    ];
    for (const a of versions)
      for (const b of versions) {
        const ab = compareVersions(a, b);
        const ba = compareVersions(b, a);
        if (ab === 'same') expect(ba).toBe('same');
        if (ab === 'older') expect(['newer-schema', 'newer-major']).toContain(ba);
        if (ab === 'newer-schema' || ab === 'newer-major') expect(ba).toBe('older');
      }
  });
});

describe('règles tirées du classement', () => {
  it('lecture : tout sauf une majeure supérieure ou une version invalide', () => {
    expect(canRead('older')).toBe(true);
    expect(canRead('same')).toBe(true);
    expect(canRead('newer-schema')).toBe(true);
    expect(canRead('newer-major')).toBe(false);
    expect(canRead('invalid')).toBe(false);
  });

  it('champs inconnus gardés seulement d’une version de schéma strictement plus récente (critère 3)', () => {
    expect(keepsUnknownFields('newer-schema')).toBe(true);
    for (const r of ['older', 'same', 'newer-major', 'invalid'] as const) expect(keepsUnknownFields(r)).toBe(false);
    expect(acceptsUnknownFrom(17, 18)).toBe(true);
    expect(acceptsUnknownFrom(17, 17)).toBe(false);
    expect(acceptsUnknownFrom(17, 16)).toBe(false);
    expect(acceptsUnknownFrom(17, 0)).toBe(false);
  });

  it('newerKind : schema, major ou null', () => {
    expect(newerKind('newer-schema')).toBe('schema');
    expect(newerKind('newer-major')).toBe('major');
    for (const r of ['older', 'same', 'invalid'] as const) expect(newerKind(r)).toBeNull();
  });

  it('newerDevices : autres appareils actifs plus récents seulement (ni soi, ni absent, ni oublié, ni autre clé, ni plus ancien)', () => {
    const d = (id: string, extra: { self?: boolean; status?: string; newer?: 'schema' | 'major' | null }) => ({ id, self: false, status: 'active', ...extra });
    const devices = [
      d('self', { self: true, newer: 'schema' }),
      d('schema', { newer: 'schema' }),
      d('major', { status: 'newer-major', newer: 'major' }),
      d('expired', { status: 'expired', newer: 'schema' }),
      d('forgotten', { status: 'forgotten', newer: 'major' }),
      d('foreign', { status: 'foreign', newer: 'schema' }),
      d('older', { newer: null }),
      d('unknown', {}),
      d('clock', { status: 'clock-ahead', newer: 'schema' }),
    ];
    expect(newerDevices(devices).map((x) => x.id)).toEqual(['schema', 'major', 'clock']);
    expect(newerDevices([])).toEqual([]);
  });

  it('Y-07 critère 12 : la story ne change pas la majeure du format', () => {
    expect(SYNC_FORMAT_MAJOR).toBe(1);
  });
});
