import type { Migration } from '../migrator';
import { migration0001CoreTables } from './0001_core_tables';
import { migration0002TaskDoneAtIndex } from './0002_task_done_at_index';
import { migration0003TaskSeriesTemplate } from './0003_task_series_template';
import { migration0004TaskDiscarded } from './0004_task_discarded';
import { migration0005ExternalCalendar } from './0005_external_calendar';
import { migration0006RoutinePause } from './0006_routine_pause';

/**
 * Registre ordonné des migrations de l'app. Ajouter chaque nouveau fichier
 * `NNNN_titre.ts` ici, à la fin, sans jamais modifier une entrée publiée.
 */
export const migrations: readonly Migration[] = [migration0001CoreTables, migration0002TaskDoneAtIndex, migration0003TaskSeriesTemplate, migration0004TaskDiscarded, migration0005ExternalCalendar, migration0006RoutinePause];
