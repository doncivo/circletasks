// Y-TECH-05, critères 17 à 22 : écran de détail du compte rendu du changement d'époque (contenu, listes vides, 500 lignes en pages de 50,
// appareils nommés, ordre de focus, textes). Rendu direct de la feuille avec des comptes rendus construits à la main.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { EpochCarryNamedItem, EpochCarryReport } from '../../domain/sync/epochCarryReport';
import type { DeviceId, Hlc, IsoDateTime } from '../../domain/types';
import type { SyncDeviceStatus } from '../../platform/sync/types';
import { CARRY_REPORT_PAGE, CarryReportSheet } from './CarryReportSheet';

const ME = '11111111-1111-4111-8111-111111111111' as DeviceId;
const PC = '22222222-2222-4222-8222-222222222222' as DeviceId;
const OLD = '33333333-3333-4333-8333-333333333333' as DeviceId;
const GONE = '44444444-4444-4444-8444-444444444444' as DeviceId;
/** Instant construit en heure locale : l'affichage (heure locale, 24 h) ne dépend pas du fuseau de la machine. */
const local = (y: number, mo: number, d: number, h: number, mi: number): IsoDateTime => new Date(y, mo - 1, d, h, mi).toISOString() as IsoDateTime;

const device = (deviceId: DeviceId, self: boolean, status: SyncDeviceStatus['status'] = 'active', platform: SyncDeviceStatus['platform'] = 'windows'): SyncDeviceStatus => ({ deviceId, platform, self, lastReadAt: null, status });
const DEVICES: readonly SyncDeviceStatus[] = [device(ME, true, 'active', 'ios'), device(PC, false), device(OLD, false, 'forgotten')];

const EMPTY = { authors: [], restored: [], recreated: [], parentReplaced: [], overflow: 0, overflowBy: { restored: 0, recreated: 0, parentReplaced: 0 } } as const;

function report(patch: Partial<EpochCarryReport> = {}): EpochCarryReport {
  return {
    id: 1,
    epoch: '2-x',
    cause: 'restore',
    reporter: ME,
    opener: PC,
    mode: 'replace',
    createdAt: local(2026, 10, 18, 14, 5),
    acknowledgedAt: null,
    banner: true,
    damaged: false,
    ...EMPTY,
    ...patch,
  };
}

const restoredItem = (n: number, patch: Partial<EpochCarryNamedItem> = {}): EpochCarryNamedItem => ({ table: 'task', rowId: `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`, label: `Tâche ${String(n)}`, by: PC, deletedAt: local(2026, 10, 17, 9, 30), deletedBy: OLD, ...patch });

function open(r: EpochCarryReport, extra: { onSeen?: () => Promise<void>; seenFailed?: boolean } = {}) {
  return render(<CarryReportSheet report={r} devices={DEVICES} onClose={() => undefined} onSeen={extra.onSeen ?? (() => Promise.resolve())} seenFailed={extra.seenFailed ?? false} />);
}

afterEach(cleanup);

describe('résumé (critère 17 a à c)', () => {
  it('époque en 24 h, cause, appareils nommés, écritures reportées par auteur', () => {
    open(
      report({
        authors: [
          { device: ME, fields: 2, rows: 1, tombs: 0, late: 0 },
          { device: PC, fields: 5, rows: 2, tombs: 1, late: 1 },
          { device: OLD, fields: 1, rows: 1, tombs: 0, late: 0 },
          { device: GONE, fields: 1, rows: 1, tombs: 0, late: 0 },
        ],
        restored: [restoredItem(1)],
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Compte rendu du changement d’époque' });
    expect(within(dialog).getByText('Époque du 18 oct. 2026 à 14:05')).toBeTruthy();
    expect(within(dialog).getByText('Restauration « Appliquer partout »')).toBeTruthy();
    expect(within(dialog).getByText('Ouverte par : PC 2222')).toBeTruthy();
    expect(within(dialog).getByText('Reporté par : Cet appareil')).toBeTruthy();
    expect(within(dialog).getByText('Éléments rétablis : 1')).toBeTruthy();
    const writes = within(dialog).getByRole('list', { name: 'Écritures reportées : 4' });
    expect(within(writes).getByText('Écritures reportées par Cet appareil')).toBeTruthy();
    expect(within(writes).getByText('Écritures reportées par PC 2222')).toBeTruthy();
    expect(within(writes).getByText('Champs : 5 · Lignes : 2 · Traces : 1 · Tardives : 1')).toBeTruthy();
    expect(within(writes).getByText('Écritures reportées par PC 3333 (oublié)')).toBeTruthy();
    expect(within(writes).getByText('Écritures reportées par Appareil 44444444')).toBeTruthy();
  });

  it('les trois causes', () => {
    for (const [cause, text] of [
      ['concurrent', 'Époques concurrentes'],
      ['reset', 'Réinitialisation de la synchro'],
    ] as const) {
      open(report({ cause }));
      expect(screen.getByText(text)).toBeTruthy();
      cleanup();
    }
  });
});

describe('listes nommées (critère 17 d à f)', () => {
  it('rétablis : type, libellé, rétabli par, supprimé le … par … ; recréés ; rattachés et mis de côté', () => {
    open(
      report({
        authors: [{ device: PC, fields: 3, rows: 3, tombs: 0, late: 0 }],
        restored: [restoredItem(1, { label: 'À jeter' }), restoredItem(2, { table: 'project', label: 'Projet X' })],
        recreated: [{ table: 'task', rowId: 'abcdef12-0000-4000-8000-000000000000', label: 'Test Pc', by: PC, deletedAt: null, deletedBy: null }],
        parentReplaced: [
          { table: 'task', rowId: 'r1', column: 'project_id', parentId: 'P', space: 'pro', label: 'Rattachée', hlc: 'h' as Hlc, kind: 'reattached', cause: 'parent-replaced' },
          { table: 'routine_log', rowId: '99999999-0000', column: 'routine_id', parentId: 'R', space: null, label: null, hlc: 'h' as Hlc, kind: 'held', cause: 'parent-replaced' },
        ],
      }),
    );
    const restored = screen.getByRole('list', { name: 'Rétablis alors que vous les aviez supprimés : 2' });
    const [first, second] = within(restored).getAllByRole('listitem');
    expect(within(first as HTMLElement).getByText('Tâche')).toBeTruthy();
    expect(within(first as HTMLElement).getByText('À jeter')).toBeTruthy();
    expect(within(first as HTMLElement).getByText('Rétabli par : PC 2222')).toBeTruthy();
    expect(within(first as HTMLElement).getByText('Supprimé le 17 oct. 2026 à 09:30 par PC 3333 (oublié)')).toBeTruthy();
    expect(within(second as HTMLElement).getByText('Projet')).toBeTruthy();
    const recreated = screen.getByRole('list', { name: 'Recréés : 1' });
    expect(within(recreated).getByText('Test Pc')).toBeTruthy();
    expect(within(recreated).queryByText(/Supprimé le/)).toBeNull();
    expect(within(screen.getByRole('list', { name: 'Rattachés à « Sans projet » : 1' })).getByText('Rattachée')).toBeTruthy();
    const held = screen.getByRole('list', { name: 'Mis de côté (parent remplacé) : 1' });
    expect(within(held).getByText('Jour de routine')).toBeTruthy();
    // Libellé absent : repli « (sans titre) » et identifiant abrégé (8 caractères).
    expect(within(held).getByText('(sans titre) 99999999')).toBeTruthy();
    // ADR §29 point 5 : seules les lignes rétablies sont comptées (2), les recréées et rattachées ont leurs propres compteurs.
    expect(screen.getByText('Éléments rétablis : 2')).toBeTruthy();
    expect(screen.queryByText(/^Recréés : \d/)).toBeNull();
  });

  it('aucun élément supprimé rétabli : la phrase est en tête, avant le résumé (critère 19)', () => {
    open(report({ authors: [{ device: PC, fields: 3, rows: 1, tombs: 0, late: 0 }], recreated: [{ table: 'task', rowId: 'r', label: 'Test Pc', by: PC, deletedAt: null, deletedBy: null }] }));
    const dialog = screen.getByRole('dialog');
    const sentence = within(dialog).getByText('Aucun élément supprimé n’a été rétabli');
    const summary = within(dialog).getByText(/^Époque du /);
    expect(sentence.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(dialog).queryByRole('list', { name: /^Rétablis alors/ })).toBeNull();
  });

  it('aucun rétabli mais d’autres lignes nommées : jamais « Éléments rétablis : 1 » avec la phrase « aucun », compteurs séparés', () => {
    open(
      report({
        authors: [{ device: PC, fields: 3, rows: 3, tombs: 0, late: 0 }],
        recreated: [{ table: 'task', rowId: 'r', label: 'Test Pc', by: PC, deletedAt: null, deletedBy: null }],
        parentReplaced: [
          { table: 'task', rowId: 'r1', column: 'project_id', parentId: 'P', space: 'pro', label: 'Rattachée', hlc: 'h' as Hlc, kind: 'reattached', cause: 'parent-replaced' },
          { table: 'task', rowId: 'r2', column: 'project_id', parentId: 'P', space: 'pro', label: 'Mise de côté', hlc: 'h' as Hlc, kind: 'held', cause: 'parent-replaced' },
        ],
        overflow: 4,
        overflowBy: { restored: 0, recreated: 1, parentReplaced: 3 },
      }),
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Aucun élément supprimé n’a été rétabli')).toBeTruthy();
    expect(within(dialog).queryByText(/^Éléments rétablis : [1-9]/)).toBeNull();
    expect(within(dialog).getByText('Recréés : 2')).toBeTruthy();
    expect(within(dialog).getByText('Rattachés ou mis de côté : 5')).toBeTruthy();
  });

  // Revue S5 : le débordement des lignes au parent remplacé n'est attribué ni aux seules « mises de côté » ni aux seules « rattachées » : un compte commun.
  it('débordement des lignes au parent remplacé : un seul « Autres éléments : n » commun aux deux listes, aucune liste n’annonce ce reste', () => {
    open(
      report({
        authors: [{ device: PC, fields: 3, rows: 3, tombs: 0, late: 0 }],
        parentReplaced: [
          { table: 'task', rowId: 'r1', column: 'project_id', parentId: 'P', space: 'pro', label: 'Rattachée', hlc: 'h' as Hlc, kind: 'reattached', cause: 'parent-replaced' },
          { table: 'task', rowId: 'r2', column: 'project_id', parentId: 'P', space: 'pro', label: 'Mise de côté', hlc: 'h' as Hlc, kind: 'held', cause: 'parent-replaced' },
        ],
        overflow: 3,
        overflowBy: { restored: 0, recreated: 0, parentReplaced: 3 },
      }),
    );
    expect(screen.getAllByText('Autres éléments : 3')).toHaveLength(1);
    expect(screen.getByRole('list', { name: 'Rattachés à « Sans projet » : 1' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Mis de côté (parent remplacé) : 1' })).toBeTruthy();
  });

  it('débordement des lignes au parent remplacé sans aucune ligne gardée : « Autres éléments : n » sous un titre commun', () => {
    open(report({ authors: [{ device: PC, fields: 3, rows: 3, tombs: 0, late: 0 }], overflow: 2, overflowBy: { restored: 0, recreated: 0, parentReplaced: 2 } }));
    expect(screen.getByRole('heading', { name: 'Rattachés ou mis de côté' })).toBeTruthy();
    expect(screen.getAllByText('Autres éléments : 2')).toHaveLength(1);
  });

  it('au moins un rétabli : « Éléments rétablis : n » et pas la phrase « aucun »', () => {
    open(report({ authors: [{ device: PC, fields: 3, rows: 1, tombs: 0, late: 0 }], restored: [restoredItem(1)], recreated: [{ table: 'task', rowId: 'r', label: 'Test Pc', by: PC, deletedAt: null, deletedBy: null }] }));
    expect(screen.getByText('Éléments rétablis : 1')).toBeTruthy();
    expect(screen.queryByText('Aucun élément supprimé n’a été rétabli')).toBeNull();
  });

  it('tout à zéro : « Aucune écriture à reporter », aucune liste', () => {
    open(report({ banner: false }));
    expect(screen.getByText('Aucune écriture à reporter')).toBeTruthy();
    expect(screen.getByText('Aucun élément supprimé n’a été rétabli')).toBeTruthy();
    expect(screen.queryAllByRole('list')).toEqual([]);
    expect(screen.getByText('Éléments rétablis : 0')).toBeTruthy();
  });

  it('compte rendu endommagé : phrase dédiée, le reste reste lisible', () => {
    open(report({ damaged: true, restored: [restoredItem(1)], authors: [{ device: PC, fields: 1, rows: 1, tombs: 0, late: 0 }] }));
    expect(screen.getByText('Une partie de ce compte rendu est illisible')).toBeTruthy();
    expect(screen.getByText('Tâche 1')).toBeTruthy();
  });
});

describe('500 lignes : pages de 50 (critère 22)', () => {
  const big = report({
    authors: [{ device: PC, fields: 500, rows: 500, tombs: 0, late: 0 }],
    restored: Array.from({ length: 500 }, (_, i) => restoredItem(i + 1)),
    overflow: 12,
    overflowBy: { restored: 12, recreated: 0, parentReplaced: 0 },
  });

  it('le premier rendu ne pose que la première page, le nombre exact est annoncé ; « Afficher 50 de plus » jusqu’à la fin, puis « Autres éléments : 12 »', () => {
    open(big);
    const list = (): HTMLElement => screen.getByRole('list', { name: 'Rétablis alors que vous les aviez supprimés : 512' });
    // Premier rendu : 50 lignes dans le DOM sur 500 gardées.
    expect(within(list()).getAllByRole('listitem')).toHaveLength(CARRY_REPORT_PAGE);
    expect(document.querySelectorAll('.ct-carry__item')).toHaveLength(CARRY_REPORT_PAGE + 1);
    expect(screen.queryByText(/^Autres éléments : \d+$/)).toBeNull();
    for (let page = 2; page <= 10; page += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Afficher 50 de plus' }));
      expect(within(list()).getAllByRole('listitem')).toHaveLength(page * CARRY_REPORT_PAGE);
    }
    expect(screen.queryByRole('button', { name: 'Afficher 50 de plus' })).toBeNull();
    expect(screen.getByText('Autres éléments : 12')).toBeTruthy();
    expect(screen.getByText('Éléments rétablis : 512')).toBeTruthy();
  });
});

describe('« J’ai vu » et ordre de focus (critères 18 et 20)', () => {
  it('« J’ai vu » est le dernier bouton, après « Fermer » et les pages ; il appelle onSeen une fois', () => {
    let calls = 0;
    open(report({ restored: Array.from({ length: 60 }, (_, i) => restoredItem(i + 1)), authors: [{ device: PC, fields: 60, rows: 60, tombs: 0, late: 0 }] }), {
      onSeen: () => {
        calls += 1;
        return Promise.resolve();
      },
    });
    const names = screen.getAllByRole('button').map((b) => b.textContent);
    expect(names).toEqual(['Fermer', 'Afficher 50 de plus', 'J’ai vu']);
    fireEvent.click(screen.getByRole('button', { name: 'J’ai vu' }));
    expect(calls).toBe(1);
  });

  it('compte rendu acquitté : « Vu le … », plus de bouton « J’ai vu » (reste lisible dans l’historique)', () => {
    open(report({ acknowledgedAt: local(2026, 10, 19, 8, 2), restored: [restoredItem(1)] }));
    expect(screen.getByText('Vu le 19 oct. 2026 à 08:02')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'J’ai vu' })).toBeNull();
  });

  it('« J’ai vu » en échec : message visible', () => {
    open(report(), { seenFailed: true });
    expect(screen.getByRole('alert').textContent).toBe('Le compte rendu n’a pas pu être marqué comme vu : réessayez');
  });
});
