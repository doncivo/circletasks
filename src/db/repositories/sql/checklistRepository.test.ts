import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NewChecklist, NewChecklistItem } from '../../../domain/model';
import { asEntityId, asLocalDate, type ChecklistId, type ChecklistItemId, type DeviceId } from '../../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../seed/defaultSpaces';
import { RepositoryError } from '../common';
import { openTestDb, type TestDb } from './testSetup';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-0000000000c1');

const listId = (n: number) => asEntityId<ChecklistId>(`c1000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const itemId = (n: number) => asEntityId<ChecklistItemId>(`c2000000-0000-4000-8000-${String(n).padStart(12, '0')}`);

const newList = (n: number, over: Partial<NewChecklist> = {}): NewChecklist => ({
  id: listId(n),
  spaceId: SPACE_PRO_ID,
  title: `Liste ${String(n)}`,
  icon: null,
  date: null,
  isTemplate: false,
  ...over,
});

const newItem = (n: number, checklist: number, over: Partial<NewChecklistItem> = {}): NewChecklistItem => ({
  id: itemId(n),
  checklistId: listId(checklist),
  text: `Item ${String(n)}`,
  checked: false,
  sortOrder: n,
  ...over,
});

describe('ChecklistRepository et ChecklistItemRepository (SQL)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
  });

  afterEach(async () => {
    await db.close();
  });

  it('crée une checklist avec icône, espace et horodatage ; l’écriture avance le hlc (C-01)', async () => {
    const created = await db.data.repos.checklists.create(newList(1, { title: 'Valise voyage', icon: { kind: 'lucide', name: 'briefcase' }, spaceId: SPACE_PERSO_ID }));
    expect(created).toMatchObject({ title: 'Valise voyage', icon: { kind: 'lucide', name: 'briefcase' }, spaceId: SPACE_PERSO_ID, date: null, isTemplate: false, deletedAt: null });
    db.clock.advance(5);
    const renamed = await db.data.repos.checklists.update(created.id, { title: 'Valise été', icon: null, isTemplate: true });
    expect(renamed).toMatchObject({ title: 'Valise été', icon: null, isTemplate: true });
    expect(renamed.hlc > created.hlc).toBe(true);
    expect(renamed.updatedAt > created.updatedAt).toBe(true);
  });

  it('listSummaries : filtre d’espace, progression, lignes supprimées exclues, items supprimés non comptés', async () => {
    const { checklists, checklistItems } = db.data.repos;
    await checklists.create(newList(1, { title: 'Courses', spaceId: SPACE_PERSO_ID }));
    await checklists.create(newList(2, { title: 'Dossier', spaceId: SPACE_PRO_ID }));
    await checklists.create(newList(3, { title: 'Supprimée' }));
    await checklistItems.add(newItem(1, 1, { checked: true }));
    await checklistItems.add(newItem(2, 1));
    await checklistItems.add(newItem(3, 1, { checked: true }));
    await checklistItems.softDelete([itemId(3)]);
    await checklists.softDelete(listId(3));

    const all = await checklists.listSummaries('all');
    expect(all.map((s) => [s.checklist.title, s.checked, s.total])).toEqual([
      ['Courses', 1, 2],
      ['Dossier', 0, 0],
    ]);
    expect((await checklists.listSummaries(SPACE_PRO_ID)).map((s) => s.checklist.title)).toEqual(['Dossier']);
  });

  it('suppression logique puis restauration, items conservés', async () => {
    const { checklists, checklistItems } = db.data.repos;
    await checklists.create(newList(1));
    await checklistItems.add(newItem(1, 1));
    const removed = await checklists.softDelete(listId(1));
    expect(removed.deletedAt).not.toBeNull();
    expect(await checklists.getById(listId(1))).toBeNull();
    expect((await checklists.getById(listId(1), { includeDeleted: true }))?.deletedAt).not.toBeNull();
    expect(await checklists.listSummaries('all')).toEqual([]);
    const back = await checklists.restore(listId(1));
    expect(back.deletedAt).toBeNull();
    expect((await checklists.listSummaries('all'))[0]).toMatchObject({ total: 1 });
  });

  it('une checklist absente lève not-found', async () => {
    await expect(db.data.repos.checklists.update(listId(9), { title: 'x' })).rejects.toBeInstanceOf(RepositoryError);
    await expect(db.data.repos.checklists.softDelete(listId(9))).rejects.toMatchObject({ code: 'not-found' });
    await expect(db.data.repos.checklistItems.setChecked(itemId(9), true)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('items : ajout en fin, ordre manuel, cocher à l’état voulu, renommer (C-01, C-02)', async () => {
    const { checklists, checklistItems } = db.data.repos;
    await checklists.create(newList(1));
    await checklistItems.add(newItem(1, 1, { sortOrder: 2 }));
    await checklistItems.add(newItem(2, 1, { sortOrder: 1 }));
    expect((await checklistItems.listForChecklist(listId(1))).map((i) => i.text)).toEqual(['Item 2', 'Item 1']);

    db.clock.advance(3);
    const checked = await checklistItems.setChecked(itemId(1), true);
    expect(checked.checked).toBe(true);
    expect((await checklistItems.setChecked(itemId(1), true)).checked).toBe(true); // état voulu : idempotent
    expect((await checklistItems.setChecked(itemId(1), false)).checked).toBe(false);
    const renamed = await checklistItems.rename(itemId(1), 'Passeport');
    expect(renamed.text).toBe('Passeport');
    expect(renamed.hlc > checked.hlc).toBe(true);
  });

  it('lots : décocher, supprimer, restaurer, réordonner (C-05) ; tout est horodaté item par item', async () => {
    const { checklists, checklistItems } = db.data.repos;
    await checklists.create(newList(1));
    for (const n of [1, 2, 3]) await checklistItems.add(newItem(n, 1, { checked: n !== 2 }));

    const unchecked = await checklistItems.setCheckedMany([itemId(1), itemId(3)], false);
    expect(unchecked.map((i) => i.checked)).toEqual([false, false]);
    expect(new Set(unchecked.map((i) => i.hlc)).size).toBe(2);

    const deleted = await checklistItems.softDelete([itemId(1), itemId(2)]);
    expect(deleted.every((i) => i.deletedAt !== null)).toBe(true);
    expect((await checklistItems.listForChecklist(listId(1))).map((i) => i.id)).toEqual([itemId(3)]);
    expect((await checklistItems.getByIds([itemId(1), itemId(9)])).map((i) => i.id)).toEqual([itemId(1)]);

    const restored = await checklistItems.restore([itemId(1), itemId(2)]);
    expect(restored.every((i) => i.deletedAt === null)).toBe(true);
    await checklistItems.setSortOrders([
      { id: itemId(3), sortOrder: 1 },
      { id: itemId(1), sortOrder: 2 },
      { id: itemId(2), sortOrder: 3 },
    ]);
    expect((await checklistItems.listForChecklist(listId(1))).map((i) => i.id)).toEqual([itemId(3), itemId(1), itemId(2)]);
  });

  it('setDate pose et retire le jour ; listSummariesForDay le retrouve (C-03)', async () => {
    const { checklists } = db.data.repos;
    await checklists.create(newList(1));
    await checklists.create(newList(2));
    expect((await checklists.setDate(listId(1), asLocalDate('2026-10-05'))).date).toBe('2026-10-05');
    expect((await checklists.listSummariesForDay(asLocalDate('2026-10-05'), 'all')).map((s) => s.checklist.id)).toEqual([listId(1)]);
    expect((await checklists.setDate(listId(1), null)).date).toBeNull();
    expect(await checklists.listSummariesForDay(asLocalDate('2026-10-05'), 'all')).toEqual([]);
  });

  describe('createWithItems (C-04)', () => {
    it('crée la checklist et ses 200 items en une transaction en moins de 300 ms', async () => {
      const items = Array.from({ length: 200 }, (_, i) => newItem(i + 1, 7, { text: `Élément ${String(i + 1)}` }));
      const started = performance.now();
      const result = await db.data.transaction((repos) => repos.checklists.createWithItems(newList(7, { title: 'Grande liste' }), items));
      const elapsed = performance.now() - started;
      expect(result.items).toHaveLength(200);
      expect(result.items[199]?.text).toBe('Élément 200');
      expect(new Set(result.items.map((i) => i.hlc)).size).toBe(200);
      expect(elapsed).toBeLessThan(300);
      expect((await db.data.repos.checklists.listSummaries('all'))[0]).toMatchObject({ total: 200, checked: 0 });
    });

    it('un échec en cours de route ne laisse aucune copie partielle', async () => {
      const items = [newItem(1, 8), newItem(2, 8), newItem(2, 8)]; // identifiant en double : la 3e insertion échoue
      await expect(db.data.transaction((repos) => repos.checklists.createWithItems(newList(8), items))).rejects.toThrow();
      expect(await db.data.repos.checklists.getById(listId(8), { includeDeleted: true })).toBeNull();
      expect(await db.data.repos.checklistItems.getByIds([itemId(1), itemId(2)])).toEqual([]);
    });
  });
});
