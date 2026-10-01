import { describe, expect, it } from 'vitest';
import { encodeIcon, isValidIconRef, parseIcon } from './icon';
import { REMINDER_OFFSETS_MIN, isReminderOffset } from './reminder';
import { SETTINGS_DEFINITIONS, defaultSetting, isSharedSetting } from './settings';

describe('icône (T-03)', () => {
  it('encode et relit une icône Lucide ou un emoji', () => {
    expect(encodeIcon({ kind: 'lucide', name: 'glass-water' })).toBe('lucide:glass-water');
    expect(encodeIcon({ kind: 'emoji', value: '🥛' })).toBe('emoji:🥛');
    expect(parseIcon('lucide:file-text')).toEqual({ kind: 'lucide', name: 'file-text' });
    expect(parseIcon('emoji:👨‍👩‍👧')).toEqual({ kind: 'emoji', value: '👨‍👩‍👧' });
  });

  it('ignore les valeurs vides, inconnues ou invalides', () => {
    expect(parseIcon(null)).toBeNull();
    expect(parseIcon('sans-prefixe')).toBeNull();
    expect(parseIcon('svg:truc')).toBeNull();
    expect(parseIcon('lucide:Majuscule')).toBeNull();
    expect(parseIcon('emoji:')).toBeNull();
    expect(isValidIconRef({ kind: 'emoji', value: 'a b' })).toBe(false);
    expect(() => encodeIcon({ kind: 'lucide', name: 'pas valide' })).toThrow(TypeError);
  });
});

describe('rappels (N-02)', () => {
  it('connaît les avances autorisées', () => {
    expect(REMINDER_OFFSETS_MIN).toEqual([0, 5, 15, 30, 60, 1440]);
    expect(isReminderOffset(15)).toBe(true);
    expect(isReminderOffset(10)).toBe(false);
  });
});

describe('réglages', () => {
  it('fournit une valeur par défaut et une portée pour chaque clé', () => {
    expect(defaultSetting('spaces.filter')).toBe('all');
    expect(defaultSetting('reminders.morningRecap')).toEqual({ enabled: true, time: '08:00' });
    expect(isSharedSetting('general.theme')).toBe(true);
    expect(isSharedSetting('device.id')).toBe(false);
    for (const def of Object.values(SETTINGS_DEFINITIONS)) {
      expect(['local', 'shared']).toContain(def.scope);
    }
  });
});
