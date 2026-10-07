import { describe, expect, it } from 'vitest';
import { compareCodeUnits } from './compareCodeUnits';

describe('compareCodeUnits', () => {
  it('ordre des unités de code, indépendant de la langue', () => {
    expect(compareCodeUnits('a', 'b')).toBe(-1);
    expect(compareCodeUnits('b', 'a')).toBe(1);
    expect(compareCodeUnits('a', 'a')).toBe(0);
    // Majuscules avant minuscules, accent après « z » : ce que localeCompare ne fait pas.
    expect(['é', 'z', 'B', 'a'].sort(compareCodeUnits)).toEqual(['B', 'a', 'z', 'é']);
    expect(compareCodeUnits('task:1', 'task:10')).toBe(-1);
  });
});
