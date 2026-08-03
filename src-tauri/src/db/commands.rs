use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use super::{
    elasticsearch::ElasticsearchDriver, mongodb::MongoDbDriver, mysql::MySqlDriver,
    postgres::PostgresDriver, ConnectionConfig, ConnectionManager, DatabaseDriver, DatabaseType,
    DbError, QueryResult, SchemaTree,
};

#[derive(Default)]
pub struct DatabaseState {
    pub connections: ConnectionManager,
    cancellations: RwLock<HashMap<String, CancellationToken>>,
    pub(crate) schema_cache: RwLock<HashMap<String, SchemaTree>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QueryLogEvent {
    query_id: String,
    level: &'static str,
    message: String,
}

fn emit_query_log(app: &AppHandle, query_id: &str, level: &'static str, message: String) {
    let _ = app.emit(
        "query-log",
        QueryLogEvent {
            query_id: query_id.to_owned(),
            level,
            message,
        },
    );
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    ConnectionFailed,
    SshHostKeyUnknown,
    QueryFailed,
    SchemaFailed,
    ConnectionNotFound,
    ConnectionAlreadyExists,
    InvalidConfiguration,
    UnsupportedDatabase,
    QueryCancelled,
    QueryAlreadyRunning,
    Internal,
}

impl From<DbError> for CommandError {
    fn from(error: DbError) -> Self {
        let details = match &error {
            DbError::UnknownSshHostKey { host, port, algorithm, fingerprint } => Some(serde_json::json!({
                "host": host,
                "port": port,
                "algorithm": algorithm,
                "fingerprint": fingerprint,
            })),
            _ => None,
        };
        let code = match &error {
            DbError::Connection(_) => ErrorCode::ConnectionFailed,
            DbError::UnknownSshHostKey { .. } => ErrorCode::SshHostKeyUnknown,
            DbError::Query(_) => ErrorCode::QueryFailed,
            DbError::Schema(_) => ErrorCode::SchemaFailed,
            DbError::NotFound(_) => ErrorCode::ConnectionNotFound,
            DbError::AlreadyExists(_) => ErrorCode::ConnectionAlreadyExists,
            DbError::InvalidConfiguration(_) => ErrorCode::InvalidConfiguration,
            DbError::UnsupportedDatabase(_) => ErrorCode::UnsupportedDatabase,
            DbError::Cancelled => ErrorCode::QueryCancelled,
            DbError::QueryAlreadyRunning(_) => ErrorCode::QueryAlreadyRunning,
            DbError::Other(_) => ErrorCode::Internal,
        };
        Self {
            code,
            message: error.to_string(),
            details,
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn connect_db(
    connection_id: String,
    config: ConnectionConfig,
    state: State<'_, DatabaseState>,
) -> Result<(), CommandError> {
    let driver: Box<dyn DatabaseDriver + Send + Sync> = match &config.db_type {
        DatabaseType::PostgreSql => Box::new(PostgresDriver::new()),
        DatabaseType::MySql => Box::new(MySqlDriver::new()),
        DatabaseType::MongoDb => Box::new(MongoDbDriver::new()),
        DatabaseType::Elasticsearch => Box::new(ElasticsearchDriver::new()),
        other => return Err(DbError::UnsupportedDatabase(format!("{other:?}")).into()),
    };

    driver.connect(&config).await?;
    if !driver.test_connection().await? {
        return Err(DbError::Connection("connection test returned false".into()).into());
    }
    state
        .connections
        .register(connection_id.clone(), driver)
        .await?;
    state.schema_cache.write().await.remove(&connection_id);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn run_query(
    connection_id: String,
    query_id: String,
    query: String,
    limit: usize,
    app: AppHandle,
    state: State<'_, DatabaseState>,
) -> Result<QueryResult, CommandError> {
    if query.trim().is_empty() {
        return Err(DbError::InvalidConfiguration("query cannot be empty".into()).into());
    }

    let token = CancellationToken::new();
    emit_query_log(&app, &query_id, "info", "Query execution started".into());
    {
        let mut cancellations = state.cancellations.write().await;
        if cancellations.contains_key(&query_id) {
            return Err(DbError::QueryAlreadyRunning(query_id).into());
        }
        cancellations.insert(query_id.clone(), token.clone());
    }

    let result = {
        let connections = state.connections.registry().read().await;
        let driver = match connections.get(&connection_id) {
            Some(driver) => driver,
            None => {
                state.cancellations.write().await.remove(&query_id);
                return Err(DbError::NotFound(connection_id).into());
            }
        };

        tokio::select! {
            biased;
            _ = token.cancelled() => Err(DbError::Cancelled),
            result = driver.execute_query(&query, limit) => result,
        }
    };

    match &result {
        Ok(query_result) => emit_query_log(
            &app,
            &query_id,
            "notice",
            format!(
                "Query completed in {} ms; {} row(s) affected; {} row(s) returned",
                query_result.execution_time_ms,
                query_result.total_affected,
                query_result.rows.len()
            ),
        ),
        Err(DbError::Cancelled) => {
            emit_query_log(&app, &query_id, "warning", "Query cancelled by user".into())
        }
        Err(error) => emit_query_log(&app, &query_id, "error", error.to_string()),
    }
    state.cancellations.write().await.remove(&query_id);
    result.map_err(CommandError::from)
}

/// Cancels the query future identified by `query_id`.
///
/// Dropping the SQLx future stops result processing and returns its pooled
/// connection only after the driver has restored it to a usable state.
#[tauri::command(rename_all = "camelCase")]
pub async fn cancel_query(
    query_id: String,
    state: State<'_, DatabaseState>,
) -> Result<bool, CommandError> {
    let cancellations = state.cancellations.read().await;
    match cancellations.get(&query_id) {
        Some(token) => {
            token.cancel();
            Ok(true)
        }
        None => Ok(false),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_schema_tree(
    connection_id: String,
    state: State<'_, DatabaseState>,
) -> Result<SchemaTree, CommandError> {
    if let Some(schema) = state.schema_cache.read().await.get(&connection_id).cloned() {
        return Ok(schema);
    }

    let connections = state.connections.registry().read().await;
    let driver = connections
        .get(&connection_id)
        .ok_or_else(|| DbError::NotFound(connection_id.clone()))?;
    let schema = driver.fetch_schema().await.map_err(CommandError::from)?;
    drop(connections);
    state
        .schema_cache
        .write()
        .await
        .insert(connection_id, schema.clone());
    Ok(schema)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn refresh_schema_cache(
    connection_id: String,
    state: State<'_, DatabaseState>,
) -> Result<(), CommandError> {
    state.schema_cache.write().await.remove(&connection_id);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn disconnect_db(
    connection_id: String,
    state: State<'_, DatabaseState>,
) -> Result<(), CommandError> {
    state.connections.remove(&connection_id).await?;
    state.schema_cache.write().await.remove(&connection_id);
    Ok(())
}
