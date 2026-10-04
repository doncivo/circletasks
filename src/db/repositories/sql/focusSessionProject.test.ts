import { describe, expect, it } from 'vitest';
import { daySpan } from '../../../domain/focusTotals';
import { asEntityId, type DeviceId, type FocusSessionId, type IsoDateTime, type LocalDate, type ProjectId, type TaskId } from '../../../domain/types';
import { SPACE_PRO_ID } from '../../seed/defaultSpaces';
import { openTestDb } from './testSetup';

describe('Projet figé au lancement (revue F-01 à F-04)', () => {
  it('le total par projet survit au déplacement puis à la suppression définitive de la tâche', async () => {
    const db = await openTestDb(asEntityId<DeviceId>('30000000-0000-4000-8000-000000000f09'));
    const project = asEntityId<ProjectId>('10000000-0000-4000-8000-0000000000c1');
    const task = asEntityId<TaskId>('20000000-0000-4000-8000-0000000000c1');
    await db.driver.execute("INSERT INTO project (id, space_id, name, color, sort_order, created_at, updated_at, device_id, hlc) VALUES (?, ?, 'M', '#2f6b7a', 1, 'z', 'z', 'd', 'h')", [project, SPACE_PRO_ID]);
    await db.driver.execute("INSERT INTO task (id, space_id, project_id, title, date, status, sort_order, created_at, updated_at, device_id, hlc) VALUES (?, ?, ?, 'T', '2026-10-04', 'todo', 1, 'z', 'z', 'd', 'h')", [task, SPACE_PRO_ID, project]);
    const id = asEntityId<FocusSessionId>('40000000-0000-4000-8000-0000000000c1');
    const start = new Date(2026, 9, 4, 9, 0).toISOString() as IsoDateTime;
    await db.data.repos.focusSessions.create({ id, taskId: task, spaceId: SPACE_PRO_ID, projectId: project, plannedMin: 25, startedAt: start });
    await db.data.repos.focusSessions.update(id, { endedAt: new Date(Date.parse(start) + 25 * 60_000).toISOString() as IsoDateTime });
    const query = { span: daySpan('2026-10-04' as LocalDate), filter: { space: SPACE_PRO_ID, project } };
    await db.driver.execute('UPDATE task SET project_id = NULL WHERE id = ?', [task]);
    expect(await db.data.repos.focusSessions.totals(query)).toEqual({ seconds: 1500, sessions: 1 });
    await db.driver.execute('DELETE FROM task WHERE id = ?', [task]);
    expect(await db.data.repos.focusSessions.totals(query)).toEqual({ seconds: 1500, sessions: 1 });
    expect((await db.data.repos.focusSessions.getById(id))?.projectId).toBe(project);
    await db.close();
  });
});
