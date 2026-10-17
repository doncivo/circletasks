import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../../domain/types';
import { backupDeviceLabel, backupEpochLabel, backupOriginLabels, backupRowName, EMPTY_BACKUP_CONTEXT, hasBackupOrigin, type BackupDevice, type BackupLabelContext } from './backupLabels';
import { decodeStoredEpoch } from './useBackupLabelContext';

/** Y-TECH-04 partie C, critères 18 à 21 et 23 : chaque cas de libellé, en fonctions pures. */
const OWN = '7d0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const OTHER_PC = '56d40a0a-1b2c-4d3e-8f4a-5b6c7d8e9f01';
const PHONE = 'a1b2c3d4-0000-4000-8000-00000000abcd';
const NEVER_SEEN = '9f8e7d6c-1111-4222-8333-444455556666';
const FORGOTTEN = '56d40a0a-ffff-4fff-8fff-ffffffffffff';

const device = (deviceId: string, platform: 'windows' | 'ios', extra: Partial<BackupDevice> = {}): BackupDevice => ({ deviceId: deviceId as DeviceId, platform, seen: true, status: 'active', ...extra });
const context = (overrides: Partial<BackupLabelContext> = {}): BackupLabelContext => ({
  ownId: OWN,
  devices: [device(OWN, 'windows'), device(PHONE, 'ios')],
  currentEpoch: `e0002-${OWN}`,
  ...overrides,
});

describe('libellé de l’appareil d’une sauvegarde', () => {
  it('« Cet appareil » pour l’identité propre', () => {
    expect(backupDeviceLabel(OWN, 'windows', context())).toBe('Cet appareil');
  });

  it('« Cet appareil » même sans ligne d’appareils (identité lue dans les réglages)', () => {
    expect(backupDeviceLabel(OWN, 'windows', { ...EMPTY_BACKUP_CONTEXT, ownId: OWN })).toBe('Cet appareil');
  });

  it('nom lisible d’un appareil connu : « iPhone », « PC »', () => {
    expect(backupDeviceLabel(PHONE, 'ios', context())).toBe('iPhone');
    expect(backupDeviceLabel(OTHER_PC, 'windows', context({ devices: [device(PHONE, 'ios'), device(OTHER_PC, 'windows')] }))).toBe('PC');
  });

  it('deux PC : plateforme et 4 caractères', () => {
    const twins = context({ devices: [device(OWN, 'windows'), device(OTHER_PC, 'windows')] });
    expect(backupDeviceLabel(OTHER_PC, 'windows', twins)).toBe('PC 56d4');
  });

  it('identité oubliée : « PC 56d4 (oublié) » même sans jumeau, iPhone compris', () => {
    const forgotten = context({ devices: [device(OWN, 'windows'), device(FORGOTTEN, 'windows', { status: 'forgotten' })] });
    expect(backupDeviceLabel(FORGOTTEN, 'windows', forgotten)).toBe('PC 56d4 (oublié)');
    const phone = context({ devices: [device(OWN, 'windows'), device(PHONE, 'ios', { status: 'forgotten' })] });
    expect(backupDeviceLabel(PHONE, 'ios', phone)).toBe('iPhone a1b2 (oublié)');
  });

  it('appareil jamais vu : nom neutre à 8 caractères, jamais l’identifiant entier', () => {
    const label = backupDeviceLabel(NEVER_SEEN, 'windows', context());
    expect(label).toBe('Appareil 9f8e7d6c');
    expect(label).not.toContain(NEVER_SEEN);
  });

  it('appareil déclaré mais jamais lu (seen faux) : même nom neutre', () => {
    const unseen = context({ devices: [device(OWN, 'windows'), device(OTHER_PC, 'windows', { seen: false })] });
    expect(backupDeviceLabel(OTHER_PC, 'windows', unseen)).toBe('Appareil 56d40a0a');
  });

  it('identifiant absent ou vide : « Appareil inconnu »', () => {
    expect(backupDeviceLabel(null, null, context())).toBe('Appareil inconnu');
    expect(backupDeviceLabel(undefined, null, context())).toBe('Appareil inconnu');
    expect(backupDeviceLabel('', null, context())).toBe('Appareil inconnu');
  });

  it('identité propre inconnue : une sauvegarde n’est jamais « Cet appareil » par erreur', () => {
    expect(backupDeviceLabel(OWN, 'windows', { ...EMPTY_BACKUP_CONTEXT })).toBe('Appareil 7d0b1c2d');
  });
});

describe('libellé de l’époque d’une sauvegarde', () => {
  const ctx = context({ currentEpoch: `e0001-${PHONE}` });

  it('« époque 1, ouverte par iPhone » : numéro sans zéros de tête, ouvreur nommé', () => {
    expect(backupEpochLabel(`e0001-${PHONE}`, ctx)).toEqual({ text: 'époque 1, ouverte par iPhone', other: false });
    expect(backupEpochLabel(`e0012-${PHONE}`, ctx).text).toBe('époque 12, ouverte par iPhone');
  });

  it('ouvreur en jumeau : « PC 56d4 » ; ouvreur oublié : « PC 56d4 (oublié) » ; soi-même : « cet appareil »', () => {
    const twins = context({ devices: [device(OWN, 'windows'), device(OTHER_PC, 'windows')], currentEpoch: null });
    expect(backupEpochLabel(`e0003-${OTHER_PC}`, twins).text).toBe('époque 3, ouverte par PC 56d4');
    const forgotten = context({ devices: [device(OWN, 'windows'), device(FORGOTTEN, 'windows', { status: 'forgotten' })], currentEpoch: null });
    expect(backupEpochLabel(`e0003-${FORGOTTEN}`, forgotten).text).toBe('époque 3, ouverte par PC 56d4 (oublié)');
    expect(backupEpochLabel(`e0003-${OWN}`, forgotten).text).toBe('époque 3, ouverte par cet appareil');
  });

  it('ouvreur inconnu (réinitialisation, identifiant aléatoire) : « époque N » seul', () => {
    expect(backupEpochLabel(`e0004-${NEVER_SEEN}`, context({ currentEpoch: null })).text).toBe('époque 4');
  });

  it('epoch absent, vide ou null : aucune mention, jamais « autre époque »', () => {
    for (const epoch of [null, undefined, '']) expect(backupEpochLabel(epoch, ctx)).toEqual({ text: null, other: false });
  });

  it('forme illisible : aucun identifiant brut affiché', () => {
    expect(backupEpochLabel('n’importe quoi', ctx).text).toBeNull();
  });

  it('« autre époque » quand l’époque diffère de l’époque courante, pas quand elle est la même', () => {
    expect(backupEpochLabel(`e0001-${PHONE}`, context({ currentEpoch: `e0002-${OWN}` })).other).toBe(true);
    expect(backupEpochLabel(`e0002-${OWN}`, context({ currentEpoch: `e0002-${OWN}` })).other).toBe(false);
  });

  it('comparaison impossible (époque courante inconnue) : pas de fausse alerte', () => {
    expect(backupEpochLabel(`e0001-${PHONE}`, context({ currentEpoch: null }))).toEqual({ text: 'époque 1, ouverte par iPhone', other: false });
  });
});

describe('ligne complète et nom accessible', () => {
  it('champs absents (service qui ne les fournit pas) : aucune origine', () => {
    expect(hasBackupOrigin({})).toBe(false);
    expect(backupOriginLabels({}, context())).toBeNull();
  });

  it('champs à null (Rust : illisible) : « Appareil inconnu » et aucune époque', () => {
    expect(hasBackupOrigin({ deviceId: null, platform: null, epoch: null })).toBe(true);
    expect(backupOriginLabels({ deviceId: null, platform: null, epoch: null }, context())).toEqual({ device: 'Appareil inconnu', epoch: null, otherEpoch: null });
  });

  it('sauvegarde d’une autre époque faite par l’iPhone', () => {
    expect(backupOriginLabels({ deviceId: PHONE, platform: 'ios', epoch: `e0001-${PHONE}` }, context())).toEqual({ device: 'iPhone', epoch: 'époque 1, ouverte par iPhone', otherEpoch: 'autre époque' });
  });

  it('le nom accessible lit la date, l’appareil et l’époque', () => {
    const origin = backupOriginLabels({ deviceId: PHONE, platform: 'ios', epoch: `e0001-${PHONE}` }, context());
    expect(backupRowName({ when: '3 oct. à 03:12', origin, details: '40 Ko · 1 tâche', tag: null })).toBe('3 oct. à 03:12, iPhone, époque 1, ouverte par iPhone, autre époque, 40 Ko · 1 tâche');
    expect(backupRowName({ when: '1 oct. à 10:00', origin: null, details: '30 Ko', tag: 'Avant mise à jour' })).toBe('1 oct. à 10:00, 30 Ko, Avant mise à jour');
  });
});

describe('époque courante lue dans sync_meta', () => {
  it('texte JSON décodé ; absente, vide ou d’une autre forme : inconnue', () => {
    expect(decodeStoredEpoch(JSON.stringify(`e0001-${PHONE}`))).toBe(`e0001-${PHONE}`);
    expect(decodeStoredEpoch(null)).toBeNull();
    expect(decodeStoredEpoch('""')).toBeNull();
    expect(decodeStoredEpoch('12')).toBeNull();
  });
});

describe('feuille de style de la ligne', () => {
  it('feuille de style : l’appareil et l’époque passent à la ligne, sans troncature (393 pt)', () => {
    const css = readFileSync(new URL('./BackupSheet.css', import.meta.url), 'utf8');
    const origin = css.slice(css.indexOf('.ct-backup__versionOrigin'), css.indexOf('/* Étiquette'));
    expect(origin).toContain('white-space: normal');
    expect(origin).toContain('flex-wrap: wrap');
    expect(css).toContain('overflow-wrap: anywhere');
    expect(css).not.toMatch(/text-overflow|ellipsis|nowrap/);
  });
});
