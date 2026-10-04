import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMatchExpression, searchTokens } from '../../../domain/search';
import { initialSearchFilters, toQueryFilters, type SearchFilters } from '../../../domain/searchFilters';
import { asEntityId, asLocalDate, type DeviceId, type ProjectId } from '../../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../seed/defaultSpaces';
import { openTestDb, type TestDb } from './testSetup';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-0000000000a3');
const STAMP = `'2026-10-01T08:00:00.000Z', '2026-10-01T08:00:00.000Z', 'd', 'h'`;
const TODAY = asLocalDate('2026-10-02');

/** Filtres de la recherche (RC-02) appliqués dans la requête : espace, projet, type, statut, période, combinaisons. */
describe('SearchRepository (SQL, RC-02) : filtres dans la requête', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await openTestDb(DEVICE);
    const run = (sql: string): Promise<unknown> => db.driver.execute(sql);
    await run(`INSERT INTO project (id, space_id, name, color, sort_order, created_at, updated_at, device_id, hlc) VALUES ('p1', '${SPACE_PRO_ID}', 'Mission client', '#2f6b7a', 1, ${STAMP})`);
    const task = (id: string, title: string, space: string, extra: { project?: string; status?: string; date?: string | null; someday?: number }): Promise<unknown> =>
      run(
        `INSERT INTO task (id, space_id, project_id, title, date, status, done_at, someday, created_at, updated_at, device_id, hlc) VALUES ('${id}', '${space}', ${extra.project ? `'${extra.project}'` : 'NULL'}, '${title}', ${extra.date === null ? 'NULL' : `'${extra.date ?? '2026-10-01'}'`}, '${extra.status ?? 'todo'}', ${extra.status === 'done' ? "'2026-09-10T09:00:00.000Z'" : 'NULL'}, ${extra.someday ?? 0}, ${STAMP})`,
      );
    await task('tA', 'Facture A', SPACE_PRO_ID, { project: 'p1' });
    await task('tB', 'Facture B', SPACE_PRO_ID, { status: 'done', date: '2026-09-10' });
    await task('tC', 'Facture C', SPACE_PERSO_ID, { date: null, someday: 1 });
    await run(`INSERT INTO checklist (id, space_id, title, date, created_at, updated_at, device_id, hlc) VALUES ('c1', '${SPACE_PRO_ID}', 'Facture liste', '2026-10-02', ${STAMP})`);
    await run(`INSERT INTO event (id, space_id, title, start_date, end_date, created_at, updated_at, device_id, hlc) VALUES ('e1', '${SPACE_PERSO_ID}', 'Facture événement', '2026-10-10', '2026-10-10', ${STAMP})`);
    await run(`INSERT INTO routine (id, space_id, title, schedule_type, start_date, created_at, updated_at, device_id, hlc) VALUES ('r1', '${SPACE_PERSO_ID}', 'Facture routine', 'daily', '2026-09-01', ${STAMP})`);
    await run(`INSERT INTO goal (id, space_id, week_start, title, status, created_at, updated_at, device_id, hlc) VALUES ('g1', '${SPACE_PRO_ID}', '2026-09-28', 'Facture objectif', 'open', ${STAMP})`);
    await run(`INSERT INTO goal (id, space_id, week_start, title, status, created_at, updated_at, device_id, hlc) VALUES ('g2', '${SPACE_PERSO_ID}', '2026-09-14', 'Facture objectif passé', 'achieved', ${STAMP})`);
  });
  afterEach(() => db.close());

  const ids = async (filters: Partial<SearchFilters>): Promise<string[]> => {
    const hits = await db.data.repos.search.query({
      match: buildMatchExpression(searchTokens('facture')),
      ...toQueryFilters({ ...initialSearchFilters('all'), ...filters }, TODAY),
      limit: 101,
    });
    return hits.map((hit) => hit.id).sort();
  };

  it('sans filtre : tous les éléments', async () => {
    expect(await ids({})).toEqual(['c1', 'e1', 'g1', 'g2', 'r1', 'tA', 'tB', 'tC']);
  });

  it('espace : ne garde que les éléments de l’espace, tous types (critère 1)', async () => {
    expect(await ids({ space: SPACE_PRO_ID })).toEqual(['c1', 'g1', 'tA', 'tB']);
    expect(await ids({ space: SPACE_PERSO_ID })).toEqual(['e1', 'g2', 'r1', 'tC']);
  });

  it('projet : seulement les tâches de ce projet (critère 2)', async () => {
    expect(await ids({ space: SPACE_PRO_ID, projectId: 'p1' as ProjectId })).toEqual(['tA']);
  });

  it('type : un seul type (critère 3)', async () => {
    expect(await ids({ kind: 'checklist' })).toEqual(['c1']);
    expect(await ids({ kind: 'routine' })).toEqual(['r1']);
    expect(await ids({ kind: 'event' })).toEqual(['e1']);
    expect(await ids({ kind: 'goal' })).toEqual(['g1', 'g2']);
    expect(await ids({ kind: 'task' })).toEqual(['tA', 'tB', 'tC']);
  });

  it('statut : tâches et objectifs seulement, les autres types sont masqués (critère 4)', async () => {
    expect(await ids({ status: 'todo' })).toEqual(['g1', 'tA', 'tC']);
    expect(await ids({ status: 'done' })).toEqual(['g2', 'tB']);
    expect(await ids({ status: 'done', kind: 'checklist' })).toEqual([]);
  });

  it('période : date de l’élément, sans date exclus (Un jour, routines), objectif par sa semaine (critère 5)', async () => {
    // Cette semaine : 28 sept. – 4 oct. 2026.
    expect(await ids({ period: { kind: 'week' } })).toEqual(['c1', 'g1', 'tA']);
    // Ce mois : octobre.
    expect(await ids({ period: { kind: 'month' } })).toEqual(['c1', 'e1', 'g1', 'tA']);
    // Dates choisies : le 10 sept. (tâche faite) et la semaine du 14 sept. (objectif).
    expect(await ids({ period: { kind: 'custom', from: asLocalDate('2026-09-10'), to: asLocalDate('2026-09-16') } })).toEqual(['g2', 'tB']);
    // Une seule date, bornes incluses.
    expect(await ids({ period: { kind: 'custom', from: asLocalDate('2026-10-10'), to: asLocalDate('2026-10-10') } })).toEqual(['e1']);
  });

  it('les filtres se combinent (critère 6)', async () => {
    expect(await ids({ space: SPACE_PRO_ID, status: 'todo', kind: 'task' })).toEqual(['tA']);
    expect(await ids({ space: SPACE_PRO_ID, period: { kind: 'last30' } })).toEqual(['c1', 'g1', 'tA', 'tB']);
    expect(await ids({ space: SPACE_PERSO_ID, status: 'todo', period: { kind: 'month' } })).toEqual([]);
  });
});
