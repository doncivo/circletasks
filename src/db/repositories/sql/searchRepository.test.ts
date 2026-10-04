import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMatchExpression, searchTokens } from '../../../domain/search';
import { initialSearchFilters, toQueryFilters, type SearchFilters } from '../../../domain/searchFilters';
import { asEntityId, asLocalDate, type DeviceId, type SpaceFilter, type TaskId } from '../../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../seed/defaultSpaces';
import { sampleTask } from '../../seed/sampleData';
import { openTestDb, type TestDb } from './testSetup';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-0000000000a1');
const taskId = (n: number): TaskId => asEntityId<TaskId>(`a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const match = (text: string): string => buildMatchExpression(searchTokens(text));
const STAMP = ['2026-10-01T08:00:00.000Z', '2026-10-01T08:00:00.000Z', 'd', 'h'] as const;

describe('SearchRepository (SQL, RC-01)', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await openTestDb(DEVICE);
  });
  afterEach(() => db.close());

  const TODAY = asLocalDate('2026-10-02');
  const search = (text: string, space: SpaceFilter = 'all', limit = 101, filters: Partial<SearchFilters> = {}) =>
    db.data.repos.search.query({ match: match(text), ...toQueryFilters({ ...initialSearchFilters(space), ...filters }, TODAY), limit });

  it('trouve une tâche par titre ou par note, sans casse ni accents, et par préfixe du dernier mot (critère 3)', async () => {
    await db.data.repos.tasks.create(sampleTask({ id: taskId(1), title: 'Envoyer la facture', spaceId: SPACE_PRO_ID, date: asLocalDate('2026-09-23') }));
    await db.data.repos.tasks.create(sampleTask({ id: taskId(2), title: 'Appeler le fournisseur', note: 'contester la facture', spaceId: SPACE_PERSO_ID, someday: true, date: null }));
    for (const text of ['facture', 'FACTURE', 'factüre', 'fact', 'envoyer fact']) {
      const hits = await search(text);
      expect(hits.map((hit) => hit.id), text).toContain(taskId(1));
    }
    const byNote = await search('contester');
    expect(byNote).toHaveLength(1);
    expect(byNote[0]).toMatchObject({ kind: 'task', id: taskId(2), note: 'contester la facture', someday: true, spaceId: SPACE_PERSO_ID });
    // « facture » trouve les deux ; le titre pèse plus que la note.
    expect((await search('facture')).map((hit) => hit.id)).toEqual([taskId(1), taskId(2)]);
    expect(await search('inconnu')).toEqual([]);
  });

  it('exclut les éléments supprimés, les rend après restauration, et suit renommage et création sans redémarrage (critères 4 et 9)', async () => {
    await db.data.repos.tasks.create(sampleTask({ id: taskId(1), title: 'Facture électricité', spaceId: SPACE_PRO_ID }));
    expect(await search('facture')).toHaveLength(1);
    await db.data.repos.tasks.softDelete([taskId(1)]);
    expect(await search('facture')).toHaveLength(0);
    await db.data.repos.tasks.restore([taskId(1)]);
    expect(await search('facture')).toHaveLength(1);
    await db.data.repos.tasks.update(taskId(1), { title: 'Loyer' });
    expect(await search('facture')).toHaveLength(0);
    expect(await search('loyer')).toHaveLength(1);
    await db.data.repos.tasks.create(sampleTask({ id: taskId(2), title: 'Loyer garage' }));
    expect(await search('loyer')).toHaveLength(2);
  });

  it('filtre l’espace dans la requête', async () => {
    await db.data.repos.tasks.create(sampleTask({ id: taskId(1), title: 'Facture Pro', spaceId: SPACE_PRO_ID }));
    await db.data.repos.tasks.create(sampleTask({ id: taskId(2), title: 'Facture Perso', spaceId: SPACE_PERSO_ID }));
    await db.driver.execute(`INSERT INTO event (id, space_id, title, start_date, end_date, repeat, created_at, updated_at, device_id, hlc) VALUES ('e1', ?, 'Échéance facture électricité', '2026-10-10', '2026-10-10', 'monthly', ?, ?, ?, ?)`, [SPACE_PERSO_ID, ...STAMP]);
    expect(await search('facture')).toHaveLength(3);
    expect((await search('facture', SPACE_PRO_ID)).map((hit) => hit.id)).toEqual([taskId(1)]);
    expect((await search('facture', SPACE_PERSO_ID)).map((hit) => hit.kind).sort()).toEqual(['event', 'task']);
  });

  it('renvoie les cinq types avec leurs données de sous-ligne', async () => {
    await db.driver.execute(`INSERT INTO event (id, space_id, title, start_date, start_time, end_date, repeat, created_at, updated_at, device_id, hlc) VALUES ('e1', ?, 'Point budget', '2026-10-10', '09:30', '2026-10-10', 'monthly', ?, ?, ?, ?)`, [SPACE_PRO_ID, ...STAMP]);
    await db.driver.execute(`INSERT INTO routine (id, space_id, title, schedule_type, start_date, paused, created_at, updated_at, device_id, hlc) VALUES ('r1', ?, 'Budget du mois', 'daily', '2026-09-01', 1, ?, ?, ?, ?)`, [SPACE_PERSO_ID, ...STAMP]);
    await db.driver.execute(`INSERT INTO goal (id, space_id, week_start, title, status, created_at, updated_at, device_id, hlc) VALUES ('g1', ?, '2026-09-28', 'Boucler le budget', 'achieved', ?, ?, ?, ?)`, [SPACE_PRO_ID, ...STAMP]);
    await db.driver.execute(`INSERT INTO checklist (id, space_id, title, date, created_at, updated_at, device_id, hlc) VALUES ('c1', ?, 'Réunions', '2026-10-12', ?, ?, ?, ?)`, [SPACE_PRO_ID, ...STAMP]);
    await db.driver.execute(`INSERT INTO checklist_item (id, checklist_id, text, checked, sort_order, created_at, updated_at, device_id, hlc) VALUES ('i1', 'c1', 'Préparer le budget', 1, 1, ?, ?, ?, ?)`, [...STAMP]);
    await db.driver.execute(`INSERT INTO checklist_item (id, checklist_id, text, sort_order, created_at, updated_at, device_id, hlc) VALUES ('i2', 'c1', 'Inviter l’équipe', 2, ?, ?, ?, ?)`, [...STAMP]);
    const hits = await search('budget');
    const byKind = Object.fromEntries(hits.map((hit) => [hit.kind, hit]));
    expect(Object.keys(byKind).sort()).toEqual(['checklist', 'event', 'goal', 'routine']);
    expect(byKind['event']).toMatchObject({ date: '2026-10-10', time: '09:30', repeat: 'monthly', status: null });
    expect(byKind['routine']).toMatchObject({ status: 'paused', date: null });
    expect(byKind['goal']).toMatchObject({ status: 'achieved', date: '2026-09-28' });
    expect(byKind['checklist']).toMatchObject({ title: 'Réunions', date: '2026-10-12', itemsChecked: 1 });
    expect(byKind['checklist']?.items).toEqual(expect.arrayContaining(['Préparer le budget', 'Inviter l’équipe']));
  });

  it('limite le nombre de lignes rendues', async () => {
    await db.data.repos.tasks.createMany(Array.from({ length: 12 }, (_, i) => sampleTask({ id: taskId(i + 1), title: `Facture ${String(i)}` })));
    expect(await search('facture', 'all', 5)).toHaveLength(5);
  });

  it('rebuild reconstruit un index vidé, identique à celui des déclencheurs ; isStale le détecte', async () => {
    await db.data.repos.tasks.create(sampleTask({ id: taskId(1), title: 'Facture', note: 'urgent' }));
    await db.driver.execute(`INSERT INTO checklist (id, space_id, title, created_at, updated_at, device_id, hlc) VALUES ('c1', ?, 'Valise', ?, ?, ?, ?)`, [SPACE_PERSO_ID, ...STAMP]);
    await db.driver.execute(`INSERT INTO checklist_item (id, checklist_id, text, created_at, updated_at, device_id, hlc) VALUES ('i1', 'c1', 'Brosse', ?, ?, ?, ?)`, [...STAMP]);
    const dump = () => db.driver.select('SELECT type, ref_id, title, body FROM search_index ORDER BY type, ref_id');
    const before = await dump();
    expect(before).toHaveLength(2);
    expect(await db.data.repos.search.isStale()).toBe(false);

    await db.driver.execute('DELETE FROM search_index');
    await db.driver.execute('DELETE FROM search_index_doc');
    expect(await search('facture')).toEqual([]);
    expect(await db.data.repos.search.isStale()).toBe(true);

    await db.data.transaction((repos) => repos.search.rebuild());
    expect(await dump()).toEqual(before);
    expect(await db.data.repos.search.isStale()).toBe(false);
    expect(await search('brosse')).toHaveLength(1);
    // Rejouable.
    await db.data.transaction((repos) => repos.search.rebuild());
    expect(await dump()).toEqual(before);
    // Les triggers continuent de fonctionner après une reconstruction.
    await db.data.repos.tasks.update(taskId(1), { title: 'Loyer' });
    expect(await search('loyer')).toHaveLength(1);
    expect(await db.driver.select('SELECT * FROM search_index_doc')).toHaveLength(2);
  });
});
