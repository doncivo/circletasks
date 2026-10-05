//! Définitions de référence des déclencheurs de l'app (index de recherche, migration 0011), telles que SQLite les enregistre dans
//! `sqlite_master` après les migrations. Elles servent (1) à refuser une sauvegarde dont un déclencheur a un corps modifié et (2) à recréer les
//! déclencheurs après une restauration. `src/platform/backup/triggers.test.ts` vérifie qu'elles sont identiques à celles des migrations :
//! à régénérer avec ce test si la migration 0011 change (jamais, une migration publiée ne se modifie plus) ou si un déclencheur est ajouté.

/// (nom, table, SQL) de chaque déclencheur, triés par nom.
pub const REFERENCE_TRIGGERS: [(&str, &str, &str); 18] = [
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
];
