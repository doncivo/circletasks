//! Définitions de référence des déclencheurs de l'app (index de recherche, migration 0011 ; capture de la synchro `sync_*`, migration 0015), telles
//! que SQLite les enregistre dans
//! `sqlite_master` après les migrations. Elles servent (1) à refuser une sauvegarde dont un déclencheur a un corps modifié et (2) à recréer les
//! déclencheurs après une restauration. `src/platform/backup/triggers.test.ts` vérifie qu'elles sont identiques à celles des migrations :
//! à régénérer avec ce test si la migration 0011 change (jamais, une migration publiée ne se modifie plus) ou si un déclencheur est ajouté.

/// (nom, table, SQL) de chaque déclencheur, triés par nom.
pub const REFERENCE_TRIGGERS: [(&str, &str, &str); 50] = [
    ("search_checklist_ad", "checklist", r##"CREATE TRIGGER search_checklist_ad AFTER DELETE ON checklist BEGIN DELETE FROM search_index WHERE rowid IN (SELECT id FROM search_index_doc WHERE type = 'checklist' AND ref_id = OLD.id);
   DELETE FROM search_index_doc WHERE type = 'checklist' AND ref_id = OLD.id; END"##),
    ("search_checklist_ai", "checklist", r##"CREATE TRIGGER search_checklist_ai AFTER INSERT ON checklist BEGIN DELETE FROM search_index WHERE rowid IN (SELECT id FROM search_index_doc WHERE type = 'checklist' AND ref_id = NEW.id);
   DELETE FROM search_index_doc WHERE type = 'checklist' AND ref_id = NEW.id;
   INSERT INTO search_index_doc (type, ref_id) SELECT 'checklist', c.id FROM checklist c WHERE c.id = NEW.id AND c.deleted_at IS NULL;
   INSERT INTO search_index (rowid, type, ref_id, title, body)
     SELECT d.id, 'checklist', c.id, c.title, (SELECT COALESCE(group_concat(text, char(10)), '') FROM checklist_item WHERE checklist_id = c.id AND deleted_at IS NULL)
     FROM checklist c JOIN search_index_doc d ON d.type = 'checklist' AND d.ref_id = c.id WHERE c.id = NEW.id AND c.deleted_at IS NULL; END"##),
    ("search_checklist_au", "checklist", r##"CREATE TRIGGER search_checklist_au AFTER UPDATE OF title, deleted_at ON checklist BEGIN DELETE FROM search_index WHERE rowid IN (SELECT id FROM search_index_doc WHERE type = 'checklist' AND ref_id = NEW.id);
   DELETE FROM search_index_doc WHERE type = 'checklist' AND ref_id = NEW.id;
   INSERT INTO search_index_doc (type, ref_id) SELECT 'checklist', c.id FROM checklist c WHERE c.id = NEW.id AND c.deleted_at IS NULL;
   INSERT INTO search_index (rowid, type, ref_id, title, body)
     SELECT d.id, 'checklist', c.id, c.title, (SELECT COALESCE(group_concat(text, char(10)), '') FROM checklist_item WHERE checklist_id = c.id AND deleted_at IS NULL)
     FROM checklist c JOIN search_index_doc d ON d.type = 'checklist' AND d.ref_id = c.id WHERE c.id = NEW.id AND c.deleted_at IS NULL; END"##),
    ("search_checklist_item_ad", "checklist_item", r##"CREATE TRIGGER search_checklist_item_ad AFTER DELETE ON checklist_item BEGIN DELETE FROM search_index WHERE rowid IN (SELECT id FROM search_index_doc WHERE type = 'checklist' AND ref_id = OLD.checklist_id);
   DELETE FROM search_index_doc WHERE type = 'checklist' AND ref_id = OLD.checklist_id;
   INSERT INTO search_index_doc (type, ref_id) SELECT 'checklist', c.id FROM checklist c WHERE c.id = OLD.checklist_id AND c.deleted_at IS NULL;
   INSERT INTO search_index (rowid, type, ref_id, title, body)
     SELECT d.id, 'checklist', c.id, c.title, (SELECT COALESCE(group_concat(text, char(10)), '') FROM checklist_item WHERE checklist_id = c.id AND deleted_at IS NULL)
     FROM checklist c JOIN search_index_doc d ON d.type = 'checklist' AND d.ref_id = c.id WHERE c.id = OLD.checklist_id AND c.deleted_at IS NULL; END"##),
    ("search_checklist_item_ai", "checklist_item", r##"CREATE TRIGGER search_checklist_item_ai AFTER INSERT ON checklist_item BEGIN DELETE FROM search_index WHERE rowid IN (SELECT id FROM search_index_doc WHERE type = 'checklist' AND ref_id = NEW.checklist_id);
   DELETE FROM search_index_doc WHERE type = 'checklist' AND ref_id = NEW.checklist_id;
   INSERT INTO search_index_doc (type, ref_id) SELECT 'checklist', c.id FROM checklist c WHERE c.id = NEW.checklist_id AND c.deleted_at IS NULL;
   INSERT INTO search_index (rowid, type, ref_id, title, body)
     SELECT d.id, 'checklist', c.id, c.title, (SELECT COALESCE(group_concat(text, char(10)), '') FROM checklist_item WHERE checklist_id = c.id AND deleted_at IS NULL)
     FROM checklist c JOIN search_index_doc d ON d.type = 'checklist' AND d.ref_id = c.id WHERE c.id = NEW.checklist_id AND c.deleted_at IS NULL; END"##),
    ("search_checklist_item_au", "checklist_item", r##"CREATE TRIGGER search_checklist_item_au AFTER UPDATE OF text, deleted_at, checklist_id ON checklist_item BEGIN DELETE FROM search_index WHERE rowid IN (SELECT id FROM search_index_doc WHERE type = 'checklist' AND ref_id = NEW.checklist_id);
   DELETE FROM search_index_doc WHERE type = 'checklist' AND ref_id = NEW.checklist_id;
   INSERT INTO search_index_doc (type, ref_id) SELECT 'checklist', c.id FROM checklist c WHERE c.id = NEW.checklist_id AND c.deleted_at IS NULL;
   INSERT INTO search_index (rowid, type, ref_id, title, body)
     SELECT d.id, 'checklist', c.id, c.title, (SELECT COALESCE(group_concat(text, char(10)), '') FROM checklist_item WHERE checklist_id = c.id AND deleted_at IS NULL)
     FROM checklist c JOIN search_index_doc d ON d.type = 'checklist' AND d.ref_id = c.id WHERE c.id = NEW.checklist_id AND c.deleted_at IS NULL; DELETE FROM search_index WHERE rowid IN (SELECT id FROM search_index_doc WHERE type = 'checklist' AND ref_id = OLD.checklist_id);
   DELETE FROM search_index_doc WHERE type = 'checklist' AND ref_id = OLD.checklist_id;
   INSERT INTO search_index_doc (type, ref_id) SELECT 'checklist', c.id FROM checklist c WHERE c.id = OLD.checklist_id AND c.deleted_at IS NULL;
   INSERT INTO search_index (rowid, type, ref_id, title, body)
     SELECT d.id, 'checklist', c.id, c.title, (SELECT COALESCE(group_concat(text, char(10)), '') FROM checklist_item WHERE checklist_id = c.id AND deleted_at IS NULL)
     FROM checklist c JOIN search_index_doc d ON d.type = 'checklist' AND d.ref_id = c.id WHERE c.id = OLD.checklist_id AND c.deleted_at IS NULL; END"##),
    ("search_event_ad", "event", r##"CREATE TRIGGER search_event_ad AFTER DELETE ON event BEGIN DELETE FROM search_index WHERE rowid IN (SELECT id FROM search_index_doc WHERE type = 'event' AND ref_id = OLD.id);
   DELETE FROM search_index_doc WHERE type = 'event' AND ref_id = OLD.id; END"##),
    ("search_event_ai", "event", r##"CREATE TRIGGER search_event_ai AFTER INSERT ON event BEGIN DELETE FROM search_index WHERE rowid IN (SELECT id FROM search_index_doc WHERE type = 'event' AND ref_id = NEW.id);
   DELETE FROM search_index_doc WHERE type = 'event' AND ref_id = NEW.id; INSERT INTO search_index_doc (type, ref_id) SELECT 'event', NEW.id WHERE NEW.deleted_at IS NULL;
   INSERT INTO search_index (rowid, type, ref_id, title, body) SELECT last_insert_rowid(), 'event', NEW.id, NEW.title, '' WHERE NEW.deleted_at IS NULL; END"##),
    ("search_event_au", "event", r##"CREATE TRIGGER search_event_au AFTER UPDATE OF title, deleted_at ON event BEGIN DELETE FROM search_index WHERE rowid IN (SELECT id FROM search_index_doc WHERE type = 'event' AND ref_id = NEW.id);
   DELETE FROM search_index_doc WHERE type = 'event' AND ref_id = NEW.id; INSERT INTO search_index_doc (type, ref_id) SELECT 'event', NEW.id WHERE NEW.deleted_at IS NULL;
   INSERT INTO search_index (rowid, type, ref_id, title, body) SELECT last_insert_rowid(), 'event', NEW.id, NEW.title, '' WHERE NEW.deleted_at IS NULL; END"##),
    ("search_goal_ad", "goal", r##"CREATE TRIGGER search_goal_ad AFTER DELETE ON goal BEGIN DELETE FROM search_index WHERE rowid IN (SELECT id FROM search_index_doc WHERE type = 'goal' AND ref_id = OLD.id);
   DELETE FROM search_index_doc WHERE type = 'goal' AND ref_id = OLD.id; END"##),
    ("search_goal_ai", "goal", r##"CREATE TRIGGER search_goal_ai AFTER INSERT ON goal BEGIN DELETE FROM search_index WHERE rowid IN (SELECT id FROM search_index_doc WHERE type = 'goal' AND ref_id = NEW.id);
   DELETE FROM search_index_doc WHERE type = 'goal' AND ref_id = NEW.id; INSERT INTO search_index_doc (type, ref_id) SELECT 'goal', NEW.id WHERE NEW.deleted_at IS NULL;
   INSERT INTO search_index (rowid, type, ref_id, title, body) SELECT last_insert_rowid(), 'goal', NEW.id, NEW.title, '' WHERE NEW.deleted_at IS NULL; END"##),
    ("search_goal_au", "goal", r##"CREATE TRIGGER search_goal_au AFTER UPDATE OF title, deleted_at ON goal BEGIN DELETE FROM search_index WHERE rowid IN (SELECT id FROM search_index_doc WHERE type = 'goal' AND ref_id = NEW.id);
   DELETE FROM search_index_doc WHERE type = 'goal' AND ref_id = NEW.id; INSERT INTO search_index_doc (type, ref_id) SELECT 'goal', NEW.id WHERE NEW.deleted_at IS NULL;
   INSERT INTO search_index (rowid, type, ref_id, title, body) SELECT last_insert_rowid(), 'goal', NEW.id, NEW.title, '' WHERE NEW.deleted_at IS NULL; END"##),
    ("search_routine_ad", "routine", r##"CREATE TRIGGER search_routine_ad AFTER DELETE ON routine BEGIN DELETE FROM search_index WHERE rowid IN (SELECT id FROM search_index_doc WHERE type = 'routine' AND ref_id = OLD.id);
   DELETE FROM search_index_doc WHERE type = 'routine' AND ref_id = OLD.id; END"##),
    ("search_routine_ai", "routine", r##"CREATE TRIGGER search_routine_ai AFTER INSERT ON routine BEGIN DELETE FROM search_index WHERE rowid IN (SELECT id FROM search_index_doc WHERE type = 'routine' AND ref_id = NEW.id);
   DELETE FROM search_index_doc WHERE type = 'routine' AND ref_id = NEW.id; INSERT INTO search_index_doc (type, ref_id) SELECT 'routine', NEW.id WHERE NEW.deleted_at IS NULL;
   INSERT INTO search_index (rowid, type, ref_id, title, body) SELECT last_insert_rowid(), 'routine', NEW.id, NEW.title, '' WHERE NEW.deleted_at IS NULL; END"##),
    ("search_routine_au", "routine", r##"CREATE TRIGGER search_routine_au AFTER UPDATE OF title, deleted_at ON routine BEGIN DELETE FROM search_index WHERE rowid IN (SELECT id FROM search_index_doc WHERE type = 'routine' AND ref_id = NEW.id);
   DELETE FROM search_index_doc WHERE type = 'routine' AND ref_id = NEW.id; INSERT INTO search_index_doc (type, ref_id) SELECT 'routine', NEW.id WHERE NEW.deleted_at IS NULL;
   INSERT INTO search_index (rowid, type, ref_id, title, body) SELECT last_insert_rowid(), 'routine', NEW.id, NEW.title, '' WHERE NEW.deleted_at IS NULL; END"##),
    ("search_task_ad", "task", r##"CREATE TRIGGER search_task_ad AFTER DELETE ON task BEGIN DELETE FROM search_index WHERE rowid IN (SELECT id FROM search_index_doc WHERE type = 'task' AND ref_id = OLD.id);
   DELETE FROM search_index_doc WHERE type = 'task' AND ref_id = OLD.id; END"##),
    ("search_task_ai", "task", r##"CREATE TRIGGER search_task_ai AFTER INSERT ON task BEGIN DELETE FROM search_index WHERE rowid IN (SELECT id FROM search_index_doc WHERE type = 'task' AND ref_id = NEW.id);
   DELETE FROM search_index_doc WHERE type = 'task' AND ref_id = NEW.id; INSERT INTO search_index_doc (type, ref_id) SELECT 'task', NEW.id WHERE NEW.deleted_at IS NULL;
   INSERT INTO search_index (rowid, type, ref_id, title, body) SELECT last_insert_rowid(), 'task', NEW.id, NEW.title, NEW.note WHERE NEW.deleted_at IS NULL; END"##),
    ("search_task_au", "task", r##"CREATE TRIGGER search_task_au AFTER UPDATE OF title, note, deleted_at ON task BEGIN DELETE FROM search_index WHERE rowid IN (SELECT id FROM search_index_doc WHERE type = 'task' AND ref_id = NEW.id);
   DELETE FROM search_index_doc WHERE type = 'task' AND ref_id = NEW.id; INSERT INTO search_index_doc (type, ref_id) SELECT 'task', NEW.id WHERE NEW.deleted_at IS NULL;
   INSERT INTO search_index (rowid, type, ref_id, title, body) SELECT last_insert_rowid(), 'task', NEW.id, NEW.title, NEW.note WHERE NEW.deleted_at IS NULL; END"##),
    ("sync_calendar_account_ai", "calendar_account", r##"CREATE TRIGGER sync_calendar_account_ai AFTER INSERT ON calendar_account WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       DELETE FROM sync_tombstone WHERE table_name = 'calendar_account' AND row_id = NEW.id;
       DELETE FROM sync_outbox WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field = '*';
       INSERT INTO sync_outbox (table_name, row_id, field) VALUES ('calendar_account', NEW.id, '*');
     END"##),
    ("sync_calendar_account_au", "calendar_account", r##"CREATE TRIGGER sync_calendar_account_au AFTER UPDATE ON calendar_account WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
         SELECT 'calendar_account', NEW.id, '*', OLD.hlc, NULL
         WHERE OLD.hlc IS NOT NEW.hlc AND NOT EXISTS (SELECT 1 FROM sync_field_clock WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field = '*');
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'calendar_account', NEW.id, 'provider', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field IN ('provider', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field = 'provider')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field = 'provider'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.provider IS NOT NEW.provider
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field = 'provider' AND OLD.provider IS NOT NEW.provider;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'calendar_account', NEW.id, 'provider' WHERE OLD.provider IS NOT NEW.provider;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'calendar_account', NEW.id, 'label', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field IN ('label', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field = 'label')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field = 'label'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.label IS NOT NEW.label
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field = 'label' AND OLD.label IS NOT NEW.label;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'calendar_account', NEW.id, 'label' WHERE OLD.label IS NOT NEW.label;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'calendar_account', NEW.id, 'calendars', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field IN ('calendars', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field = 'calendars')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field = 'calendars'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.calendars IS NOT NEW.calendars
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field = 'calendars' AND OLD.calendars IS NOT NEW.calendars;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'calendar_account', NEW.id, 'calendars' WHERE OLD.calendars IS NOT NEW.calendars;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'calendar_account', NEW.id, 'created_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field IN ('created_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field = 'created_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field = 'created_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.created_at IS NOT NEW.created_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field = 'created_at' AND OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'calendar_account', NEW.id, 'created_at' WHERE OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'calendar_account', NEW.id, 'deleted_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field IN ('deleted_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field = 'deleted_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field = 'deleted_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.deleted_at IS NOT NEW.deleted_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field = 'deleted_at' AND OLD.deleted_at IS NOT NEW.deleted_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'calendar_account', NEW.id, 'deleted_at' WHERE OLD.deleted_at IS NOT NEW.deleted_at;
       DELETE FROM sync_outbox WHERE table_name = 'calendar_account' AND row_id = NEW.id AND field = '+' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'calendar_account', NEW.id, '+' WHERE OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
     END"##),
    ("sync_checklist_ai", "checklist", r##"CREATE TRIGGER sync_checklist_ai AFTER INSERT ON checklist WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       DELETE FROM sync_tombstone WHERE table_name = 'checklist' AND row_id = NEW.id;
       DELETE FROM sync_outbox WHERE table_name = 'checklist' AND row_id = NEW.id AND field = '*';
       INSERT INTO sync_outbox (table_name, row_id, field) VALUES ('checklist', NEW.id, '*');
     END"##),
    ("sync_checklist_au", "checklist", r##"CREATE TRIGGER sync_checklist_au AFTER UPDATE ON checklist WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
         SELECT 'checklist', NEW.id, '*', OLD.hlc, NULL
         WHERE OLD.hlc IS NOT NEW.hlc AND NOT EXISTS (SELECT 1 FROM sync_field_clock WHERE table_name = 'checklist' AND row_id = NEW.id AND field = '*');
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'checklist', NEW.id, 'space_id', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'checklist' AND row_id = NEW.id AND field IN ('space_id', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'checklist' AND row_id = NEW.id AND field = 'space_id')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'checklist' AND row_id = NEW.id AND field = 'space_id'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'checklist' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.space_id IS NOT NEW.space_id
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'checklist' AND row_id = NEW.id AND field = 'space_id' AND OLD.space_id IS NOT NEW.space_id;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'checklist', NEW.id, 'space_id' WHERE OLD.space_id IS NOT NEW.space_id;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'checklist', NEW.id, 'title', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'checklist' AND row_id = NEW.id AND field IN ('title', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'checklist' AND row_id = NEW.id AND field = 'title')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'checklist' AND row_id = NEW.id AND field = 'title'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'checklist' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.title IS NOT NEW.title
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'checklist' AND row_id = NEW.id AND field = 'title' AND OLD.title IS NOT NEW.title;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'checklist', NEW.id, 'title' WHERE OLD.title IS NOT NEW.title;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'checklist', NEW.id, 'date', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'checklist' AND row_id = NEW.id AND field IN ('date', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'checklist' AND row_id = NEW.id AND field = 'date')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'checklist' AND row_id = NEW.id AND field = 'date'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'checklist' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.date IS NOT NEW.date
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'checklist' AND row_id = NEW.id AND field = 'date' AND OLD.date IS NOT NEW.date;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'checklist', NEW.id, 'date' WHERE OLD.date IS NOT NEW.date;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'checklist', NEW.id, 'is_template', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'checklist' AND row_id = NEW.id AND field IN ('is_template', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'checklist' AND row_id = NEW.id AND field = 'is_template')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'checklist' AND row_id = NEW.id AND field = 'is_template'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'checklist' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.is_template IS NOT NEW.is_template
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'checklist' AND row_id = NEW.id AND field = 'is_template' AND OLD.is_template IS NOT NEW.is_template;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'checklist', NEW.id, 'is_template' WHERE OLD.is_template IS NOT NEW.is_template;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'checklist', NEW.id, 'icon', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'checklist' AND row_id = NEW.id AND field IN ('icon', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'checklist' AND row_id = NEW.id AND field = 'icon')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'checklist' AND row_id = NEW.id AND field = 'icon'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'checklist' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.icon IS NOT NEW.icon
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'checklist' AND row_id = NEW.id AND field = 'icon' AND OLD.icon IS NOT NEW.icon;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'checklist', NEW.id, 'icon' WHERE OLD.icon IS NOT NEW.icon;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'checklist', NEW.id, 'created_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'checklist' AND row_id = NEW.id AND field IN ('created_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'checklist' AND row_id = NEW.id AND field = 'created_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'checklist' AND row_id = NEW.id AND field = 'created_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'checklist' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.created_at IS NOT NEW.created_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'checklist' AND row_id = NEW.id AND field = 'created_at' AND OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'checklist', NEW.id, 'created_at' WHERE OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'checklist', NEW.id, 'deleted_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'checklist' AND row_id = NEW.id AND field IN ('deleted_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'checklist' AND row_id = NEW.id AND field = 'deleted_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'checklist' AND row_id = NEW.id AND field = 'deleted_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'checklist' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.deleted_at IS NOT NEW.deleted_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'checklist' AND row_id = NEW.id AND field = 'deleted_at' AND OLD.deleted_at IS NOT NEW.deleted_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'checklist', NEW.id, 'deleted_at' WHERE OLD.deleted_at IS NOT NEW.deleted_at;
       DELETE FROM sync_outbox WHERE table_name = 'checklist' AND row_id = NEW.id AND field = '+' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'checklist', NEW.id, '+' WHERE OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
     END"##),
    ("sync_checklist_item_ai", "checklist_item", r##"CREATE TRIGGER sync_checklist_item_ai AFTER INSERT ON checklist_item WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       DELETE FROM sync_tombstone WHERE table_name = 'checklist_item' AND row_id = NEW.id;
       DELETE FROM sync_outbox WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = '*';
       INSERT INTO sync_outbox (table_name, row_id, field) VALUES ('checklist_item', NEW.id, '*');
     END"##),
    ("sync_checklist_item_au", "checklist_item", r##"CREATE TRIGGER sync_checklist_item_au AFTER UPDATE ON checklist_item WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
         SELECT 'checklist_item', NEW.id, '*', OLD.hlc, NULL
         WHERE OLD.hlc IS NOT NEW.hlc AND NOT EXISTS (SELECT 1 FROM sync_field_clock WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = '*');
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'checklist_item', NEW.id, 'checklist_id', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field IN ('checklist_id', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = 'checklist_id')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = 'checklist_id'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.checklist_id IS NOT NEW.checklist_id
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = 'checklist_id' AND OLD.checklist_id IS NOT NEW.checklist_id;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'checklist_item', NEW.id, 'checklist_id' WHERE OLD.checklist_id IS NOT NEW.checklist_id;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'checklist_item', NEW.id, 'text', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field IN ('text', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = 'text')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = 'text'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.text IS NOT NEW.text
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = 'text' AND OLD.text IS NOT NEW.text;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'checklist_item', NEW.id, 'text' WHERE OLD.text IS NOT NEW.text;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'checklist_item', NEW.id, 'checked', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field IN ('checked', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = 'checked')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = 'checked'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.checked IS NOT NEW.checked
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = 'checked' AND OLD.checked IS NOT NEW.checked;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'checklist_item', NEW.id, 'checked' WHERE OLD.checked IS NOT NEW.checked;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'checklist_item', NEW.id, 'sort_order', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field IN ('sort_order', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = 'sort_order')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = 'sort_order'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.sort_order IS NOT NEW.sort_order
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = 'sort_order' AND OLD.sort_order IS NOT NEW.sort_order;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'checklist_item', NEW.id, 'sort_order' WHERE OLD.sort_order IS NOT NEW.sort_order;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'checklist_item', NEW.id, 'created_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field IN ('created_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = 'created_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = 'created_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.created_at IS NOT NEW.created_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = 'created_at' AND OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'checklist_item', NEW.id, 'created_at' WHERE OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'checklist_item', NEW.id, 'deleted_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field IN ('deleted_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = 'deleted_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = 'deleted_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.deleted_at IS NOT NEW.deleted_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = 'deleted_at' AND OLD.deleted_at IS NOT NEW.deleted_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'checklist_item', NEW.id, 'deleted_at' WHERE OLD.deleted_at IS NOT NEW.deleted_at;
       DELETE FROM sync_outbox WHERE table_name = 'checklist_item' AND row_id = NEW.id AND field = '+' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'checklist_item', NEW.id, '+' WHERE OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
     END"##),
    ("sync_event_ai", "event", r##"CREATE TRIGGER sync_event_ai AFTER INSERT ON event WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       DELETE FROM sync_tombstone WHERE table_name = 'event' AND row_id = NEW.id;
       DELETE FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field = '*';
       INSERT INTO sync_outbox (table_name, row_id, field) VALUES ('event', NEW.id, '*');
     END"##),
    ("sync_event_au", "event", r##"CREATE TRIGGER sync_event_au AFTER UPDATE ON event WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
         SELECT 'event', NEW.id, '*', OLD.hlc, NULL
         WHERE OLD.hlc IS NOT NEW.hlc AND NOT EXISTS (SELECT 1 FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = '*');
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'event', NEW.id, 'space_id', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field IN ('space_id', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'space_id')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'space_id'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.space_id IS NOT NEW.space_id
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field = 'space_id' AND OLD.space_id IS NOT NEW.space_id;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'event', NEW.id, 'space_id' WHERE OLD.space_id IS NOT NEW.space_id;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'event', NEW.id, 'title', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field IN ('title', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'title')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'title'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.title IS NOT NEW.title
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field = 'title' AND OLD.title IS NOT NEW.title;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'event', NEW.id, 'title' WHERE OLD.title IS NOT NEW.title;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'event', NEW.id, 'start_date', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field IN ('start_date', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'start_date')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'start_date'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.start_date IS NOT NEW.start_date
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field = 'start_date' AND OLD.start_date IS NOT NEW.start_date;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'event', NEW.id, 'start_date' WHERE OLD.start_date IS NOT NEW.start_date;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'event', NEW.id, 'start_time', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field IN ('start_time', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'start_time')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'start_time'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.start_time IS NOT NEW.start_time
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field = 'start_time' AND OLD.start_time IS NOT NEW.start_time;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'event', NEW.id, 'start_time' WHERE OLD.start_time IS NOT NEW.start_time;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'event', NEW.id, 'end_date', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field IN ('end_date', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'end_date')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'end_date'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.end_date IS NOT NEW.end_date
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field = 'end_date' AND OLD.end_date IS NOT NEW.end_date;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'event', NEW.id, 'end_date' WHERE OLD.end_date IS NOT NEW.end_date;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'event', NEW.id, 'end_time', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field IN ('end_time', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'end_time')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'end_time'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.end_time IS NOT NEW.end_time
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field = 'end_time' AND OLD.end_time IS NOT NEW.end_time;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'event', NEW.id, 'end_time' WHERE OLD.end_time IS NOT NEW.end_time;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'event', NEW.id, 'all_day', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field IN ('all_day', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'all_day')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'all_day'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.all_day IS NOT NEW.all_day
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field = 'all_day' AND OLD.all_day IS NOT NEW.all_day;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'event', NEW.id, 'all_day' WHERE OLD.all_day IS NOT NEW.all_day;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'event', NEW.id, 'kind', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field IN ('kind', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'kind')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'kind'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.kind IS NOT NEW.kind
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field = 'kind' AND OLD.kind IS NOT NEW.kind;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'event', NEW.id, 'kind' WHERE OLD.kind IS NOT NEW.kind;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'event', NEW.id, 'repeat', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field IN ('repeat', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'repeat')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'repeat'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.repeat IS NOT NEW.repeat
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field = 'repeat' AND OLD.repeat IS NOT NEW.repeat;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'event', NEW.id, 'repeat' WHERE OLD.repeat IS NOT NEW.repeat;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'event', NEW.id, 'important', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field IN ('important', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'important')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'important'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.important IS NOT NEW.important
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field = 'important' AND OLD.important IS NOT NEW.important;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'event', NEW.id, 'important' WHERE OLD.important IS NOT NEW.important;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'event', NEW.id, 'icon', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field IN ('icon', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'icon')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'icon'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.icon IS NOT NEW.icon
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field = 'icon' AND OLD.icon IS NOT NEW.icon;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'event', NEW.id, 'icon' WHERE OLD.icon IS NOT NEW.icon;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'event', NEW.id, 'birth_year', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field IN ('birth_year', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'birth_year')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'birth_year'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.birth_year IS NOT NEW.birth_year
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field = 'birth_year' AND OLD.birth_year IS NOT NEW.birth_year;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'event', NEW.id, 'birth_year' WHERE OLD.birth_year IS NOT NEW.birth_year;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'event', NEW.id, 'created_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field IN ('created_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'created_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'created_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.created_at IS NOT NEW.created_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field = 'created_at' AND OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'event', NEW.id, 'created_at' WHERE OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'event', NEW.id, 'deleted_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field IN ('deleted_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'deleted_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = 'deleted_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'event' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.deleted_at IS NOT NEW.deleted_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field = 'deleted_at' AND OLD.deleted_at IS NOT NEW.deleted_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'event', NEW.id, 'deleted_at' WHERE OLD.deleted_at IS NOT NEW.deleted_at;
       DELETE FROM sync_outbox WHERE table_name = 'event' AND row_id = NEW.id AND field = '+' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'event', NEW.id, '+' WHERE OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
       INSERT OR IGNORE INTO sync_outbox (table_name, row_id, field) SELECT 'reminder', r.id, '+' FROM reminder r WHERE r.target_type = 'event' AND r.target_id = NEW.id AND r.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
     END"##),
    ("sync_focus_session_ai", "focus_session", r##"CREATE TRIGGER sync_focus_session_ai AFTER INSERT ON focus_session WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       DELETE FROM sync_tombstone WHERE table_name = 'focus_session' AND row_id = NEW.id;
       DELETE FROM sync_outbox WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = '*';
       INSERT INTO sync_outbox (table_name, row_id, field) VALUES ('focus_session', NEW.id, '*');
     END"##),
    ("sync_focus_session_au", "focus_session", r##"CREATE TRIGGER sync_focus_session_au AFTER UPDATE ON focus_session WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
         SELECT 'focus_session', NEW.id, '*', OLD.hlc, NULL
         WHERE OLD.hlc IS NOT NEW.hlc AND NOT EXISTS (SELECT 1 FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = '*');
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'focus_session', NEW.id, 'task_id', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'focus_session' AND row_id = NEW.id AND field IN ('task_id', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'task_id')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'task_id'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.task_id IS NOT NEW.task_id
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'task_id' AND OLD.task_id IS NOT NEW.task_id;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'focus_session', NEW.id, 'task_id' WHERE OLD.task_id IS NOT NEW.task_id;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'focus_session', NEW.id, 'space_id', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'focus_session' AND row_id = NEW.id AND field IN ('space_id', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'space_id')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'space_id'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.space_id IS NOT NEW.space_id
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'space_id' AND OLD.space_id IS NOT NEW.space_id;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'focus_session', NEW.id, 'space_id' WHERE OLD.space_id IS NOT NEW.space_id;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'focus_session', NEW.id, 'planned_min', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'focus_session' AND row_id = NEW.id AND field IN ('planned_min', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'planned_min')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'planned_min'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.planned_min IS NOT NEW.planned_min
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'planned_min' AND OLD.planned_min IS NOT NEW.planned_min;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'focus_session', NEW.id, 'planned_min' WHERE OLD.planned_min IS NOT NEW.planned_min;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'focus_session', NEW.id, 'started_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'focus_session' AND row_id = NEW.id AND field IN ('started_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'started_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'started_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.started_at IS NOT NEW.started_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'started_at' AND OLD.started_at IS NOT NEW.started_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'focus_session', NEW.id, 'started_at' WHERE OLD.started_at IS NOT NEW.started_at;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'focus_session', NEW.id, 'ended_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'focus_session' AND row_id = NEW.id AND field IN ('ended_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'ended_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'ended_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.ended_at IS NOT NEW.ended_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'ended_at' AND OLD.ended_at IS NOT NEW.ended_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'focus_session', NEW.id, 'ended_at' WHERE OLD.ended_at IS NOT NEW.ended_at;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'focus_session', NEW.id, 'paused_sec', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'focus_session' AND row_id = NEW.id AND field IN ('paused_sec', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'paused_sec')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'paused_sec'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.paused_sec IS NOT NEW.paused_sec
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'paused_sec' AND OLD.paused_sec IS NOT NEW.paused_sec;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'focus_session', NEW.id, 'paused_sec' WHERE OLD.paused_sec IS NOT NEW.paused_sec;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'focus_session', NEW.id, 'paused_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'focus_session' AND row_id = NEW.id AND field IN ('paused_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'paused_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'paused_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.paused_at IS NOT NEW.paused_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'paused_at' AND OLD.paused_at IS NOT NEW.paused_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'focus_session', NEW.id, 'paused_at' WHERE OLD.paused_at IS NOT NEW.paused_at;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'focus_session', NEW.id, 'project_id', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'focus_session' AND row_id = NEW.id AND field IN ('project_id', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'project_id')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'project_id'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.project_id IS NOT NEW.project_id
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'project_id' AND OLD.project_id IS NOT NEW.project_id;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'focus_session', NEW.id, 'project_id' WHERE OLD.project_id IS NOT NEW.project_id;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'focus_session', NEW.id, 'created_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'focus_session' AND row_id = NEW.id AND field IN ('created_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'created_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'created_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.created_at IS NOT NEW.created_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'created_at' AND OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'focus_session', NEW.id, 'created_at' WHERE OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'focus_session', NEW.id, 'deleted_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'focus_session' AND row_id = NEW.id AND field IN ('deleted_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'deleted_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'deleted_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.deleted_at IS NOT NEW.deleted_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = 'deleted_at' AND OLD.deleted_at IS NOT NEW.deleted_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'focus_session', NEW.id, 'deleted_at' WHERE OLD.deleted_at IS NOT NEW.deleted_at;
       DELETE FROM sync_outbox WHERE table_name = 'focus_session' AND row_id = NEW.id AND field = '+' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'focus_session', NEW.id, '+' WHERE OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
     END"##),
    ("sync_goal_ai", "goal", r##"CREATE TRIGGER sync_goal_ai AFTER INSERT ON goal WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       DELETE FROM sync_tombstone WHERE table_name = 'goal' AND row_id = NEW.id;
       DELETE FROM sync_outbox WHERE table_name = 'goal' AND row_id = NEW.id AND field = '*';
       INSERT INTO sync_outbox (table_name, row_id, field) VALUES ('goal', NEW.id, '*');
     END"##),
    ("sync_goal_au", "goal", r##"CREATE TRIGGER sync_goal_au AFTER UPDATE ON goal WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
         SELECT 'goal', NEW.id, '*', OLD.hlc, NULL
         WHERE OLD.hlc IS NOT NEW.hlc AND NOT EXISTS (SELECT 1 FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = '*');
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'goal', NEW.id, 'space_id', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'goal' AND row_id = NEW.id AND field IN ('space_id', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'space_id')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'space_id'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.space_id IS NOT NEW.space_id
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'space_id' AND OLD.space_id IS NOT NEW.space_id;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'goal', NEW.id, 'space_id' WHERE OLD.space_id IS NOT NEW.space_id;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'goal', NEW.id, 'week_start', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'goal' AND row_id = NEW.id AND field IN ('week_start', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'week_start')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'week_start'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.week_start IS NOT NEW.week_start
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'week_start' AND OLD.week_start IS NOT NEW.week_start;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'goal', NEW.id, 'week_start' WHERE OLD.week_start IS NOT NEW.week_start;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'goal', NEW.id, 'title', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'goal' AND row_id = NEW.id AND field IN ('title', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'title')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'title'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.title IS NOT NEW.title
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'title' AND OLD.title IS NOT NEW.title;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'goal', NEW.id, 'title' WHERE OLD.title IS NOT NEW.title;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'goal', NEW.id, 'icon', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'goal' AND row_id = NEW.id AND field IN ('icon', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'icon')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'icon'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.icon IS NOT NEW.icon
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'icon' AND OLD.icon IS NOT NEW.icon;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'goal', NEW.id, 'icon' WHERE OLD.icon IS NOT NEW.icon;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'goal', NEW.id, 'pinned', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'goal' AND row_id = NEW.id AND field IN ('pinned', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'pinned')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'pinned'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.pinned IS NOT NEW.pinned
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'pinned' AND OLD.pinned IS NOT NEW.pinned;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'goal', NEW.id, 'pinned' WHERE OLD.pinned IS NOT NEW.pinned;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'goal', NEW.id, 'status', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'goal' AND row_id = NEW.id AND field IN ('status', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'status')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'status'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.status IS NOT NEW.status
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'status' AND OLD.status IS NOT NEW.status;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'goal', NEW.id, 'status' WHERE OLD.status IS NOT NEW.status;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'goal', NEW.id, 'carried_from_id', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'goal' AND row_id = NEW.id AND field IN ('carried_from_id', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'carried_from_id')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'carried_from_id'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.carried_from_id IS NOT NEW.carried_from_id
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'carried_from_id' AND OLD.carried_from_id IS NOT NEW.carried_from_id;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'goal', NEW.id, 'carried_from_id' WHERE OLD.carried_from_id IS NOT NEW.carried_from_id;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'goal', NEW.id, 'created_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'goal' AND row_id = NEW.id AND field IN ('created_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'created_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'created_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.created_at IS NOT NEW.created_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'created_at' AND OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'goal', NEW.id, 'created_at' WHERE OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'goal', NEW.id, 'deleted_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'goal' AND row_id = NEW.id AND field IN ('deleted_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'deleted_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'deleted_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'goal' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.deleted_at IS NOT NEW.deleted_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'goal' AND row_id = NEW.id AND field = 'deleted_at' AND OLD.deleted_at IS NOT NEW.deleted_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'goal', NEW.id, 'deleted_at' WHERE OLD.deleted_at IS NOT NEW.deleted_at;
       DELETE FROM sync_outbox WHERE table_name = 'goal' AND row_id = NEW.id AND field = '+' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'goal', NEW.id, '+' WHERE OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
     END"##),
    ("sync_holiday_ai", "holiday", r##"CREATE TRIGGER sync_holiday_ai AFTER INSERT ON holiday WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       DELETE FROM sync_tombstone WHERE table_name = 'holiday' AND row_id = NEW.id;
       DELETE FROM sync_outbox WHERE table_name = 'holiday' AND row_id = NEW.id AND field = '*';
       INSERT INTO sync_outbox (table_name, row_id, field) VALUES ('holiday', NEW.id, '*');
     END"##),
    ("sync_holiday_au", "holiday", r##"CREATE TRIGGER sync_holiday_au AFTER UPDATE ON holiday WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
         SELECT 'holiday', NEW.id, '*', OLD.hlc, NULL
         WHERE OLD.hlc IS NOT NEW.hlc AND NOT EXISTS (SELECT 1 FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = '*');
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'holiday', NEW.id, 'country', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'holiday' AND row_id = NEW.id AND field IN ('country', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'country')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'country'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.country IS NOT NEW.country
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'country' AND OLD.country IS NOT NEW.country;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'holiday', NEW.id, 'country' WHERE OLD.country IS NOT NEW.country;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'holiday', NEW.id, 'year', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'holiday' AND row_id = NEW.id AND field IN ('year', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'year')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'year'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.year IS NOT NEW.year
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'year' AND OLD.year IS NOT NEW.year;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'holiday', NEW.id, 'year' WHERE OLD.year IS NOT NEW.year;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'holiday', NEW.id, 'key', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'holiday' AND row_id = NEW.id AND field IN ('key', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'key')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'key'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.key IS NOT NEW.key
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'key' AND OLD.key IS NOT NEW.key;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'holiday', NEW.id, 'key' WHERE OLD.key IS NOT NEW.key;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'holiday', NEW.id, 'date', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'holiday' AND row_id = NEW.id AND field IN ('date', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'date')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'date'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.date IS NOT NEW.date
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'date' AND OLD.date IS NOT NEW.date;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'holiday', NEW.id, 'date' WHERE OLD.date IS NOT NEW.date;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'holiday', NEW.id, 'name', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'holiday' AND row_id = NEW.id AND field IN ('name', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'name')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'name'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.name IS NOT NEW.name
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'name' AND OLD.name IS NOT NEW.name;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'holiday', NEW.id, 'name' WHERE OLD.name IS NOT NEW.name;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'holiday', NEW.id, 'kind', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'holiday' AND row_id = NEW.id AND field IN ('kind', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'kind')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'kind'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.kind IS NOT NEW.kind
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'kind' AND OLD.kind IS NOT NEW.kind;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'holiday', NEW.id, 'kind' WHERE OLD.kind IS NOT NEW.kind;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'holiday', NEW.id, 'source', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'holiday' AND row_id = NEW.id AND field IN ('source', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'source')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'source'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.source IS NOT NEW.source
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'source' AND OLD.source IS NOT NEW.source;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'holiday', NEW.id, 'source' WHERE OLD.source IS NOT NEW.source;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'holiday', NEW.id, 'overridden', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'holiday' AND row_id = NEW.id AND field IN ('overridden', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'overridden')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'overridden'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.overridden IS NOT NEW.overridden
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'overridden' AND OLD.overridden IS NOT NEW.overridden;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'holiday', NEW.id, 'overridden' WHERE OLD.overridden IS NOT NEW.overridden;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'holiday', NEW.id, 'created_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'holiday' AND row_id = NEW.id AND field IN ('created_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'created_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'created_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.created_at IS NOT NEW.created_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'created_at' AND OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'holiday', NEW.id, 'created_at' WHERE OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'holiday', NEW.id, 'deleted_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'holiday' AND row_id = NEW.id AND field IN ('deleted_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'deleted_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'deleted_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'holiday' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.deleted_at IS NOT NEW.deleted_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'holiday' AND row_id = NEW.id AND field = 'deleted_at' AND OLD.deleted_at IS NOT NEW.deleted_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'holiday', NEW.id, 'deleted_at' WHERE OLD.deleted_at IS NOT NEW.deleted_at;
       DELETE FROM sync_outbox WHERE table_name = 'holiday' AND row_id = NEW.id AND field = '+' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'holiday', NEW.id, '+' WHERE OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
     END"##),
    ("sync_project_ai", "project", r##"CREATE TRIGGER sync_project_ai AFTER INSERT ON project WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       DELETE FROM sync_tombstone WHERE table_name = 'project' AND row_id = NEW.id;
       DELETE FROM sync_outbox WHERE table_name = 'project' AND row_id = NEW.id AND field = '*';
       INSERT INTO sync_outbox (table_name, row_id, field) VALUES ('project', NEW.id, '*');
     END"##),
    ("sync_project_au", "project", r##"CREATE TRIGGER sync_project_au AFTER UPDATE ON project WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
         SELECT 'project', NEW.id, '*', OLD.hlc, NULL
         WHERE OLD.hlc IS NOT NEW.hlc AND NOT EXISTS (SELECT 1 FROM sync_field_clock WHERE table_name = 'project' AND row_id = NEW.id AND field = '*');
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'project', NEW.id, 'space_id', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'project' AND row_id = NEW.id AND field IN ('space_id', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'project' AND row_id = NEW.id AND field = 'space_id')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'project' AND row_id = NEW.id AND field = 'space_id'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'project' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.space_id IS NOT NEW.space_id
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'project' AND row_id = NEW.id AND field = 'space_id' AND OLD.space_id IS NOT NEW.space_id;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'project', NEW.id, 'space_id' WHERE OLD.space_id IS NOT NEW.space_id;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'project', NEW.id, 'name', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'project' AND row_id = NEW.id AND field IN ('name', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'project' AND row_id = NEW.id AND field = 'name')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'project' AND row_id = NEW.id AND field = 'name'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'project' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.name IS NOT NEW.name
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'project' AND row_id = NEW.id AND field = 'name' AND OLD.name IS NOT NEW.name;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'project', NEW.id, 'name' WHERE OLD.name IS NOT NEW.name;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'project', NEW.id, 'color', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'project' AND row_id = NEW.id AND field IN ('color', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'project' AND row_id = NEW.id AND field = 'color')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'project' AND row_id = NEW.id AND field = 'color'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'project' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.color IS NOT NEW.color
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'project' AND row_id = NEW.id AND field = 'color' AND OLD.color IS NOT NEW.color;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'project', NEW.id, 'color' WHERE OLD.color IS NOT NEW.color;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'project', NEW.id, 'archived', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'project' AND row_id = NEW.id AND field IN ('archived', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'project' AND row_id = NEW.id AND field = 'archived')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'project' AND row_id = NEW.id AND field = 'archived'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'project' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.archived IS NOT NEW.archived
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'project' AND row_id = NEW.id AND field = 'archived' AND OLD.archived IS NOT NEW.archived;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'project', NEW.id, 'archived' WHERE OLD.archived IS NOT NEW.archived;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'project', NEW.id, 'sort_order', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'project' AND row_id = NEW.id AND field IN ('sort_order', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'project' AND row_id = NEW.id AND field = 'sort_order')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'project' AND row_id = NEW.id AND field = 'sort_order'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'project' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.sort_order IS NOT NEW.sort_order
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'project' AND row_id = NEW.id AND field = 'sort_order' AND OLD.sort_order IS NOT NEW.sort_order;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'project', NEW.id, 'sort_order' WHERE OLD.sort_order IS NOT NEW.sort_order;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'project', NEW.id, 'created_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'project' AND row_id = NEW.id AND field IN ('created_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'project' AND row_id = NEW.id AND field = 'created_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'project' AND row_id = NEW.id AND field = 'created_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'project' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.created_at IS NOT NEW.created_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'project' AND row_id = NEW.id AND field = 'created_at' AND OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'project', NEW.id, 'created_at' WHERE OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'project', NEW.id, 'deleted_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'project' AND row_id = NEW.id AND field IN ('deleted_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'project' AND row_id = NEW.id AND field = 'deleted_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'project' AND row_id = NEW.id AND field = 'deleted_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'project' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.deleted_at IS NOT NEW.deleted_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'project' AND row_id = NEW.id AND field = 'deleted_at' AND OLD.deleted_at IS NOT NEW.deleted_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'project', NEW.id, 'deleted_at' WHERE OLD.deleted_at IS NOT NEW.deleted_at;
       DELETE FROM sync_outbox WHERE table_name = 'project' AND row_id = NEW.id AND field = '+' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'project', NEW.id, '+' WHERE OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
     END"##),
    ("sync_recurrence_ai", "recurrence", r##"CREATE TRIGGER sync_recurrence_ai AFTER INSERT ON recurrence WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       DELETE FROM sync_tombstone WHERE table_name = 'recurrence' AND row_id = NEW.id;
       DELETE FROM sync_outbox WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = '*';
       INSERT INTO sync_outbox (table_name, row_id, field) VALUES ('recurrence', NEW.id, '*');
     END"##),
    ("sync_recurrence_au", "recurrence", r##"CREATE TRIGGER sync_recurrence_au AFTER UPDATE ON recurrence WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
         SELECT 'recurrence', NEW.id, '*', OLD.hlc, NULL
         WHERE OLD.hlc IS NOT NEW.hlc AND NOT EXISTS (SELECT 1 FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = '*');
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'recurrence', NEW.id, 'freq', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'recurrence' AND row_id = NEW.id AND field IN ('freq', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'freq')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'freq'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.freq IS NOT NEW.freq
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'freq' AND OLD.freq IS NOT NEW.freq;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'recurrence', NEW.id, 'freq' WHERE OLD.freq IS NOT NEW.freq;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'recurrence', NEW.id, 'interval', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'recurrence' AND row_id = NEW.id AND field IN ('interval', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'interval')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'interval'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.interval IS NOT NEW.interval
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'interval' AND OLD.interval IS NOT NEW.interval;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'recurrence', NEW.id, 'interval' WHERE OLD.interval IS NOT NEW.interval;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'recurrence', NEW.id, 'weekdays', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'recurrence' AND row_id = NEW.id AND field IN ('weekdays', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'weekdays')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'weekdays'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.weekdays IS NOT NEW.weekdays
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'weekdays' AND OLD.weekdays IS NOT NEW.weekdays;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'recurrence', NEW.id, 'weekdays' WHERE OLD.weekdays IS NOT NEW.weekdays;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'recurrence', NEW.id, 'month_day', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'recurrence' AND row_id = NEW.id AND field IN ('month_day', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'month_day')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'month_day'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.month_day IS NOT NEW.month_day
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'month_day' AND OLD.month_day IS NOT NEW.month_day;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'recurrence', NEW.id, 'month_day' WHERE OLD.month_day IS NOT NEW.month_day;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'recurrence', NEW.id, 'nth_weekday', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'recurrence' AND row_id = NEW.id AND field IN ('nth_weekday', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'nth_weekday')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'nth_weekday'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.nth_weekday IS NOT NEW.nth_weekday
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'nth_weekday' AND OLD.nth_weekday IS NOT NEW.nth_weekday;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'recurrence', NEW.id, 'nth_weekday' WHERE OLD.nth_weekday IS NOT NEW.nth_weekday;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'recurrence', NEW.id, 'until', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'recurrence' AND row_id = NEW.id AND field IN ('until', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'until')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'until'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.until IS NOT NEW.until
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'until' AND OLD.until IS NOT NEW.until;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'recurrence', NEW.id, 'until' WHERE OLD.until IS NOT NEW.until;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'recurrence', NEW.id, 'count', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'recurrence' AND row_id = NEW.id AND field IN ('count', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'count')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'count'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.count IS NOT NEW.count
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'count' AND OLD.count IS NOT NEW.count;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'recurrence', NEW.id, 'count' WHERE OLD.count IS NOT NEW.count;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'recurrence', NEW.id, 'created_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'recurrence' AND row_id = NEW.id AND field IN ('created_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'created_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'created_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.created_at IS NOT NEW.created_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'created_at' AND OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'recurrence', NEW.id, 'created_at' WHERE OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'recurrence', NEW.id, 'deleted_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'recurrence' AND row_id = NEW.id AND field IN ('deleted_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'deleted_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'deleted_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.deleted_at IS NOT NEW.deleted_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = 'deleted_at' AND OLD.deleted_at IS NOT NEW.deleted_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'recurrence', NEW.id, 'deleted_at' WHERE OLD.deleted_at IS NOT NEW.deleted_at;
       DELETE FROM sync_outbox WHERE table_name = 'recurrence' AND row_id = NEW.id AND field = '+' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'recurrence', NEW.id, '+' WHERE OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
     END"##),
    ("sync_reminder_ai", "reminder", r##"CREATE TRIGGER sync_reminder_ai AFTER INSERT ON reminder WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       DELETE FROM sync_tombstone WHERE table_name = 'reminder' AND row_id = NEW.id;
       DELETE FROM sync_outbox WHERE table_name = 'reminder' AND row_id = NEW.id AND field = '*';
       INSERT INTO sync_outbox (table_name, row_id, field) VALUES ('reminder', NEW.id, '*');
     END"##),
    ("sync_reminder_au", "reminder", r##"CREATE TRIGGER sync_reminder_au AFTER UPDATE ON reminder WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
         SELECT 'reminder', NEW.id, '*', OLD.hlc, NULL
         WHERE OLD.hlc IS NOT NEW.hlc AND NOT EXISTS (SELECT 1 FROM sync_field_clock WHERE table_name = 'reminder' AND row_id = NEW.id AND field = '*');
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'reminder', NEW.id, 'target_type', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'reminder' AND row_id = NEW.id AND field IN ('target_type', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'reminder' AND row_id = NEW.id AND field = 'target_type')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'reminder' AND row_id = NEW.id AND field = 'target_type'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'reminder' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.target_type IS NOT NEW.target_type
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'reminder' AND row_id = NEW.id AND field = 'target_type' AND OLD.target_type IS NOT NEW.target_type;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'reminder', NEW.id, 'target_type' WHERE OLD.target_type IS NOT NEW.target_type;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'reminder', NEW.id, 'target_id', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'reminder' AND row_id = NEW.id AND field IN ('target_id', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'reminder' AND row_id = NEW.id AND field = 'target_id')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'reminder' AND row_id = NEW.id AND field = 'target_id'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'reminder' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.target_id IS NOT NEW.target_id
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'reminder' AND row_id = NEW.id AND field = 'target_id' AND OLD.target_id IS NOT NEW.target_id;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'reminder', NEW.id, 'target_id' WHERE OLD.target_id IS NOT NEW.target_id;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'reminder', NEW.id, 'offset_min', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'reminder' AND row_id = NEW.id AND field IN ('offset_min', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'reminder' AND row_id = NEW.id AND field = 'offset_min')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'reminder' AND row_id = NEW.id AND field = 'offset_min'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'reminder' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.offset_min IS NOT NEW.offset_min
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'reminder' AND row_id = NEW.id AND field = 'offset_min' AND OLD.offset_min IS NOT NEW.offset_min;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'reminder', NEW.id, 'offset_min' WHERE OLD.offset_min IS NOT NEW.offset_min;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'reminder', NEW.id, 'fire_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'reminder' AND row_id = NEW.id AND field IN ('fire_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'reminder' AND row_id = NEW.id AND field = 'fire_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'reminder' AND row_id = NEW.id AND field = 'fire_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'reminder' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.fire_at IS NOT NEW.fire_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'reminder' AND row_id = NEW.id AND field = 'fire_at' AND OLD.fire_at IS NOT NEW.fire_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'reminder', NEW.id, 'fire_at' WHERE OLD.fire_at IS NOT NEW.fire_at;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'reminder', NEW.id, 'delivered', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'reminder' AND row_id = NEW.id AND field IN ('delivered', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'reminder' AND row_id = NEW.id AND field = 'delivered')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'reminder' AND row_id = NEW.id AND field = 'delivered'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'reminder' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.delivered IS NOT NEW.delivered
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'reminder' AND row_id = NEW.id AND field = 'delivered' AND OLD.delivered IS NOT NEW.delivered;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'reminder', NEW.id, 'delivered' WHERE OLD.delivered IS NOT NEW.delivered;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'reminder', NEW.id, 'created_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'reminder' AND row_id = NEW.id AND field IN ('created_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'reminder' AND row_id = NEW.id AND field = 'created_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'reminder' AND row_id = NEW.id AND field = 'created_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'reminder' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.created_at IS NOT NEW.created_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'reminder' AND row_id = NEW.id AND field = 'created_at' AND OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'reminder', NEW.id, 'created_at' WHERE OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'reminder', NEW.id, 'deleted_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'reminder' AND row_id = NEW.id AND field IN ('deleted_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'reminder' AND row_id = NEW.id AND field = 'deleted_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'reminder' AND row_id = NEW.id AND field = 'deleted_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'reminder' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.deleted_at IS NOT NEW.deleted_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'reminder' AND row_id = NEW.id AND field = 'deleted_at' AND OLD.deleted_at IS NOT NEW.deleted_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'reminder', NEW.id, 'deleted_at' WHERE OLD.deleted_at IS NOT NEW.deleted_at;
       DELETE FROM sync_outbox WHERE table_name = 'reminder' AND row_id = NEW.id AND field = '+' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'reminder', NEW.id, '+' WHERE OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
     END"##),
    ("sync_routine_ai", "routine", r##"CREATE TRIGGER sync_routine_ai AFTER INSERT ON routine WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       DELETE FROM sync_tombstone WHERE table_name = 'routine' AND row_id = NEW.id;
       DELETE FROM sync_outbox WHERE table_name = 'routine' AND row_id = NEW.id AND field = '*';
       INSERT INTO sync_outbox (table_name, row_id, field) VALUES ('routine', NEW.id, '*');
     END"##),
    ("sync_routine_au", "routine", r##"CREATE TRIGGER sync_routine_au AFTER UPDATE ON routine WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
         SELECT 'routine', NEW.id, '*', OLD.hlc, NULL
         WHERE OLD.hlc IS NOT NEW.hlc AND NOT EXISTS (SELECT 1 FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = '*');
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'routine', NEW.id, 'space_id', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'routine' AND row_id = NEW.id AND field IN ('space_id', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'space_id')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'space_id'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.space_id IS NOT NEW.space_id
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'space_id' AND OLD.space_id IS NOT NEW.space_id;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'routine', NEW.id, 'space_id' WHERE OLD.space_id IS NOT NEW.space_id;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'routine', NEW.id, 'title', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'routine' AND row_id = NEW.id AND field IN ('title', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'title')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'title'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.title IS NOT NEW.title
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'title' AND OLD.title IS NOT NEW.title;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'routine', NEW.id, 'title' WHERE OLD.title IS NOT NEW.title;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'routine', NEW.id, 'icon', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'routine' AND row_id = NEW.id AND field IN ('icon', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'icon')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'icon'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.icon IS NOT NEW.icon
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'icon' AND OLD.icon IS NOT NEW.icon;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'routine', NEW.id, 'icon' WHERE OLD.icon IS NOT NEW.icon;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'routine', NEW.id, 'schedule_type', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'routine' AND row_id = NEW.id AND field IN ('schedule_type', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'schedule_type')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'schedule_type'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.schedule_type IS NOT NEW.schedule_type
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'schedule_type' AND OLD.schedule_type IS NOT NEW.schedule_type;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'routine', NEW.id, 'schedule_type' WHERE OLD.schedule_type IS NOT NEW.schedule_type;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'routine', NEW.id, 'weekdays', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'routine' AND row_id = NEW.id AND field IN ('weekdays', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'weekdays')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'weekdays'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.weekdays IS NOT NEW.weekdays
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'weekdays' AND OLD.weekdays IS NOT NEW.weekdays;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'routine', NEW.id, 'weekdays' WHERE OLD.weekdays IS NOT NEW.weekdays;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'routine', NEW.id, 'times_per_week', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'routine' AND row_id = NEW.id AND field IN ('times_per_week', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'times_per_week')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'times_per_week'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.times_per_week IS NOT NEW.times_per_week
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'times_per_week' AND OLD.times_per_week IS NOT NEW.times_per_week;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'routine', NEW.id, 'times_per_week' WHERE OLD.times_per_week IS NOT NEW.times_per_week;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'routine', NEW.id, 'interval', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'routine' AND row_id = NEW.id AND field IN ('interval', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'interval')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'interval'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.interval IS NOT NEW.interval
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'interval' AND OLD.interval IS NOT NEW.interval;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'routine', NEW.id, 'interval' WHERE OLD.interval IS NOT NEW.interval;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'routine', NEW.id, 'start_date', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'routine' AND row_id = NEW.id AND field IN ('start_date', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'start_date')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'start_date'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.start_date IS NOT NEW.start_date
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'start_date' AND OLD.start_date IS NOT NEW.start_date;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'routine', NEW.id, 'start_date' WHERE OLD.start_date IS NOT NEW.start_date;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'routine', NEW.id, 'time', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'routine' AND row_id = NEW.id AND field IN ('time', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'time')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'time'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.time IS NOT NEW.time
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'time' AND OLD.time IS NOT NEW.time;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'routine', NEW.id, 'time' WHERE OLD.time IS NOT NEW.time;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'routine', NEW.id, 'archived', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'routine' AND row_id = NEW.id AND field IN ('archived', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'archived')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'archived'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.archived IS NOT NEW.archived
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'archived' AND OLD.archived IS NOT NEW.archived;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'routine', NEW.id, 'archived' WHERE OLD.archived IS NOT NEW.archived;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'routine', NEW.id, 'created_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'routine' AND row_id = NEW.id AND field IN ('created_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'created_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'created_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.created_at IS NOT NEW.created_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'created_at' AND OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'routine', NEW.id, 'created_at' WHERE OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'routine', NEW.id, 'deleted_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'routine' AND row_id = NEW.id AND field IN ('deleted_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'deleted_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'deleted_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'routine' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.deleted_at IS NOT NEW.deleted_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'routine' AND row_id = NEW.id AND field = 'deleted_at' AND OLD.deleted_at IS NOT NEW.deleted_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'routine', NEW.id, 'deleted_at' WHERE OLD.deleted_at IS NOT NEW.deleted_at;
       DELETE FROM sync_outbox WHERE table_name = 'routine' AND row_id = NEW.id AND field = '+' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'routine', NEW.id, '+' WHERE OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
       INSERT OR IGNORE INTO sync_outbox (table_name, row_id, field) SELECT 'reminder', r.id, '+' FROM reminder r WHERE r.target_type = 'routine' AND r.target_id = NEW.id AND r.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
     END"##),
    ("sync_routine_log_ai", "routine_log", r##"CREATE TRIGGER sync_routine_log_ai AFTER INSERT ON routine_log WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       DELETE FROM sync_tombstone WHERE table_name = 'routine_log' AND row_id = NEW.id;
       DELETE FROM sync_outbox WHERE table_name = 'routine_log' AND row_id = NEW.id AND field = '*';
       INSERT INTO sync_outbox (table_name, row_id, field) VALUES ('routine_log', NEW.id, '*');
     END"##),
    ("sync_routine_log_au", "routine_log", r##"CREATE TRIGGER sync_routine_log_au AFTER UPDATE ON routine_log WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
         SELECT 'routine_log', NEW.id, '*', OLD.hlc, NULL
         WHERE OLD.hlc IS NOT NEW.hlc AND NOT EXISTS (SELECT 1 FROM sync_field_clock WHERE table_name = 'routine_log' AND row_id = NEW.id AND field = '*');
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'routine_log', NEW.id, 'routine_id', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'routine_log' AND row_id = NEW.id AND field IN ('routine_id', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'routine_log' AND row_id = NEW.id AND field = 'routine_id')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'routine_log' AND row_id = NEW.id AND field = 'routine_id'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'routine_log' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.routine_id IS NOT NEW.routine_id
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'routine_log' AND row_id = NEW.id AND field = 'routine_id' AND OLD.routine_id IS NOT NEW.routine_id;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'routine_log', NEW.id, 'routine_id' WHERE OLD.routine_id IS NOT NEW.routine_id;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'routine_log', NEW.id, 'date', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'routine_log' AND row_id = NEW.id AND field IN ('date', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'routine_log' AND row_id = NEW.id AND field = 'date')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'routine_log' AND row_id = NEW.id AND field = 'date'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'routine_log' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.date IS NOT NEW.date
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'routine_log' AND row_id = NEW.id AND field = 'date' AND OLD.date IS NOT NEW.date;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'routine_log', NEW.id, 'date' WHERE OLD.date IS NOT NEW.date;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'routine_log', NEW.id, 'done_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'routine_log' AND row_id = NEW.id AND field IN ('done_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'routine_log' AND row_id = NEW.id AND field = 'done_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'routine_log' AND row_id = NEW.id AND field = 'done_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'routine_log' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.done_at IS NOT NEW.done_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'routine_log' AND row_id = NEW.id AND field = 'done_at' AND OLD.done_at IS NOT NEW.done_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'routine_log', NEW.id, 'done_at' WHERE OLD.done_at IS NOT NEW.done_at;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'routine_log', NEW.id, 'created_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'routine_log' AND row_id = NEW.id AND field IN ('created_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'routine_log' AND row_id = NEW.id AND field = 'created_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'routine_log' AND row_id = NEW.id AND field = 'created_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'routine_log' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.created_at IS NOT NEW.created_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'routine_log' AND row_id = NEW.id AND field = 'created_at' AND OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'routine_log', NEW.id, 'created_at' WHERE OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'routine_log', NEW.id, 'deleted_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'routine_log' AND row_id = NEW.id AND field IN ('deleted_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'routine_log' AND row_id = NEW.id AND field = 'deleted_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'routine_log' AND row_id = NEW.id AND field = 'deleted_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'routine_log' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.deleted_at IS NOT NEW.deleted_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'routine_log' AND row_id = NEW.id AND field = 'deleted_at' AND OLD.deleted_at IS NOT NEW.deleted_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'routine_log', NEW.id, 'deleted_at' WHERE OLD.deleted_at IS NOT NEW.deleted_at;
       DELETE FROM sync_outbox WHERE table_name = 'routine_log' AND row_id = NEW.id AND field = '+' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'routine_log', NEW.id, '+' WHERE OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
     END"##),
    ("sync_routine_pause_ai", "routine_pause", r##"CREATE TRIGGER sync_routine_pause_ai AFTER INSERT ON routine_pause WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       DELETE FROM sync_tombstone WHERE table_name = 'routine_pause' AND row_id = NEW.id;
       DELETE FROM sync_outbox WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field = '*';
       INSERT INTO sync_outbox (table_name, row_id, field) VALUES ('routine_pause', NEW.id, '*');
     END"##),
    ("sync_routine_pause_au", "routine_pause", r##"CREATE TRIGGER sync_routine_pause_au AFTER UPDATE ON routine_pause WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
         SELECT 'routine_pause', NEW.id, '*', OLD.hlc, NULL
         WHERE OLD.hlc IS NOT NEW.hlc AND NOT EXISTS (SELECT 1 FROM sync_field_clock WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field = '*');
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'routine_pause', NEW.id, 'routine_id', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field IN ('routine_id', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field = 'routine_id')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field = 'routine_id'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.routine_id IS NOT NEW.routine_id
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field = 'routine_id' AND OLD.routine_id IS NOT NEW.routine_id;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'routine_pause', NEW.id, 'routine_id' WHERE OLD.routine_id IS NOT NEW.routine_id;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'routine_pause', NEW.id, 'from_date', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field IN ('from_date', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field = 'from_date')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field = 'from_date'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.from_date IS NOT NEW.from_date
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field = 'from_date' AND OLD.from_date IS NOT NEW.from_date;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'routine_pause', NEW.id, 'from_date' WHERE OLD.from_date IS NOT NEW.from_date;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'routine_pause', NEW.id, 'to_date', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field IN ('to_date', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field = 'to_date')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field = 'to_date'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.to_date IS NOT NEW.to_date
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field = 'to_date' AND OLD.to_date IS NOT NEW.to_date;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'routine_pause', NEW.id, 'to_date' WHERE OLD.to_date IS NOT NEW.to_date;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'routine_pause', NEW.id, 'created_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field IN ('created_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field = 'created_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field = 'created_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.created_at IS NOT NEW.created_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field = 'created_at' AND OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'routine_pause', NEW.id, 'created_at' WHERE OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'routine_pause', NEW.id, 'deleted_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field IN ('deleted_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field = 'deleted_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field = 'deleted_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.deleted_at IS NOT NEW.deleted_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field = 'deleted_at' AND OLD.deleted_at IS NOT NEW.deleted_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'routine_pause', NEW.id, 'deleted_at' WHERE OLD.deleted_at IS NOT NEW.deleted_at;
       DELETE FROM sync_outbox WHERE table_name = 'routine_pause' AND row_id = NEW.id AND field = '+' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'routine_pause', NEW.id, '+' WHERE OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
     END"##),
    ("sync_settings_ai", "settings", r##"CREATE TRIGGER sync_settings_ai AFTER INSERT ON settings WHEN NOT EXISTS (SELECT 1 FROM sync_guard) AND NEW.key IN ('appleReminders.create', 'appleReminders.lastPassAt', 'appleReminders.lists', 'appleReminders.pending', 'general.firstWeekday', 'general.locale', 'general.theme', 'general.timeFormat', 'holidays.countries', 'reminders.defaultOffsets', 'reminders.eveningRecap', 'reminders.morningRecap', 'spaces.defaultSpaceId', 'tasks.carryOverUndone', 'today.hideRoutines') BEGIN
       DELETE FROM sync_tombstone WHERE table_name = 'settings' AND row_id = NEW.key;
       DELETE FROM sync_outbox WHERE table_name = 'settings' AND row_id = NEW.key AND field = '*';
       INSERT INTO sync_outbox (table_name, row_id, field) VALUES ('settings', NEW.key, '*');
     END"##),
    ("sync_settings_au", "settings", r##"CREATE TRIGGER sync_settings_au AFTER UPDATE ON settings WHEN NOT EXISTS (SELECT 1 FROM sync_guard) AND NEW.key IN ('appleReminders.create', 'appleReminders.lastPassAt', 'appleReminders.lists', 'appleReminders.pending', 'general.firstWeekday', 'general.locale', 'general.theme', 'general.timeFormat', 'holidays.countries', 'reminders.defaultOffsets', 'reminders.eveningRecap', 'reminders.morningRecap', 'spaces.defaultSpaceId', 'tasks.carryOverUndone', 'today.hideRoutines') BEGIN
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
         SELECT 'settings', NEW.key, '*', OLD.hlc, NULL
         WHERE OLD.hlc IS NOT NEW.hlc AND NOT EXISTS (SELECT 1 FROM sync_field_clock WHERE table_name = 'settings' AND row_id = NEW.key AND field = '*');
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'settings', NEW.key, 'value', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'settings' AND row_id = NEW.key AND field IN ('value', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'settings' AND row_id = NEW.key AND field = 'value')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'settings' AND row_id = NEW.key AND field = 'value'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'settings' AND row_id = NEW.key AND field = '*'), OLD.hlc) END
       WHERE OLD.value IS NOT NEW.value
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'settings' AND row_id = NEW.key AND field = 'value' AND OLD.value IS NOT NEW.value;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'settings', NEW.key, 'value' WHERE OLD.value IS NOT NEW.value;
     END"##),
    ("sync_space_ai", "space", r##"CREATE TRIGGER sync_space_ai AFTER INSERT ON space WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       DELETE FROM sync_tombstone WHERE table_name = 'space' AND row_id = NEW.id;
       DELETE FROM sync_outbox WHERE table_name = 'space' AND row_id = NEW.id AND field = '*';
       INSERT INTO sync_outbox (table_name, row_id, field) VALUES ('space', NEW.id, '*');
     END"##),
    ("sync_space_au", "space", r##"CREATE TRIGGER sync_space_au AFTER UPDATE ON space WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
         SELECT 'space', NEW.id, '*', OLD.hlc, NULL
         WHERE OLD.hlc IS NOT NEW.hlc AND NOT EXISTS (SELECT 1 FROM sync_field_clock WHERE table_name = 'space' AND row_id = NEW.id AND field = '*');
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'space', NEW.id, 'name', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'space' AND row_id = NEW.id AND field IN ('name', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'space' AND row_id = NEW.id AND field = 'name')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'space' AND row_id = NEW.id AND field = 'name'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'space' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.name IS NOT NEW.name
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'space' AND row_id = NEW.id AND field = 'name' AND OLD.name IS NOT NEW.name;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'space', NEW.id, 'name' WHERE OLD.name IS NOT NEW.name;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'space', NEW.id, 'color', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'space' AND row_id = NEW.id AND field IN ('color', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'space' AND row_id = NEW.id AND field = 'color')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'space' AND row_id = NEW.id AND field = 'color'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'space' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.color IS NOT NEW.color
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'space' AND row_id = NEW.id AND field = 'color' AND OLD.color IS NOT NEW.color;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'space', NEW.id, 'color' WHERE OLD.color IS NOT NEW.color;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'space', NEW.id, 'sort_order', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'space' AND row_id = NEW.id AND field IN ('sort_order', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'space' AND row_id = NEW.id AND field = 'sort_order')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'space' AND row_id = NEW.id AND field = 'sort_order'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'space' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.sort_order IS NOT NEW.sort_order
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'space' AND row_id = NEW.id AND field = 'sort_order' AND OLD.sort_order IS NOT NEW.sort_order;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'space', NEW.id, 'sort_order' WHERE OLD.sort_order IS NOT NEW.sort_order;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'space', NEW.id, 'quiet_hours', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'space' AND row_id = NEW.id AND field IN ('quiet_hours', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'space' AND row_id = NEW.id AND field = 'quiet_hours')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'space' AND row_id = NEW.id AND field = 'quiet_hours'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'space' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.quiet_hours IS NOT NEW.quiet_hours
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'space' AND row_id = NEW.id AND field = 'quiet_hours' AND OLD.quiet_hours IS NOT NEW.quiet_hours;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'space', NEW.id, 'quiet_hours' WHERE OLD.quiet_hours IS NOT NEW.quiet_hours;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'space', NEW.id, 'created_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'space' AND row_id = NEW.id AND field IN ('created_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'space' AND row_id = NEW.id AND field = 'created_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'space' AND row_id = NEW.id AND field = 'created_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'space' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.created_at IS NOT NEW.created_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'space' AND row_id = NEW.id AND field = 'created_at' AND OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'space', NEW.id, 'created_at' WHERE OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'space', NEW.id, 'deleted_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'space' AND row_id = NEW.id AND field IN ('deleted_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'space' AND row_id = NEW.id AND field = 'deleted_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'space' AND row_id = NEW.id AND field = 'deleted_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'space' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.deleted_at IS NOT NEW.deleted_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'space' AND row_id = NEW.id AND field = 'deleted_at' AND OLD.deleted_at IS NOT NEW.deleted_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'space', NEW.id, 'deleted_at' WHERE OLD.deleted_at IS NOT NEW.deleted_at;
       DELETE FROM sync_outbox WHERE table_name = 'space' AND row_id = NEW.id AND field = '+' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'space', NEW.id, '+' WHERE OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
     END"##),
    ("sync_task_ai", "task", r##"CREATE TRIGGER sync_task_ai AFTER INSERT ON task WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       DELETE FROM sync_tombstone WHERE table_name = 'task' AND row_id = NEW.id;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = '*';
       INSERT INTO sync_outbox (table_name, row_id, field) VALUES ('task', NEW.id, '*');
     END"##),
    ("sync_task_au", "task", r##"CREATE TRIGGER sync_task_au AFTER UPDATE ON task WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
         SELECT 'task', NEW.id, '*', OLD.hlc, NULL
         WHERE OLD.hlc IS NOT NEW.hlc AND NOT EXISTS (SELECT 1 FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*');
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'space_id', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('space_id', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'space_id')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'space_id'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.space_id IS NOT NEW.space_id
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'space_id' AND OLD.space_id IS NOT NEW.space_id;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'space_id' WHERE OLD.space_id IS NOT NEW.space_id;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'project_id', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('project_id', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'project_id')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'project_id'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.project_id IS NOT NEW.project_id
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'project_id' AND OLD.project_id IS NOT NEW.project_id;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'project_id' WHERE OLD.project_id IS NOT NEW.project_id;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'title', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('title', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'title')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'title'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.title IS NOT NEW.title
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'title' AND OLD.title IS NOT NEW.title;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'title' WHERE OLD.title IS NOT NEW.title;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'note', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('note', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'note')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'note'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.note IS NOT NEW.note
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'note' AND OLD.note IS NOT NEW.note;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'note' WHERE OLD.note IS NOT NEW.note;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'date', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('date', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'date')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'date'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.date IS NOT NEW.date
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'date' AND OLD.date IS NOT NEW.date;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'date' WHERE OLD.date IS NOT NEW.date;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'time', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('time', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'time')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'time'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.time IS NOT NEW.time
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'time' AND OLD.time IS NOT NEW.time;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'time' WHERE OLD.time IS NOT NEW.time;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'status', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('status', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'status')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'status'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.status IS NOT NEW.status
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'status' AND OLD.status IS NOT NEW.status;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'status' WHERE OLD.status IS NOT NEW.status;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'done_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('done_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'done_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'done_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.done_at IS NOT NEW.done_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'done_at' AND OLD.done_at IS NOT NEW.done_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'done_at' WHERE OLD.done_at IS NOT NEW.done_at;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'sort_order', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('sort_order', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'sort_order')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'sort_order'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.sort_order IS NOT NEW.sort_order
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'sort_order' AND OLD.sort_order IS NOT NEW.sort_order;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'sort_order' WHERE OLD.sort_order IS NOT NEW.sort_order;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'carried_over', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('carried_over', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'carried_over')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'carried_over'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.carried_over IS NOT NEW.carried_over
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'carried_over' AND OLD.carried_over IS NOT NEW.carried_over;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'carried_over' WHERE OLD.carried_over IS NOT NEW.carried_over;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'recurrence_id', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('recurrence_id', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'recurrence_id')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'recurrence_id'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.recurrence_id IS NOT NEW.recurrence_id
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'recurrence_id' AND OLD.recurrence_id IS NOT NEW.recurrence_id;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'recurrence_id' WHERE OLD.recurrence_id IS NOT NEW.recurrence_id;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'series_index', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('series_index', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'series_index')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'series_index'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.series_index IS NOT NEW.series_index
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'series_index' AND OLD.series_index IS NOT NEW.series_index;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'series_index' WHERE OLD.series_index IS NOT NEW.series_index;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'goal_id', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('goal_id', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'goal_id')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'goal_id'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.goal_id IS NOT NEW.goal_id
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'goal_id' AND OLD.goal_id IS NOT NEW.goal_id;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'goal_id' WHERE OLD.goal_id IS NOT NEW.goal_id;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'icon', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('icon', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'icon')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'icon'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.icon IS NOT NEW.icon
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'icon' AND OLD.icon IS NOT NEW.icon;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'icon' WHERE OLD.icon IS NOT NEW.icon;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'someday', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('someday', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'someday')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'someday'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.someday IS NOT NEW.someday
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'someday' AND OLD.someday IS NOT NEW.someday;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'someday' WHERE OLD.someday IS NOT NEW.someday;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'source', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('source', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'source')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'source'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.source IS NOT NEW.source
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'source' AND OLD.source IS NOT NEW.source;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'source' WHERE OLD.source IS NOT NEW.source;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'external_id', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('external_id', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'external_id')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'external_id'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.external_id IS NOT NEW.external_id
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'external_id' AND OLD.external_id IS NOT NEW.external_id;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'external_id' WHERE OLD.external_id IS NOT NEW.external_id;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'series_template', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('series_template', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'series_template')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'series_template'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.series_template IS NOT NEW.series_template
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'series_template' AND OLD.series_template IS NOT NEW.series_template;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'series_template' WHERE OLD.series_template IS NOT NEW.series_template;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'external_event_id', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('external_event_id', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'external_event_id')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'external_event_id'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.external_event_id IS NOT NEW.external_event_id
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'external_event_id' AND OLD.external_event_id IS NOT NEW.external_event_id;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'external_event_id' WHERE OLD.external_event_id IS NOT NEW.external_event_id;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'apple_list_id', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('apple_list_id', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'apple_list_id')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'apple_list_id'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.apple_list_id IS NOT NEW.apple_list_id
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'apple_list_id' AND OLD.apple_list_id IS NOT NEW.apple_list_id;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'apple_list_id' WHERE OLD.apple_list_id IS NOT NEW.apple_list_id;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'apple_recurring', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('apple_recurring', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'apple_recurring')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'apple_recurring'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.apple_recurring IS NOT NEW.apple_recurring
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'apple_recurring' AND OLD.apple_recurring IS NOT NEW.apple_recurring;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'apple_recurring' WHERE OLD.apple_recurring IS NOT NEW.apple_recurring;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'created_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('created_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'created_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'created_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.created_at IS NOT NEW.created_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'created_at' AND OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'created_at' WHERE OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'deleted_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('deleted_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'deleted_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'deleted_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.deleted_at IS NOT NEW.deleted_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'deleted_at' AND OLD.deleted_at IS NOT NEW.deleted_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'deleted_at' WHERE OLD.deleted_at IS NOT NEW.deleted_at;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = '+' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, '+' WHERE OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
       INSERT OR IGNORE INTO sync_outbox (table_name, row_id, field) SELECT 'reminder', r.id, '+' FROM reminder r WHERE r.target_type = 'task' AND r.target_id = NEW.id AND r.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
     END"##),
];

/// Corps de déclencheurs remplacés par une migration ultérieure, valables pour une base dont la version de schéma est dans `[since, until)` :
/// (nom, table, SQL, since, until). Une sauvegarde de version 17 porte ceux de la migration 0015 (capture de `task` et de `settings` sans les Rappels
/// Apple) ; elle doit être admise, et recréée avec ces corps (jamais un corps qui cite une colonne absente de la sauvegarde). La migration 0018
/// les remplace à l'ouverture (ADR 0008 §10.2, solde la dette « Lot P » des déclencheurs).
pub const SUPERSEDED_TRIGGERS: [(&str, &str, &str, u32, u32); 3] = [
    ("sync_settings_ai", "settings", r##"CREATE TRIGGER sync_settings_ai AFTER INSERT ON settings WHEN NOT EXISTS (SELECT 1 FROM sync_guard) AND NEW.key IN ('general.firstWeekday', 'general.locale', 'general.theme', 'general.timeFormat', 'holidays.countries', 'reminders.defaultOffsets', 'reminders.eveningRecap', 'reminders.morningRecap', 'spaces.defaultSpaceId', 'tasks.carryOverUndone', 'today.hideRoutines') BEGIN
       DELETE FROM sync_tombstone WHERE table_name = 'settings' AND row_id = NEW.key;
       DELETE FROM sync_outbox WHERE table_name = 'settings' AND row_id = NEW.key AND field = '*';
       INSERT INTO sync_outbox (table_name, row_id, field) VALUES ('settings', NEW.key, '*');
     END"##, 15, 18),
    ("sync_settings_au", "settings", r##"CREATE TRIGGER sync_settings_au AFTER UPDATE ON settings WHEN NOT EXISTS (SELECT 1 FROM sync_guard) AND NEW.key IN ('general.firstWeekday', 'general.locale', 'general.theme', 'general.timeFormat', 'holidays.countries', 'reminders.defaultOffsets', 'reminders.eveningRecap', 'reminders.morningRecap', 'spaces.defaultSpaceId', 'tasks.carryOverUndone', 'today.hideRoutines') BEGIN
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
         SELECT 'settings', NEW.key, '*', OLD.hlc, NULL
         WHERE OLD.hlc IS NOT NEW.hlc AND NOT EXISTS (SELECT 1 FROM sync_field_clock WHERE table_name = 'settings' AND row_id = NEW.key AND field = '*');
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'settings', NEW.key, 'value', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'settings' AND row_id = NEW.key AND field IN ('value', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'settings' AND row_id = NEW.key AND field = 'value')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'settings' AND row_id = NEW.key AND field = 'value'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'settings' AND row_id = NEW.key AND field = '*'), OLD.hlc) END
       WHERE OLD.value IS NOT NEW.value
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'settings' AND row_id = NEW.key AND field = 'value' AND OLD.value IS NOT NEW.value;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'settings', NEW.key, 'value' WHERE OLD.value IS NOT NEW.value;
     END"##, 15, 18),
    ("sync_task_au", "task", r##"CREATE TRIGGER sync_task_au AFTER UPDATE ON task WHEN NOT EXISTS (SELECT 1 FROM sync_guard) BEGIN
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
         SELECT 'task', NEW.id, '*', OLD.hlc, NULL
         WHERE OLD.hlc IS NOT NEW.hlc AND NOT EXISTS (SELECT 1 FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*');
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'space_id', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('space_id', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'space_id')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'space_id'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.space_id IS NOT NEW.space_id
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'space_id' AND OLD.space_id IS NOT NEW.space_id;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'space_id' WHERE OLD.space_id IS NOT NEW.space_id;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'project_id', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('project_id', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'project_id')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'project_id'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.project_id IS NOT NEW.project_id
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'project_id' AND OLD.project_id IS NOT NEW.project_id;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'project_id' WHERE OLD.project_id IS NOT NEW.project_id;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'title', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('title', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'title')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'title'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.title IS NOT NEW.title
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'title' AND OLD.title IS NOT NEW.title;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'title' WHERE OLD.title IS NOT NEW.title;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'note', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('note', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'note')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'note'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.note IS NOT NEW.note
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'note' AND OLD.note IS NOT NEW.note;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'note' WHERE OLD.note IS NOT NEW.note;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'date', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('date', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'date')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'date'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.date IS NOT NEW.date
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'date' AND OLD.date IS NOT NEW.date;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'date' WHERE OLD.date IS NOT NEW.date;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'time', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('time', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'time')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'time'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.time IS NOT NEW.time
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'time' AND OLD.time IS NOT NEW.time;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'time' WHERE OLD.time IS NOT NEW.time;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'status', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('status', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'status')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'status'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.status IS NOT NEW.status
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'status' AND OLD.status IS NOT NEW.status;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'status' WHERE OLD.status IS NOT NEW.status;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'done_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('done_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'done_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'done_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.done_at IS NOT NEW.done_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'done_at' AND OLD.done_at IS NOT NEW.done_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'done_at' WHERE OLD.done_at IS NOT NEW.done_at;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'sort_order', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('sort_order', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'sort_order')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'sort_order'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.sort_order IS NOT NEW.sort_order
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'sort_order' AND OLD.sort_order IS NOT NEW.sort_order;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'sort_order' WHERE OLD.sort_order IS NOT NEW.sort_order;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'carried_over', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('carried_over', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'carried_over')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'carried_over'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.carried_over IS NOT NEW.carried_over
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'carried_over' AND OLD.carried_over IS NOT NEW.carried_over;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'carried_over' WHERE OLD.carried_over IS NOT NEW.carried_over;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'recurrence_id', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('recurrence_id', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'recurrence_id')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'recurrence_id'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.recurrence_id IS NOT NEW.recurrence_id
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'recurrence_id' AND OLD.recurrence_id IS NOT NEW.recurrence_id;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'recurrence_id' WHERE OLD.recurrence_id IS NOT NEW.recurrence_id;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'series_index', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('series_index', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'series_index')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'series_index'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.series_index IS NOT NEW.series_index
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'series_index' AND OLD.series_index IS NOT NEW.series_index;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'series_index' WHERE OLD.series_index IS NOT NEW.series_index;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'goal_id', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('goal_id', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'goal_id')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'goal_id'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.goal_id IS NOT NEW.goal_id
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'goal_id' AND OLD.goal_id IS NOT NEW.goal_id;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'goal_id' WHERE OLD.goal_id IS NOT NEW.goal_id;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'icon', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('icon', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'icon')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'icon'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.icon IS NOT NEW.icon
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'icon' AND OLD.icon IS NOT NEW.icon;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'icon' WHERE OLD.icon IS NOT NEW.icon;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'someday', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('someday', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'someday')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'someday'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.someday IS NOT NEW.someday
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'someday' AND OLD.someday IS NOT NEW.someday;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'someday' WHERE OLD.someday IS NOT NEW.someday;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'source', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('source', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'source')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'source'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.source IS NOT NEW.source
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'source' AND OLD.source IS NOT NEW.source;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'source' WHERE OLD.source IS NOT NEW.source;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'external_id', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('external_id', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'external_id')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'external_id'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.external_id IS NOT NEW.external_id
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'external_id' AND OLD.external_id IS NOT NEW.external_id;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'external_id' WHERE OLD.external_id IS NOT NEW.external_id;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'series_template', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('series_template', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'series_template')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'series_template'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.series_template IS NOT NEW.series_template
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'series_template' AND OLD.series_template IS NOT NEW.series_template;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'series_template' WHERE OLD.series_template IS NOT NEW.series_template;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'external_event_id', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('external_event_id', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'external_event_id')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'external_event_id'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.external_event_id IS NOT NEW.external_event_id
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'external_event_id' AND OLD.external_event_id IS NOT NEW.external_event_id;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'external_event_id' WHERE OLD.external_event_id IS NOT NEW.external_event_id;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'created_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('created_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'created_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'created_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.created_at IS NOT NEW.created_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'created_at' AND OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'created_at' WHERE OLD.created_at IS NOT NEW.created_at;
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT 'task', NEW.id, 'deleted_at', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('deleted_at', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'deleted_at')
           ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = 'deleted_at'), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
       WHERE OLD.deleted_at IS NOT NEW.deleted_at
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = 'deleted_at' AND OLD.deleted_at IS NOT NEW.deleted_at;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, 'deleted_at' WHERE OLD.deleted_at IS NOT NEW.deleted_at;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = '+' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
       INSERT INTO sync_outbox (table_name, row_id, field) SELECT 'task', NEW.id, '+' WHERE OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
       INSERT OR IGNORE INTO sync_outbox (table_name, row_id, field) SELECT 'reminder', r.id, '+' FROM reminder r WHERE r.target_type = 'task' AND r.target_id = NEW.id AND r.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;
     END"##, 15, 18),
];

/// Version de schéma à partir de laquelle le corps de référence actuel est valable : 18 pour les trois déclencheurs remplacés par la migration 0018
/// (`sync_task_au`, `sync_settings_ai`, `sync_settings_au`), 1 pour les autres (leur corps n'a jamais changé ; une sauvegarde plus ancienne peut
/// en avoir moins, jamais de différent).
pub fn introduced_in(name: &str) -> u32 {
    match name {
        "sync_task_au" | "sync_settings_ai" | "sync_settings_au" => 18,
        _ => 1,
    }
}

/// Corps admis pour ce déclencheur dans une base de cette version de schéma : un corps remplacé valable à cette version, sinon le corps de
/// référence s'il existe déjà à cette version ; `None` : déclencheur inconnu ou pas encore introduit (la sauvegarde est refusée).
pub fn trigger_body_for(name: &str, table: &str, version: u32) -> Option<&'static str> {
    if let Some((_, _, sql, _, _)) = SUPERSEDED_TRIGGERS.iter().find(|(n, t, _, since, until)| *n == name && *t == table && version >= *since && version < *until) {
        return Some(sql);
    }
    REFERENCE_TRIGGERS.iter().find(|(n, t, _)| *n == name && *t == table).filter(|_| version >= introduced_in(name)).map(|(_, _, sql)| *sql)
}
