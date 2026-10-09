import { describe, expect, it } from 'vitest';
import { classifyLaunch, compareAppVersions, isAppVersion, shouldRecordLaunch } from './appUpdate';
import { isSharedSetting, SETTINGS_DEFINITIONS } from './model/settings';

/** I-06 (ADR 0007 avenant I-06 point 6) : premier lancement d'une nouvelle version, règle pure. */
describe('classifyLaunch', () => {
  it('première installation : aucune version mémorisée et aucune exécution antérieure', () => {
    expect(classifyLaunch(null, '0.3.0')).toBe('first-install');
    expect(classifyLaunch(undefined, '0.3.0', false)).toBe('first-install');
  });

  it('installation existante sans version mémorisée (première version qui la mémorise) : mise à jour', () => {
    expect(classifyLaunch(null, '0.3.0', true)).toBe('updated');
  });

  it('même version, plus récente, plus ancienne (comparaison numérique, pas alphabétique)', () => {
    expect(classifyLaunch('0.3.0', '0.3.0', true)).toBe('same');
    expect(classifyLaunch('0.2.3', '0.3.0', true)).toBe('updated');
    expect(classifyLaunch('0.2.9', '0.2.10', true)).toBe('updated');
    expect(classifyLaunch('0.3.0', '0.2.3', true)).toBe('downgraded');
    expect(classifyLaunch('1.0.0', '0.10.0', true)).toBe('downgraded');
  });

  it('version courante illisible (dont 0.0.0) : unknown, rien n’est décidé', () => {
    expect(classifyLaunch('0.2.3', null, true)).toBe('unknown');
    expect(classifyLaunch('0.2.3', '0.0.0', true)).toBe('unknown');
    expect(classifyLaunch(null, 'dev', false)).toBe('unknown');
  });

  it('valeur mémorisée illisible : comptée comme une mise à jour (une replanification de plus, sans effet néfaste)', () => {
    expect(classifyLaunch('n’importe quoi', '0.3.0', true)).toBe('updated');
    expect(classifyLaunch(42, '0.3.0', true)).toBe('updated');
    expect(classifyLaunch('0.0.0', '0.3.0', true)).toBe('updated');
  });

  it('mémorisation : jamais pour same ni unknown', () => {
    expect(shouldRecordLaunch('first-install')).toBe(true);
    expect(shouldRecordLaunch('updated')).toBe(true);
    expect(shouldRecordLaunch('downgraded')).toBe(true);
    expect(shouldRecordLaunch('same')).toBe(false);
    expect(shouldRecordLaunch('unknown')).toBe(false);
  });
});

describe('numéros de version', () => {
  it('isAppVersion : X.Y.Z seulement, 0.0.0 refusé', () => {
    expect(isAppVersion('0.2.3')).toBe(true);
    expect(isAppVersion('10.20.30')).toBe(true);
    for (const bad of ['0.0.0', '1.2', 'v1.2.3', '1.2.3-beta', '', null, 3]) expect(isAppVersion(bad)).toBe(false);
  });

  it('compareAppVersions : composant par composant ; numéro illisible : exception', () => {
    expect(compareAppVersions('0.3.0', '0.2.3')).toBeGreaterThan(0);
    expect(compareAppVersions('0.2.3', '0.2.3')).toBe(0);
    expect(compareAppVersions('0.2.10', '0.2.9')).toBeGreaterThan(0);
    expect(() => compareAppVersions('x', '0.1.0')).toThrow(RangeError);
  });
});

describe('réglage app.lastLaunchedVersion (D4)', () => {
  it('local, jamais synchronisé, absent par défaut', () => {
    expect(SETTINGS_DEFINITIONS['app.lastLaunchedVersion']).toEqual({ scope: 'local', defaultValue: null });
    expect(isSharedSetting('app.lastLaunchedVersion')).toBe(false);
  });
});
