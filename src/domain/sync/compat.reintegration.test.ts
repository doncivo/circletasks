import { describe, expect, it } from 'vitest';
import type { Hlc } from '../types';
import { decideReintegration, keptFieldsOf, parseReintegrationFailure, type KeptField, type ReintegrationInput, type ReintegrationRow } from './compat';
import { syncTable, type SyncColumn, type SyncTable } from './syncTables';

/**
 * Décision de réintégration d'une ligne (Y-07 critère 6, revue point 2) : fonction pure ; le repository ne fait que lire et écrire.
 * Tableau de cas : ligne présente (horloge propre, repli « * », hlc de ligne, « même écriture », métadonnées), ligne absente (insertion
 * complète, attente, trace de purge), parent manquant, conflits, écritures en attente.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const h = (ms: number, dev = A): Hlc => `${String(1_791_187_200_000 + ms).padStart(15, '0')}-0000-${dev}` as Hlc;
const f = (name: string, value: string | number | null, hlc: Hlc, base: Hlc | null = null, conflictVisible = true): KeptField => ({ name, value, hlc, base, conflictVisible });
const row = (extra: Partial<ReintegrationRow> = {}): ReintegrationRow => ({ hlc: h(1_000, B), values: new Map([['x', null]]), clocks: new Map(), pending: new Set(), ...extra });
const input = (extra: Partial<ReintegrationInput>): ReintegrationInput => ({ fields: [], columns: ['a', 'x'], missingParents: new Set(), row: row(), tombstone: null, ...extra });

describe('decideReintegration : ligne présente', () => {
  const cases: readonly [label: string, input: ReintegrationInput, expected: { write: string; reintegrated: number; superseded: number; remove: string[] }][] = [
    ['plus récent que le hlc de la ligne (aucune horloge)', input({ fields: [f('x', 'v', h(2_000))] }), { write: 'update', reintegrated: 1, superseded: 0, remove: ['x'] }],
    ['plus ancien que le hlc de la ligne (aucune horloge)', input({ fields: [f('x', 'v', h(500))] }), { write: 'none', reintegrated: 0, superseded: 1, remove: ['x'] }],
    ['même écriture : hlc égal au hlc de la ligne, sans horloge propre', input({ fields: [f('x', 'v', h(1_000, B))] }), { write: 'update', reintegrated: 1, superseded: 0, remove: ['x'] }],
    ['même écriture : hlc égal au repli « * »', input({ fields: [f('x', 'v', h(700))], row: row({ clocks: new Map([['*', { hlc: h(700), base: null }]]) }) }), { write: 'update', reintegrated: 1, superseded: 0, remove: ['x'] }],
    ['plus ancien que le repli « * »', input({ fields: [f('x', 'v', h(600))], row: row({ clocks: new Map([['*', { hlc: h(700), base: null }]]) }) }), { write: 'none', reintegrated: 0, superseded: 1, remove: ['x'] }],
    ['entre le repli « * » et le hlc de la ligne', input({ fields: [f('x', 'v', h(800))], row: row({ clocks: new Map([['*', { hlc: h(700), base: null }]]) }) }), { write: 'update', reintegrated: 1, superseded: 0, remove: ['x'] }],
    ['horloge propre égale : rien (pas de « même écriture »)', input({ fields: [f('x', 'v', h(900))], row: row({ clocks: new Map([['x', { hlc: h(900), base: null }]]) }) }), { write: 'none', reintegrated: 0, superseded: 1, remove: ['x'] }],
    ['horloge propre plus récente', input({ fields: [f('x', 'v', h(900))], row: row({ clocks: new Map([['x', { hlc: h(950, B), base: null }]]) }) }), { write: 'none', reintegrated: 0, superseded: 1, remove: ['x'] }],
    ['horloge propre plus ancienne', input({ fields: [f('x', 'v', h(900))], row: row({ clocks: new Map([['x', { hlc: h(850, B), base: null }]]) }) }), { write: 'update', reintegrated: 1, superseded: 0, remove: ['x'] }],
    ['gagnant dont le parent manque : il attend', input({ fields: [f('a', 'p', h(2_000)), f('x', 'v', h(2_000))], missingParents: new Set(['a']) }), { write: 'update', reintegrated: 1, superseded: 0, remove: ['x'] }],
    ['perdant dont le parent manque : retiré quand même', input({ fields: [f('a', 'p', h(500))], missingParents: new Set(['a']) }), { write: 'none', reintegrated: 0, superseded: 1, remove: ['a'] }],
    ['aucun champ', input({ fields: [] }), { write: 'none', reintegrated: 0, superseded: 0, remove: [] }],
  ];
  it.each(cases)('%s', (_label, given, expected) => {
    const d = decideReintegration(given);
    expect({ write: d.write, reintegrated: d.reintegrated, superseded: d.superseded, remove: [...d.remove] }).toEqual(expected);
  });

  it('métadonnées de ligne seulement si le plus grand hlc écrit dépasse celui de la ligne ; repli « * » écrit s’il manque, à l’ancien hlc', () => {
    const newer = decideReintegration(input({ fields: [f('x', 'v', h(2_000))] }));
    expect(newer.meta).toEqual({ hlc: h(2_000), updatedAt: new Date(1_791_187_202_000).toISOString(), deviceId: A });
    expect(newer.clocks).toEqual([
      { field: '*', hlc: h(1_000, B), base: null },
      { field: 'x', hlc: h(2_000), base: null },
    ]);
    expect(newer.values).toEqual(new Map([['x', 'v']]));
    const between = decideReintegration(input({ fields: [f('x', 'v', h(800), h(1))], row: row({ clocks: new Map([['*', { hlc: h(700), base: null }]]) }) }));
    expect(between.meta).toBeNull();
    expect(between.clocks).toEqual([{ field: 'x', hlc: h(800), base: h(1) }]);
  });

  it('conflit inscrit (colonne visible, deux écritures qui ne se sont pas vues), jamais pour une colonne cachée ni pour la même écriture', () => {
    const local = row({ values: new Map([['x', 'locale']]), clocks: new Map([['x', { hlc: h(1_500, B), base: null }]]) });
    expect(decideReintegration(input({ fields: [f('x', 'reçue', h(900))], row: local })).conflicts.map((c) => c.field)).toEqual(['x']);
    expect(decideReintegration(input({ fields: [f('x', 'reçue', h(900), null, false)], row: local })).conflicts).toEqual([]);
    expect(decideReintegration(input({ fields: [f('x', 'reçue', h(1_000, B))], row: row({ values: new Map([['x', 'défaut']]) }) })).conflicts).toEqual([]);
  });

  it('écriture locale en attente écrasée par une valeur plus récente : retirée de la file ; le « * » en attente ne l’est pas', () => {
    const d = decideReintegration(input({ fields: [f('x', 'v', h(2_000))], row: row({ pending: new Set(['x', '*']) }) }));
    expect(d.dropPending).toEqual(['x']);
    expect(decideReintegration(input({ fields: [f('x', 'v', h(500))], row: row({ pending: new Set(['x']) }) })).dropPending).toEqual([]);
  });
});

describe('decideReintegration : ligne absente', () => {
  const absent = (extra: Partial<ReintegrationInput>) => input({ row: null, ...extra });
  it('complète (toutes les colonnes) et parents présents : insertion, horloges « * » au plus grand hlc et exceptions', () => {
    const d = decideReintegration(absent({ fields: [f('a', 'p', h(1_000)), f('x', 'v', h(2_000), h(1_000))] }));
    expect(d.write).toBe('insert');
    expect(d.values).toEqual(new Map([['a', 'p'], ['x', 'v']]));
    expect(d.meta?.hlc).toBe(h(2_000));
    expect(d.clocks).toEqual([
      { field: '*', hlc: h(2_000), base: null },
      { field: 'a', hlc: h(1_000), base: null },
      { field: 'x', hlc: h(2_000), base: h(1_000) },
    ]);
    expect({ remove: d.remove, reintegrated: d.reintegrated }).toEqual({ remove: ['a', 'x'], reintegrated: 2 });
  });

  it('incomplète ou parent manquant : attente (rien écrit, rien retiré)', () => {
    for (const given of [absent({ fields: [f('x', 'v', h(2_000))] }), absent({ fields: [f('a', 'p', h(1_000)), f('x', 'v', h(2_000))], missingParents: new Set(['a']) })]) {
      expect(decideReintegration(given)).toMatchObject({ write: 'none', remove: [], reintegrated: 0, superseded: 0 });
    }
  });

  it('trace de purge : les valeurs au hlc inférieur ou égal sont retirées, les plus récentes attendent ; jamais d’insertion', () => {
    const d = decideReintegration(absent({ tombstone: h(1_500), fields: [f('a', 'p', h(1_500)), f('x', 'v', h(2_000))] }));
    expect(d).toMatchObject({ write: 'none', remove: ['a'], superseded: 1, reintegrated: 0 });
  });
});

describe('keptFieldsOf : champs gardés devenus connus et valides', () => {
  const x: SyncColumn = { name: 'x', type: 'text', nullable: true, max: 10, conflictVisible: false };
  const task = syncTable('task') as SyncTable;
  const extended: SyncTable = { ...task, columns: [...task.columns, x] };
  const column = (name: string) => (name === 'x' ? x : extended.columns.find((c) => c.name === name));
  const stored = (field: string, value: string | null, hlc: string = h(1), base: string | null = null) => ({ field, value, hlc, base_hlc: base });
  it('garde la colonne devenue connue et de type valide ; écarte inconnue, technique, locale, clé, valeur invalide ou illisible, hlc invalide', () => {
    const kept = keptFieldsOf(extended, column, [
      stored('x', '"ok"'),
      stored('y', '"inconnue"'),
      stored('hlc', '"t"'),
      stored('discarded', '1'),
      stored('id', '"i"'),
      stored('status', '"peut-être"'),
      stored('title', 'pas du json'),
      stored('note', '"n"', 'pas un hlc'),
      stored('icon', '"i"', h(1), 'pas un hlc'),
      stored('title', '"Titre"', h(2), h(1)),
    ]);
    expect(kept).toEqual([f('x', 'ok', h(1), null, false), f('title', 'Titre', h(2), h(1))]);
  });
});

describe('parseReintegrationFailure (exigence d’Ali)', () => {
  it('lecture stricte : nombre positif, noms simples, date ; sinon null', () => {
    const ok = { fields: 2, tables: ['task'], at: '2026-10-05T09:00:00.000Z', errors: ['DbError'] };
    expect(parseReintegrationFailure(JSON.stringify(ok))).toEqual(ok);
    expect(parseReintegrationFailure(null)).toBeNull();
    for (const bad of ['pas du json', 'null', '[]', JSON.stringify({ ...ok, fields: 0 }), JSON.stringify({ ...ok, fields: 1.5 }), JSON.stringify({ ...ok, tables: ['valeur reçue !'] }), JSON.stringify({ ...ok, errors: [42] }), JSON.stringify({ ...ok, at: 3 })]) {
      expect(parseReintegrationFailure(bad), bad).toBeNull();
    }
  });
});
