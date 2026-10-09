import { describe, expect, it } from 'vitest';
import { accountDisplayName } from './accountName';

describe('accountDisplayName (ADR 0011 section 8)', () => {
  it('iCloud : identifiant Apple de cet appareil quand il existe', () => {
    expect(accountDisplayName({ provider: 'icloud', label: '', username: 'ali@icloud.com' })).toBe('ali@icloud.com');
  });

  it('iCloud reçu d’un autre appareil, sans identifiant ici : « Compte iCloud » (jamais un nom vide)', () => {
    expect(accountDisplayName({ provider: 'icloud', label: '', username: '' })).toBe('Compte iCloud');
    expect(accountDisplayName({ provider: 'icloud', label: 'libellé publié', username: '' })).toBe('Compte iCloud');
  });

  it('Google : libellé publié (adresse du compte), quel que soit `username`', () => {
    expect(accountDisplayName({ provider: 'google', label: 'ali@gmail.com', username: '' })).toBe('ali@gmail.com');
  });
});
