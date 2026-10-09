import type { Migration } from '../migrator';
import { migration0001CoreTables } from './0001_core_tables';
import { migration0002TaskDoneAtIndex } from './0002_task_done_at_index';
import { migration0003TaskSeriesTemplate } from './0003_task_series_template';
import { migration0004TaskDiscarded } from './0004_task_discarded';
import { migration0005ExternalCalendar } from './0005_external_calendar';
import { migration0006RoutinePause } from './0006_routine_pause';
import { migration0007ProQuietHours } from './0007_pro_quiet_hours';
import { migration0008ChecklistIcon } from './0008_checklist_icon';
import { migration0009EventReminderOffsets } from './0009_event_reminder_offsets';
import { migration0010Holiday } from './0010_holiday';
import { migration0011SearchIndex } from './0011_search_index';
import { migration0012TaskExternalEvent } from './0012_task_external_event';
import { migration0013FocusSession } from './0013_focus_session';
import { migration0014FocusSessionProject } from './0014_focus_session_project';
import { migration0015SyncTables } from './0015_sync_tables';
import { migration0016SyncNaturalIds } from './0016_sync_natural_ids';
import { migration0017CalendarAccountUsername } from './0017_calendar_account_username';
import { migration0018AppleReminders } from './0018_apple_reminders';

/**
 * Registre ordonné des migrations de l'app. Ajouter chaque nouveau fichier
 * `NNNN_titre.ts` ici, à la fin, sans jamais modifier une entrée publiée.
 */
export const migrations: readonly Migration[] = [migration0001CoreTables, migration0002TaskDoneAtIndex, migration0003TaskSeriesTemplate, migration0004TaskDiscarded, migration0005ExternalCalendar, migration0006RoutinePause, migration0007ProQuietHours, migration0008ChecklistIcon, migration0009EventReminderOffsets, migration0010Holiday, migration0011SearchIndex, migration0012TaskExternalEvent, migration0013FocusSession, migration0014FocusSessionProject, migration0015SyncTables, migration0016SyncNaturalIds, migration0017CalendarAccountUsername, migration0018AppleReminders];
