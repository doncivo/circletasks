// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

#[cfg(feature = "sqlite")]
use std::fs::create_dir_all;

use indexmap::IndexMap;
use serde_json::Value as JsonValue;
#[cfg(any(feature = "sqlite", feature = "mysql", feature = "postgres"))]
use sqlx::{Column, Executor, Pool, Row, migrate::MigrateDatabase};
#[cfg(any(feature = "sqlite", feature = "mysql", feature = "postgres"))]
use tauri::Manager;
use tauri::{AppHandle, Runtime};

#[cfg(feature = "mysql")]
use sqlx::MySql;
#[cfg(feature = "postgres")]
use sqlx::Postgres;
#[cfg(feature = "sqlite")]
use sqlx::Sqlite;

use crate::LastInsertId;

/// A connection pool for one of the supported database drivers.
///
/// The variant is picked from the scheme of the connection string
/// (`sqlite:`, `mysql:` or `postgres:`) and only the variants whose Cargo
/// feature is enabled exist.
pub enum DbPool {
    /// A SQLite connection pool. Only available with the `sqlite` Cargo feature.
    #[cfg(feature = "sqlite")]
    Sqlite(Pool<Sqlite>),
    /// A MySQL connection pool. Only available with the `mysql` Cargo feature.
    #[cfg(feature = "mysql")]
    MySql(Pool<MySql>),
    /// A PostgreSQL connection pool. Only available with the `postgres` Cargo feature.
    #[cfg(feature = "postgres")]
    Postgres(Pool<Postgres>),
    /// Placeholder used when none of the `sqlite`, `mysql` and `postgres` Cargo
    /// features is enabled. Connecting always fails and every other operation is a no-op.
    #[cfg(not(any(feature = "sqlite", feature = "mysql", feature = "postgres")))]
    None,
}

// public methods
/* impl DbPool {
    /// Get the inner Sqlite Pool. Returns None for MySql and Postgres pools.
    #[cfg(feature = "sqlite")]
    pub fn sqlite(&self) -> Option<&Pool<Sqlite>> {
        match self {
            DbPool::Sqlite(pool) => Some(pool),
            _ => None,
        }
    }

    /// Get the inner MySql Pool. Returns None for Sqlite and Postgres pools.
    #[cfg(feature = "mysql")]
    pub fn mysql(&self) -> Option<&Pool<MySql>> {
        match self {
            DbPool::MySql(pool) => Some(pool),
            _ => None,
        }
    }

    /// Get the inner Postgres Pool. Returns None for MySql and Sqlite pools.
    #[cfg(feature = "postgres")]
    pub fn postgres(&self) -> Option<&Pool<Postgres>> {
        match self {
            DbPool::Postgres(pool) => Some(pool),
            _ => None,
        }
    }
} */

// private methods
impl DbPool {
    pub(crate) async fn connect<R: Runtime>(
        conn_url: &str,
        _app: &AppHandle<R>,
    ) -> Result<Self, crate::Error> {
        match conn_url
            .split_once(':')
            .ok_or_else(|| crate::Error::InvalidDbUrl(conn_url.to_string()))?
            .0
        {
            #[cfg(feature = "sqlite")]
            "sqlite" => {
                let app_path = _app
                    .path()
                    .app_config_dir()
                    .expect("No App config path was found!");

                create_dir_all(&app_path).expect("Couldn't create app config dir");

                let conn_url = &path_mapper(app_path, conn_url);

                if !Sqlite::database_exists(conn_url).await.unwrap_or(false) {
                    Sqlite::create_database(conn_url).await?;
                }
                Ok(Self::Sqlite(open_sqlite_pool(conn_url).await?))
            }
            #[cfg(feature = "mysql")]
            "mysql" => {
                if !MySql::database_exists(conn_url).await.unwrap_or(false) {
                    MySql::create_database(conn_url).await?;
                }
                Ok(Self::MySql(Pool::connect(conn_url).await?))
            }
            #[cfg(feature = "postgres")]
            "postgres" => {
                if !Postgres::database_exists(conn_url).await.unwrap_or(false) {
                    Postgres::create_database(conn_url).await?;
                }
                Ok(Self::Postgres(Pool::connect(conn_url).await?))
            }
            #[cfg(not(any(feature = "sqlite", feature = "postgres", feature = "mysql")))]
            _ => Err(crate::Error::InvalidDbUrl(format!(
                "{conn_url} - No database driver enabled!"
            ))),
            #[cfg(any(feature = "sqlite", feature = "postgres", feature = "mysql"))]
            _ => Err(crate::Error::InvalidDbUrl(conn_url.to_string())),
        }
    }

    pub(crate) async fn migrate(
        &self,
        _migrator: &sqlx::migrate::Migrator,
    ) -> Result<(), crate::Error> {
        match self {
            #[cfg(feature = "sqlite")]
            DbPool::Sqlite(pool) => _migrator.run(pool).await?,
            #[cfg(feature = "mysql")]
            DbPool::MySql(pool) => _migrator.run(pool).await?,
            #[cfg(feature = "postgres")]
            DbPool::Postgres(pool) => _migrator.run(pool).await?,
            #[cfg(not(any(feature = "sqlite", feature = "mysql", feature = "postgres")))]
            DbPool::None => (),
        }
        Ok(())
    }

    pub(crate) async fn close(&self) {
        match self {
            #[cfg(feature = "sqlite")]
            DbPool::Sqlite(pool) => pool.close().await,
            #[cfg(feature = "mysql")]
            DbPool::MySql(pool) => pool.close().await,
            #[cfg(feature = "postgres")]
            DbPool::Postgres(pool) => pool.close().await,
            #[cfg(not(any(feature = "sqlite", feature = "mysql", feature = "postgres")))]
            DbPool::None => (),
        }
    }

    pub(crate) async fn execute(
        &self,
        _query: String,
        _values: Vec<JsonValue>,
    ) -> Result<(u64, LastInsertId), crate::Error> {
        Ok(match self {
            #[cfg(feature = "sqlite")]
            DbPool::Sqlite(pool) => {
                let mut query = sqlx::query(&_query);
                for value in _values {
                    if value.is_null() {
                        query = query.bind(None::<JsonValue>);
                    } else if value.is_string() {
                        query = query.bind(value.as_str().unwrap().to_owned())
                    } else if let Some(number) = value.as_number() {
                        query = query.bind(number.as_f64().unwrap_or_default())
                    } else {
                        query = query.bind(value);
                    }
                }
                let result = pool.execute(query).await?;
                (
                    result.rows_affected(),
                    LastInsertId::Sqlite(result.last_insert_rowid()),
                )
            }
            #[cfg(feature = "mysql")]
            DbPool::MySql(pool) => {
                let mut query = sqlx::query(&_query);
                for value in _values {
                    if value.is_null() {
                        query = query.bind(None::<JsonValue>);
                    } else if value.is_string() {
                        query = query.bind(value.as_str().unwrap().to_owned())
                    } else if let Some(number) = value.as_number() {
                        query = query.bind(number.as_f64().unwrap_or_default())
                    } else {
                        query = query.bind(value);
                    }
                }
                let result = pool.execute(query).await?;
                (
                    result.rows_affected(),
                    LastInsertId::MySql(result.last_insert_id()),
                )
            }
            #[cfg(feature = "postgres")]
            DbPool::Postgres(pool) => {
                let mut query = sqlx::query(&_query);
                for value in _values {
                    if value.is_null() {
                        query = query.bind(None::<JsonValue>);
                    } else if value.is_string() {
                        query = query.bind(value.as_str().unwrap().to_owned())
                    } else if let Some(number) = value.as_number() {
                        query = query.bind(number.as_f64().unwrap_or_default())
                    } else {
                        query = query.bind(value);
                    }
                }
                let result = pool.execute(query).await?;
                (result.rows_affected(), LastInsertId::Postgres(()))
            }
            #[cfg(not(any(feature = "sqlite", feature = "mysql", feature = "postgres")))]
            DbPool::None => (0, LastInsertId::None),
        })
    }

    pub(crate) async fn select(
        &self,
        _query: String,
        _values: Vec<JsonValue>,
    ) -> Result<Vec<IndexMap<String, JsonValue>>, crate::Error> {
        Ok(match self {
            #[cfg(feature = "sqlite")]
            DbPool::Sqlite(pool) => {
                let mut query = sqlx::query(&_query);
                for value in _values {
                    if value.is_null() {
                        query = query.bind(None::<JsonValue>);
                    } else if value.is_string() {
                        query = query.bind(value.as_str().unwrap().to_owned())
                    } else if let Some(number) = value.as_number() {
                        query = query.bind(number.as_f64().unwrap_or_default())
                    } else {
                        query = query.bind(value);
                    }
                }
                let rows = pool.fetch_all(query).await?;
                let mut values = Vec::new();
                for row in rows {
                    let mut value = IndexMap::default();
                    for (i, column) in row.columns().iter().enumerate() {
                        let v = row.try_get_raw(i)?;

                        let v = crate::decode::sqlite::to_json(v)?;

                        value.insert(column.name().to_string(), v);
                    }

                    values.push(value);
                }
                values
            }
            #[cfg(feature = "mysql")]
            DbPool::MySql(pool) => {
                let mut query = sqlx::query(&_query);
                for value in _values {
                    if value.is_null() {
                        query = query.bind(None::<JsonValue>);
                    } else if value.is_string() {
                        query = query.bind(value.as_str().unwrap().to_owned())
                    } else if let Some(number) = value.as_number() {
                        query = query.bind(number.as_f64().unwrap_or_default())
                    } else {
                        query = query.bind(value);
                    }
                }
                let rows = pool.fetch_all(query).await?;
                let mut values = Vec::new();
                for row in rows {
                    let mut value = IndexMap::default();
                    for (i, column) in row.columns().iter().enumerate() {
                        let v = row.try_get_raw(i)?;

                        let v = crate::decode::mysql::to_json(v)?;

                        value.insert(column.name().to_string(), v);
                    }

                    values.push(value);
                }
                values
            }
            #[cfg(feature = "postgres")]
            DbPool::Postgres(pool) => {
                let mut query = sqlx::query(&_query);
                for value in _values {
                    if value.is_null() {
                        query = query.bind(None::<JsonValue>);
                    } else if value.is_string() {
                        query = query.bind(value.as_str().unwrap().to_owned())
                    } else if let Some(number) = value.as_number() {
                        query = query.bind(number.as_f64().unwrap_or_default())
                    } else {
                        query = query.bind(value);
                    }
                }
                let rows = pool.fetch_all(query).await?;
                let mut values = Vec::new();
                for row in rows {
                    let mut value = IndexMap::default();
                    for (i, column) in row.columns().iter().enumerate() {
                        let v = row.try_get_raw(i)?;

                        let v = crate::decode::postgres::to_json(v)?;

                        value.insert(column.name().to_string(), v);
                    }

                    values.push(value);
                }
                values
            }
            #[cfg(not(any(feature = "sqlite", feature = "mysql", feature = "postgres")))]
            DbPool::None => Vec::new(),
        })
    }
}

#[cfg(feature = "sqlite")]
/// Maps the user supplied DB connection string to a connection string
/// with a fully qualified file path to the App's designed "app_path"
fn path_mapper(mut app_path: std::path::PathBuf, connection_string: &str) -> String {
    app_path.push(
        connection_string
            .split_once(':')
            .expect("Couldn't parse the connection string for DB!")
            .1,
    );

    format!(
        "sqlite:{}",
        app_path
            .to_str()
            .expect("Problem creating fully qualified path to Database file!")
    )
}

/// CircleTasks : pool SQLite a UNE seule connexion, mode WAL des l'ouverture.
///
/// Pourquoi : le front envoie `BEGIN IMMEDIATE`, les ecritures puis `COMMIT` comme des appels separes et les attend un a un. Avec le
/// pool d'origine (`Pool::connect` : 10 connexions), la connexion d'un appel est rendue au pool par une tache asynchrone
/// (sqlx-core `PoolConnection::drop` -> `rt::spawn(return_to_pool)`, qui fait encore un `ping().await`) : l'appel suivant, arrive
/// avant ce retour, ouvre une 2e connexion, dont l'ecriture se heurte au verrou de la transaction de la 1re -> code 5
/// « database is locked » apres `busy_timeout`. Avec `max_connections(1)`, l'appel suivant attend le permis du pool, rendu
/// seulement APRES le retour de la connexion dans la file : une seule connexion, jamais deux. Connexion jamais recyclee
/// (`idle_timeout` et `max_lifetime` desactives) pour qu'aucune reconnexion ne survienne entre deux appels d'une transaction.
///
/// Cas restant : si le `ping` de retour au pool echoue en pleine transaction, sqlx ferme cette connexion et en ouvre une neuve ; les
/// ecritures suivantes sont alors validees une a une (hors transaction), puis le `COMMIT` echoue « no transaction is active ». Le
/// front (`serializedDriver.ts`) le traite en echec visible `transaction-lost`, jamais rattrape en silence.
#[cfg(feature = "sqlite")]
pub async fn open_sqlite_pool(conn_url: &str) -> Result<Pool<Sqlite>, sqlx::Error> {
    use std::str::FromStr;

    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

    let options = SqliteConnectOptions::from_str(conn_url)?.journal_mode(SqliteJournalMode::Wal).foreign_keys(true);
    SqlitePoolOptions::new()
        .max_connections(1)
        .min_connections(0)
        .idle_timeout(None)
        .max_lifetime(None)
        .connect_with(options)
        .await
}

#[cfg(all(test, feature = "sqlite"))]
mod tests {
    use super::*;

    /// Appels strictement séquentiels (comme le front, qui sérialise ses appels) : `BEGIN IMMEDIATE`, écritures, `COMMIT` doivent
    /// passer par UNE connexion. Avec un pool de 10 connexions, la connexion est rendue au pool par une tâche asynchrone
    /// (sqlx-core `PoolConnection::drop` -> `rt::spawn(return_to_pool)`) : l'appel suivant peut ouvrir une 2e connexion, dont
    /// l'écriture se heurte au verrou de la 1re (code 5, « database is locked »).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pool_has_one_connection_in_wal_mode() {
        let dir = tempfile::Builder::new().prefix("db-wal-").tempdir_in(concat!(env!("CARGO_MANIFEST_DIR"), "/../../target")).unwrap();
        let url = format!("sqlite:{}", dir.path().join("t.db").to_str().unwrap());
        Sqlite::create_database(&url).await.unwrap();
        let pool = open_sqlite_pool(&url).await.unwrap();
        assert_eq!(pool.options().get_max_connections(), 1);
        let db = DbPool::Sqlite(pool);
        let rows = db.select("PRAGMA journal_mode".to_string(), vec![]).await.unwrap();
        assert_eq!(rows[0]["journal_mode"], JsonValue::String("wal".into()));
        db.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn sequential_transactions_never_lock_themselves() {
        let dir = tempfile::Builder::new()
            .prefix("db-lock-")
            .tempdir_in(concat!(env!("CARGO_MANIFEST_DIR"), "/../../target"))
            .expect("dossier de test dans target/");
        let url = format!("sqlite:{}", dir.path().join("t.db").to_str().unwrap());
        Sqlite::create_database(&url).await.unwrap();
        let db = DbPool::Sqlite(open_sqlite_pool(&url).await.unwrap());
        let run = |sql: &'static str| db.execute(sql.to_string(), vec![]);
        run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)").await.unwrap();
        for i in 0..300 {
            run("BEGIN IMMEDIATE").await.unwrap_or_else(|e| panic!("BEGIN {i} : {e}"));
            run("INSERT INTO t (v) VALUES ('a')").await.unwrap_or_else(|e| panic!("INSERT a {i} : {e}"));
            run("INSERT INTO t (v) VALUES ('b')").await.unwrap_or_else(|e| panic!("INSERT b {i} : {e}"));
            run("COMMIT").await.unwrap_or_else(|e| panic!("COMMIT {i} : {e}"));
        }
        db.close().await;
    }
}
