// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use indexmap::IndexMap;
use serde_json::Value as JsonValue;
use sqlx::migrate::Migrator;
use tauri::{AppHandle, Runtime, State, command};

use crate::{DbInstances, DbPool, Error, LastInsertId, Migrations};

#[command]
pub(crate) async fn load<R: Runtime>(
    app: AppHandle<R>,
    db_instances: State<'_, DbInstances>,
    migrations: State<'_, Migrations>,
    db: String,
) -> Result<String, crate::Error> {
    // CircleTasks (SEC-01) : première instruction de `load`, avant tout accès au disque.
    crate::guard::validate_db_url(&db)?;
    close_previous(&db_instances, &db).await;
    let pool = DbPool::connect(&db, &app).await?;

    if let Some(migrations) = migrations.0.lock().await.remove(&db) {
        let migrator = Migrator::new(migrations).await?;
        pool.migrate(&migrator).await?;
    }

    db_instances.0.write().await.insert(db.clone(), pool);

    Ok(db)
}

/// Allows the database connection(s) to be closed; if no database
/// name is passed in then _all_ database connection pools will be
/// shut down.
#[command]
pub(crate) async fn close(
    db_instances: State<'_, DbInstances>,
    db: Option<String>,
) -> Result<bool, crate::Error> {
    let instances = db_instances.0.read().await;

    let pools = if let Some(db) = db {
        vec![db]
    } else {
        instances.keys().cloned().collect()
    };

    for pool in pools {
        let db = instances.get(&pool).ok_or(Error::DatabaseNotLoaded(pool))?;
        db.close().await;
    }

    Ok(true)
}

/// Execute a command against the database
#[command]
pub(crate) async fn execute(
    db_instances: State<'_, DbInstances>,
    db: String,
    query: String,
    values: Vec<JsonValue>,
) -> Result<(u64, LastInsertId), crate::Error> {
    let instances = db_instances.0.read().await;

    let db = instances.get(&db).ok_or(Error::DatabaseNotLoaded(db))?;
    db.execute(query, values).await
}

#[command]
pub(crate) async fn select(
    db_instances: State<'_, DbInstances>,
    db: String,
    query: String,
    values: Vec<JsonValue>,
) -> Result<Vec<IndexMap<String, JsonValue>>, crate::Error> {
    let instances = db_instances.0.read().await;

    let db = instances.get(&db).ok_or(Error::DatabaseNotLoaded(db))?;
    db.select(query, values).await
}

/// CircleTasks (SEC-01, audit M3) : un second `load` de la même base ferme d'abord le pool précédent au lieu de le laisser orphelin avec
/// sa connexion ouverte (verrous WAL, deuxième connexion sur le fichier). Il n'est PAS refusé : le front recharge sa WebView
/// (`window.location.reload()`, `src/platform/relaunch.ts`, verrouillage, oubli de synchro) sans redémarrer le processus Rust, puis
/// rappelle `load` alors que l'ancien pool est encore enregistré ; un refus empêcherait toute réouverture jusqu'au redémarrage.
pub(crate) async fn close_previous(instances: &DbInstances, db: &str) {
    let previous = instances.0.write().await.remove(db);
    if let Some(previous) = previous {
        previous.close().await;
    }
}
