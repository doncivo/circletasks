import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMatchExpression, searchTokens, validateSearchQuery } from '../../../domain/search';
import { initialSearchFilters, toQueryFilters } from '../../../domain/searchFilters';
import { asEntityId, asLocalDate, type DeviceId, type TaskId } from '../../../domain/types';
import { SPACE_PERSO_ID } from '../../seed/defaultSpaces';
import { sampleTask } from '../../seed/sampleData';
import { openTestDb, type TestDb } from './testSetup';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-0000000000b1');
const taskId = (n: number): TaskId => asEntityId<TaskId>(`b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const STAMP = ['2026-10-01T08:00:00.000Z', '2026-10-01T08:00:00.000Z', 'd', 'h'] as const;

describe('SearchRepository, cas limites (RC-01 QA)', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await openTestDb(DEVICE);
  });
  afterEach(() => db.close());

  const find = (text: string) => {
    const v = validateSearchQuery(text);
    if (!v.ok) return Promise.resolve([]);
    return db.data.repos.search.query({
      match: buildMatchExpression(v.value.tokens), ...toQueryFilters(initialSearchFilters('all'), asLocalDate('2026-10-02')), limit: 101,
    });
  };

  it('RC-01 accents et casse : « reunion » trouve « Réunion », « ete » trouve « ÉTÉ », et inversement', async () => {
    await db.data.repos.tasks.create(sampleTask({ id: taskId(1), title: 'Réunion équipe' }));
    await db.data.repos.tasks.create(sampleTask({ id: taskId(2), title: 'Vacances ÉTÉ' }));
    expect((await find('reunion')).map((h) => h.id)).toEqual([taskId(1)]);
    expect((await find('RÉUNION')).map((h) => h.id)).toEqual([taskId(1)]);
    expect((await find('ete')).map((h) => h.id)).toEqual([taskId(2)]);
    expect((await find('été')).map((h) => h.id)).toEqual([taskId(2)]);
  });

  it('RC-01 apostrophes et tirets séparent les mots', async () => {
    await db.data.repos.tasks.create(sampleTask({ id: taskId(1), title: 'Rendez-vous chez l’opticien' }));
    await db.data.repos.tasks.create(sampleTask({ id: taskId(2), title: "Appeler l'avocat" }));
    expect(await find('rendez-vous')).toHaveLength(1);
    expect(await find('vous chez')).toHaveLength(1);
    expect(await find('l’opticien')).toHaveLength(1);
    expect(await find("l'avocat")).toHaveLength(1);
    expect(await find('avocat')).toHaveLength(1);
  });

  it('RC-01 caractères spéciaux FTS5 : aucune erreur, aucun opérateur interprété', async () => {
    await db.data.repos.tasks.create(sampleTask({ id: taskId(1), title: 'Facture near rouge' }));
    for (const q of ['"facture', 'fact*', '-facture', 'NEAR(a b)', '(facture)', 'facture OR', 'a AND b', 'col:facture', '^facture', '"""', "';--", '{x}']) {
      await expect(find(q), q).resolves.toBeDefined();
    }
    expect((await find('"facture"')).map((h) => h.id)).toEqual([taskId(1)]);
    expect((await find('-facture')).map((h) => h.id)).toEqual([taskId(1)]);
    expect((await find('near')).map((h) => h.id)).toEqual([taskId(1)]);
    expect(await find('facture AND zzz')).toEqual([]);
    expect(buildMatchExpression(searchTokens('NEAR(a b)'))).not.toContain('(');
  });

  it('RC-01 un mot présent dans la note d’une tâche et dans un item de checklist trouve les deux', async () => {
    await db.data.repos.tasks.create(sampleTask({ id: taskId(1), title: 'Voyage', note: 'penser au passeport' }));
    await db.driver.execute(`INSERT INTO checklist (id, space_id, title, created_at, updated_at, device_id, hlc) VALUES ('c1', ?, 'Valise', ?, ?, ?, ?)`, [SPACE_PERSO_ID, ...STAMP]);
    await db.driver.execute(`INSERT INTO checklist_item (id, checklist_id, text, created_at, updated_at, device_id, hlc) VALUES ('i1', 'c1', 'Passeport', ?, ?, ?, ?)`, [...STAMP]);
    const hits = await find('passeport');
    expect(hits.map((h) => h.kind).sort()).toEqual(['checklist', 'task']);
  });

  it('RC-01 une note modifiée est réindexée : l’ancien mot disparaît, le nouveau apparaît', async () => {
    await db.data.repos.tasks.create(sampleTask({ id: taskId(1), title: 'Dossier', note: 'alpha' }));
    expect(await find('alpha')).toHaveLength(1);
    await db.data.repos.tasks.update(taskId(1), { note: 'bravo' });
    expect(await find('alpha')).toHaveLength(0);
    expect(await find('bravo')).toHaveLength(1);
  });

  it('RC-01 index corrompu (lignes en trop ou en moins) : isStale puis rebuild', async () => {
    await db.data.repos.tasks.create(sampleTask({ id: taskId(1), title: 'Facture' }));
    await db.data.repos.tasks.create(sampleTask({ id: taskId(2), title: 'Loyer' }));
    await db.driver.execute(`DELETE FROM search_index WHERE title = 'Loyer'`);
    await db.driver.execute(`DELETE FROM search_index_doc WHERE rowid = (SELECT MAX(rowid) FROM search_index_doc)`);
    expect(await db.data.repos.search.isStale()).toBe(true);
    await db.data.transaction((r) => r.search.rebuild());
    expect(await db.data.repos.search.isStale()).toBe(false);
    expect(await find('loyer')).toHaveLength(1);
    expect(await find('facture')).toHaveLength(1);
  });
});
