import { describe, expect, it } from 'vitest';
import type { DeviceId, Hlc, IsoDateTime } from '../types';
import type { EpochCarryNotice, EpochCarryNoticeItem } from './epochCarryNotice';
import {
  CARRY_REPORT_TABLES,
  EMPTY_CARRY_REPORT_BODY,
  EPOCH_CARRY_REPORT_MAX_NAMED,
  addCarriedCount,
  addNamed,
  carryCause,
  carryReportBanner,
  carryReportKind,
  carryReportLabel,
  classifyCarriedRow,
  missingCarryReportTables,
  noticeAfterAcknowledge,
  noticeItemsNotReported,
  parentItemsOf,
  SEED_AUTHOR,
  shortRowId,
  type EpochCarryNamedItem,
  type EpochCarryReportBody,
} from './epochCarryReport';
import { SYNC_TABLES, syncColumn } from './syncTables';
import { SEED_DEVICE_ID } from '../../db/seed/defaultSpaces';

/** Y-TECH-05 (critères 1 à 5, 7, 8, 11, 15) : règles pures du compte rendu du report d'époque. */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as DeviceId;
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as DeviceId;
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as DeviceId;
const h = (ms: number, device: DeviceId): Hlc => `${String(ms).padStart(15, '0')}-0000-${device}` as Hlc;
const T0 = Date.parse('2026-10-05T08:00:00.000Z');

const named = (n: number, deletedMs: number | null, table = 'task'): EpochCarryNamedItem => ({
  table,
  rowId: `row-${String(n).padStart(5, '0')}`,
  label: `T${String(n)}`,
  by: C,
  deletedAt: deletedMs === null ? null : (new Date(deletedMs).toISOString() as IsoDateTime),
  deletedBy: deletedMs === null ? null : A,
});
const noticeItem = (n: number): EpochCarryNoticeItem => ({ table: 'task', rowId: `n-${String(n)}`, column: 'project_id', parentId: 'p', space: 'pro', label: `N${String(n)}`, hlc: h(T0 + n, B) });

describe('correspondance table → libellé et type (critère 5)', () => {
  it('chaque table publiée y figure, avec une colonne de libellé du catalogue ou aucune', () => {
    expect(missingCarryReportTables()).toEqual([]);
    expect(Object.keys(CARRY_REPORT_TABLES).sort()).toEqual(SYNC_TABLES.map((t) => t.name).sort());
    for (const t of SYNC_TABLES) {
      const column = CARRY_REPORT_TABLES[t.name].label;
      if (column !== null) expect(syncColumn(t.name, column), `${t.name}.${column}`).toBeDefined();
    }
  });

  it('libellé lu dans la colonne de la table ; table sans libellé ou valeur vide : repli (null) et identifiant abrégé', () => {
    expect(carryReportLabel('task', new Map([['title', 'Test Pc']]))).toBe('Test Pc');
    expect(carryReportLabel('checklist_item', new Map([['text', 'Lait']]))).toBe('Lait');
    expect(carryReportLabel('routine_log', new Map([['title', 'ignoré']]))).toBeNull();
    expect(carryReportLabel('task', new Map([['title', '   ']]))).toBeNull();
    expect(carryReportLabel('inconnue', new Map([['title', 'x']]))).toBeNull();
    expect(shortRowId('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe('0f8fad5b');
    expect(carryReportKind('checklist_item')).toBe('checklistItem');
    expect(carryReportKind('inconnue')).toBe('other');
  });
});

describe('classement rétablie / recréée (critères 2 à 4)', () => {
  const del = h(T0, A);
  const restore = h(T0 + 60_000, C);
  it('supprimée après (b) puis vivante : rétablie, avec la date et l’auteur de la suppression écartée et l’auteur du rétablissement', () => {
    expect(classifyCarriedRow('task', 'x', 'À jeter', { kind: 'deleted', hlc: del }, { kind: 'alive', hlc: restore })).toEqual({
      list: 'restored',
      item: { table: 'task', rowId: 'x', label: 'À jeter', by: C, deletedAt: '2026-10-05T08:00:00.000Z', deletedBy: A },
    });
  });
  it('trace purgée après (b) puis vivante : rétablie, date de la trace', () => {
    expect(classifyCarriedRow('routine_log', 'x', null, { kind: 'purged', hlc: del }, { kind: 'alive', hlc: restore })?.item).toEqual({ table: 'routine_log', rowId: 'x', label: null, by: C, deletedAt: '2026-10-05T08:00:00.000Z', deletedBy: A });
  });
  it('absente puis vivante : recréée, sans suppression', () => {
    expect(classifyCarriedRow('task', 'x', 'Test Pc', { kind: 'absent' }, { kind: 'alive', hlc: restore })).toEqual({ list: 'recreated', item: { table: 'task', rowId: 'x', label: 'Test Pc', by: C, deletedAt: null, deletedBy: null } });
  });
  it('vivante avant et après (suppression de l’ouvreur annulée par la restauration comprise) : aucune liste ; jamais une ligne restée supprimée', () => {
    expect(classifyCarriedRow('task', 'x', 'Annulée', { kind: 'alive', hlc: del }, { kind: 'alive', hlc: restore })).toBeNull();
    expect(classifyCarriedRow('task', 'x', 'y', { kind: 'deleted', hlc: del }, { kind: 'deleted', hlc: restore })).toBeNull();
    expect(classifyCarriedRow('task', 'x', 'y', { kind: 'absent' }, { kind: 'deleted', hlc: restore })).toBeNull();
    expect(classifyCarriedRow('task', 'x', 'y', { kind: 'absent' }, { kind: 'absent' })).toBeNull();
  });
});

describe('compteurs par auteur (critère 1)', () => {
  it('les lignes de l’amorce (identiques partout) ne sont jamais comptées', () => {
    expect(SEED_AUTHOR).toBe(SEED_DEVICE_ID);
    expect(addCarriedCount([], { fields: [h(1, SEED_AUTHOR), h(2, SEED_AUTHOR)] })).toEqual([]);
    expect(addCarriedCount([], { fields: [h(1, SEED_AUTHOR), h(2, B)] })).toEqual([{ device: B, fields: 1, rows: 1, tombs: 0, late: 0 }]);
    // Revue S8 : une trace de l'amorce est exclue comme ses champs.
    expect(addCarriedCount([], { fields: [], tomb: h(3, SEED_AUTHOR) })).toEqual([]);
    expect(addCarriedCount([], { fields: [h(4, SEED_AUTHOR)], late: true })).toEqual([]);
  });

  it('champs et lignes distinctes par auteur, traces à part, écritures tardives à part', () => {
    let authors = addCarriedCount([], { fields: [h(1, C), h(2, C), h(3, C), h(4, B), h(5, B)] });
    authors = addCarriedCount(authors, { fields: [h(6, C)] });
    authors = addCarriedCount(authors, { fields: [], tomb: h(7, B) });
    authors = addCarriedCount(authors, { fields: [h(8, B), h(9, B)], late: true });
    expect(authors).toEqual([
      { device: C, fields: 4, rows: 2, tombs: 0, late: 0 },
      { device: B, fields: 2, rows: 1, tombs: 1, late: 1 },
    ]);
  });
});

describe('bandeau (critères 7, 8, 16, 19)', () => {
  const counts = addCarriedCount([], { fields: [h(1, C)] });
  const withNamed: EpochCarryReportBody = { ...EMPTY_CARRY_REPORT_BODY, authors: counts, restored: [named(1, T0)] };
  it('remplacement avec écriture reportée et ligne nommée : levé', () => {
    expect(carryReportBanner('replace', withNamed)).toBe(true);
    expect(carryReportBanner('replace', { ...EMPTY_CARRY_REPORT_BODY, authors: counts, overflow: 1 })).toBe(true);
  });
  it('fusion, report sans écriture, ou aucune ligne nommée : jamais levé', () => {
    expect(carryReportBanner('merge', withNamed)).toBe(false);
    expect(carryReportBanner('replace', EMPTY_CARRY_REPORT_BODY)).toBe(false);
    expect(carryReportBanner('replace', { ...EMPTY_CARRY_REPORT_BODY, authors: counts })).toBe(false);
  });
});

describe('borne de 500 lignes nommées et ordre déterministe (critère 11)', () => {
  const many = (n: number): EpochCarryNamedItem[] => Array.from({ length: n }, (_, i) => named(i, T0 + (i % 37) * 1_000));
  it.each([501, 5_000])('%i rétablies : les 500 premières (suppression la plus récente d’abord, puis table, puis identifiant), le reste compté', (n) => {
    const items = many(n);
    const body = addNamed(EMPTY_CARRY_REPORT_BODY, { restored: items });
    expect(body.restored).toHaveLength(EPOCH_CARRY_REPORT_MAX_NAMED);
    expect(body.overflow).toBe(n - EPOCH_CARRY_REPORT_MAX_NAMED);
    expect(body.overflowBy).toEqual({ restored: n - EPOCH_CARRY_REPORT_MAX_NAMED, recreated: 0, parentReplaced: 0 });
    const expected = [...items].sort((a, b) => ((b.deletedAt ?? '') < (a.deletedAt ?? '') ? -1 : (b.deletedAt ?? '') > (a.deletedAt ?? '') ? 1 : a.rowId < b.rowId ? -1 : 1)).slice(0, 500);
    expect(body.restored.map((i) => i.rowId)).toEqual(expected.map((i) => i.rowId));
  });

  it('page par page : même résultat que d’un coup, sans doublon ; rétablies avant recréées avant parent remplacé', () => {
    const items = many(1_200);
    const recreated = Array.from({ length: 10 }, (_, i) => named(10_000 + i, null));
    const parent = parentItemsOf([noticeItem(1)], [noticeItem(2)]);
    const once = addNamed(EMPTY_CARRY_REPORT_BODY, { restored: items, recreated, parentReplaced: parent });
    let paged = EMPTY_CARRY_REPORT_BODY;
    for (let i = 0; i < items.length; i += 500) paged = addNamed(paged, { restored: items.slice(i, i + 500) });
    paged = addNamed(paged, { recreated, parentReplaced: parent });
    // Une ligne déjà nommée ne l'est jamais deux fois (une page de `reapply` n'est jamais rejouée : elle est atomique avec le retrait de ses reports).
    paged = addNamed(paged, { restored: paged.restored.slice(0, 10) });
    expect(paged).toEqual(once);
    expect(once.overflow).toBe(1_200 + 10 + 2 - 500);
    const small = addNamed(EMPTY_CARRY_REPORT_BODY, { parentReplaced: parent, recreated: recreated.slice(0, 1), restored: items.slice(0, 1) }, 2);
    expect([small.restored.length, small.recreated.length, small.parentReplaced.length, small.overflow]).toEqual([1, 1, 0, 2]);
    expect(small.overflowBy).toEqual({ restored: 0, recreated: 0, parentReplaced: 2 });
  });

  it('une ligne de nouveau supprimée plus loin dans le report sort des listes', () => {
    const body = addNamed(EMPTY_CARRY_REPORT_BODY, { restored: [named(1, T0)], recreated: [named(2, null)] });
    expect(addNamed(body, { dropped: [{ table: 'task', rowId: 'row-00001' }, { table: 'task', rowId: 'row-00002' }] })).toEqual(EMPTY_CARRY_REPORT_BODY);
  });
});

describe('notice de Y-FIX-04 (critère 9) et cause', () => {
  const notice: EpochCarryNotice = { v: 1, epoch: 'e', at: 'x', reattached: [noticeItem(1), noticeItem(2)], held: [noticeItem(3)], overflow: 0 };
  it('items d’une notice antérieure qu’aucun compte rendu ne nomme : copiés une fois, avec leur cause', () => {
    const copied = noticeItemsNotReported(notice, [{ parentReplaced: parentItemsOf([noticeItem(1)], []) }]);
    expect(copied).toEqual([
      { ...noticeItem(2), kind: 'reattached', cause: 'parent-replaced' },
      { ...noticeItem(3), kind: 'held', cause: 'parent-replaced' },
    ]);
    expect(noticeItemsNotReported(null, [])).toEqual([]);
  });
  it('« J’ai vu » : la notice garde ses lignes rattachées tant qu’un compte rendu non acquitté en nomme ; les mises de côté restent', () => {
    expect(noticeAfterAcknowledge(notice, [{ parentReplaced: parentItemsOf([noticeItem(1)], []) }])).toBe(notice);
    expect(noticeAfterAcknowledge(notice, [])).toEqual({ ...notice, reattached: [], overflow: 0 });
    expect(noticeAfterAcknowledge({ ...notice, held: [] }, [])).toBeNull();
  });
  it('cause : fusion ou réinitialisation, époques concurrentes (même numéro), restauration', () => {
    expect(carryCause({ mode: 'merge', reset: false, fromN: 1, targetN: 2 })).toBe('reset');
    expect(carryCause({ mode: 'replace', reset: true, fromN: 1, targetN: 2 })).toBe('reset');
    expect(carryCause({ mode: 'replace', reset: false, fromN: 2, targetN: 2 })).toBe('concurrent');
    expect(carryCause({ mode: 'replace', reset: false, fromN: 1, targetN: 2 })).toBe('restore');
    expect(carryCause({ mode: 'replace', reset: false, fromN: null, targetN: 2 })).toBe('restore');
  });
});
