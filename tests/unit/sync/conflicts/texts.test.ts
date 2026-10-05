import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SYNC_TABLES, syncColumn, syncTable, type SyncColumn, type SyncTable } from '../../../../src/domain/sync/syncTables';
import type { DeviceId, IsoDateTime } from '../../../../src/domain/types';
import { registerCatalog, setLocale, tDynamic, translate, type MessageKey } from '../../../../src/i18n';
import { en } from '../../../../src/i18n/en';
import { fr } from '../../../../src/i18n/fr';
import { setFormatPrefs } from '../../../../src/i18n/formatPrefs';
import { conflictDeviceName, conflictSideMeta, conflictTitle, conflictValueText, fieldKey, quoted } from '../../../../src/features/sync/conflictText';
import type { SyncStatus } from '../../../../src/platform/sync/types';

/**
 * Textes du journal (Y-04 critères 2, 3 et 14) : un libellé `sync.field.<table>.<colonne>` en français et en anglais pour **chaque**
 * colonne `conflictVisible` du catalogue (aucun pour les champs masqués), parité des sections `sync.conflicts` et `sync.field`, valeurs
 * formatées par type, appareils nommés comme dans APPAREILS.
 */

beforeAll(() => registerCatalog('en', en));
afterEach(() => {
  setLocale('fr');
  setFormatPrefs({ timeFormat: '24h' });
});

const lookup = (messages: object, key: string): unknown => key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), messages);

const leaves = (node: unknown, prefix = ''): string[] =>
  node && typeof node === 'object' ? Object.entries(node).flatMap(([k, v]) => (typeof v === 'string' ? [`${prefix}${k}`] : leaves(v, `${prefix}${k}.`))) : [];

const HIDDEN = ['sort_order', 'created_at', 'done_at', 'fire_at', 'delivered', 'paused_sec', 'paused_at', 'series_template'];

describe('libellés des champs (critère 2)', () => {
  it('chaque colonne conflictVisible a son libellé en français et en anglais ; aucune colonne masquée n’en a', () => {
    const visible = SYNC_TABLES.flatMap((t) => t.columns.filter((c) => c.conflictVisible).map((c) => fieldKey(t, c)));
    expect(visible.length).toBeGreaterThan(100);
    for (const key of visible) {
      expect(typeof lookup(fr, key), `fr ${key}`).toBe('string');
      expect(typeof lookup(en, key), `en ${key}`).toBe('string');
    }
    const hidden = SYNC_TABLES.flatMap((t) => t.columns.filter((c) => !c.conflictVisible).map((c) => fieldKey(t, c)));
    expect(hidden.every((key) => lookup(fr, key) === undefined)).toBe(true);
    for (const t of SYNC_TABLES) for (const c of t.columns) if (HIDDEN.includes(c.name)) expect(c.conflictVisible, `${t.name}.${c.name}`).toBe(false);
    // Aucun libellé en trop (colonne disparue du catalogue).
    expect(leaves(fr.sync.field, 'sync.field.').sort()).toEqual([...visible].sort());
  });

  it('sections sync.conflicts et sync.field : mêmes clés en français et en anglais, aucun texte vide', () => {
    for (const section of ['conflicts', 'field'] as const) {
      expect(leaves(en.sync[section]).sort()).toEqual(leaves(fr.sync[section]).sort());
      for (const key of leaves(fr.sync[section])) {
        expect(String(lookup(fr.sync[section], key)).length, key).toBeGreaterThan(0);
        expect(String(lookup(en.sync[section], key)).length, key).toBeGreaterThan(0);
      }
    }
    expect(tDynamicIn('en', 'sync.field.task.time')).toBe('time');
  });
});

const col = (table: string, column: string): [SyncTable, SyncColumn] => [syncTable(table) as SyncTable, syncColumn(table, column) as SyncColumn];
const text = (table: string, column: string, value: unknown, ref: string | null = null): string => {
  const [t, c] = col(table, column);
  return conflictValueText(t, c, { value: value as never, ref }, Date.parse('2026-10-05T16:00:00.000Z'));
};

describe('valeurs (critère 3)', () => {
  it('texte entre « » tronqué à 80 caractères', () => {
    expect(text('task', 'note', 'lait, œufs, café')).toBe('« lait, œufs, café »');
    const long = 'é'.repeat(100);
    expect(text('task', 'title', long)).toBe(`« ${'é'.repeat(80)}… »`);
    expect(quoted('😀'.repeat(81))).toBe(`« ${'😀'.repeat(80)}… »`);
  });

  it('date « 22 sept. », heure en 24 h (format P-03), booléen, nombre, vide, énumération', () => {
    expect(text('task', 'date', '2026-09-22')).toBe('22 sept.');
    expect(text('task', 'time', '09:00')).toBe('09:00');
    setFormatPrefs({ timeFormat: '12h' });
    expect(text('task', 'time', '18:04')).toMatch(/^6:04\sPM$/);
    setFormatPrefs({ timeFormat: '24h' });
    expect(text('task', 'someday', 1)).toBe('Oui');
    expect(text('task', 'someday', 0)).toBe('Non');
    expect(text('routine', 'times_per_week', 3)).toBe('3');
    expect(text('task', 'time', null)).toBe('(vide)');
    expect(text('task', 'project_id', null)).toBe('Sans projet');
    expect(text('task', 'status', 'done')).toBe('terminée');
    expect(text('event', 'kind', 'birthday')).toBe('Anniversaire');
    expect(text('routine', 'schedule_type', 'daily')).toBe('daily');
    expect(text('task', 'project_id', '40000000-0000-4000-8000-000000000001', 'Clients')).toBe('« Clients »');
  });

  it('suppression contre modification : « supprimé » / « modifié » ; présent', () => {
    expect(text('task', 'deleted_at', '2026-10-05T08:00:00.000Z')).toBe('supprimé');
    expect(text('task', 'deleted_at', 'modified')).toBe('modifié');
    expect(text('task', 'deleted_at', null)).toBe('présent');
  });

  it('en anglais', () => {
    setLocale('en');
    expect(text('task', 'someday', 1)).toBe('Yes');
    expect(text('task', 'date', '2026-09-22')).toBe('Sep 22');
  });
});

const PC = '60000000-0000-4000-8000-0000000000a1' as DeviceId;
const IPHONE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as DeviceId;
const IPHONE2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as DeviceId;
const device = (deviceId: DeviceId, platform: 'windows' | 'ios', self = false): SyncStatus['devices'][number] => ({ deviceId, platform, self, lastReadAt: null, status: 'active' });

describe('appareils et heures (critère 3)', () => {
  it('« PC », « iPhone », suffixe de 4 caractères si deux semblables, « Autre appareil » si inconnu', () => {
    const two = [device(PC, 'windows', true), device(IPHONE, 'ios')];
    expect(conflictDeviceName(PC, two)).toBe('PC');
    expect(conflictDeviceName(IPHONE, two)).toBe('iPhone');
    const three = [...two, device(IPHONE2, 'ios')];
    expect(conflictDeviceName(IPHONE2, three)).toBe(translate('fr', 'sync.status.deviceNamed', { platform: 'iPhone', short: 'cccc' }));
    expect(conflictDeviceName('dddddddd-dddd-4ddd-8ddd-dddddddddddd' as DeviceId, two)).toBe('Autre appareil');
  });

  it('heure locale du hlc de la valeur : « iPhone · 18:04 »', () => {
    const at = new Date(2026, 9, 5, 18, 4).toISOString() as IsoDateTime;
    expect(conflictSideMeta({ device: IPHONE, at }, [device(IPHONE, 'ios')], new Date(2026, 9, 5, 20, 0).getTime())).toBe('iPhone · 18:04');
  });

  it('titre : élément supprimé ou purgé, type d’élément sans titre propre', () => {
    const [task] = col('task', 'title');
    expect(conflictTitle({ title: 'Courses', itemState: 'live', table: task })).toBe('Courses');
    expect(conflictTitle({ title: 'Courses', itemState: 'deleted', table: task })).toBe('Élément supprimé');
    expect(conflictTitle({ title: null, itemState: 'purged', table: task })).toBe('Élément supprimé');
    expect(conflictTitle({ title: null, itemState: 'live', table: syncTable('settings') as SyncTable })).toBe('Réglage');
  });
});


function tDynamicIn(locale: 'fr' | 'en', key: string): string {
  setLocale(locale);
  try {
    return tDynamic(key as MessageKey);
  } finally {
    setLocale('fr');
  }
}
