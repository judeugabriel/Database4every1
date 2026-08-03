use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio::sync::RwLock;

pub mod commands;
pub mod elasticsearch;
pub mod mongodb;
pub mod mysql;
pub mod postgres;
pub mod redis;
pub mod ssh_tunnel;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseType {
    #[serde(rename = "postgresql")]
    PostgreSql,
    #[serde(rename = "mysql")]
    MySql,
    #[serde(rename = "sqlite")]
    SQLite,
    #[serde(rename = "mongodb")]
    MongoDb,
    #[serde(rename = "elasticsearch")]
    Elasticsearch,
    #[serde(rename = "redis")]
    Redis,
    Other(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SslMode {
    Disable,
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshTunnelConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    #[serde(default)]
    pub private_key_passphrase: Option<String>,
    /// Maximum time allowed for the jump-host TCP connection and SSH setup.
    #[serde(default)]
    pub connect_timeout_secs: Option<u64>,
    /// One-shot trust-on-first-use approval supplied after the UI confirms the
    /// presented fingerprint. This is never persisted by the frontend.
    #[serde(default)]
    pub accept_new_host_key: Option<bool>,
    #[serde(default)]
    pub expected_host_key_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default, rename = "groupId")]
    pub group_id: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
    pub database: Option<String>,
    pub ssl_mode: SslMode,
    #[serde(default)]
    pub ignore_tls: Option<bool>,
    pub ssh_tunnel_config: Option<SshTunnelConfig>,
    pub db_type: DatabaseType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Value>>,
    pub execution_time_ms: u128,
    pub total_affected: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_records: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SchemaTree {
    pub databases: Vec<DatabaseNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseNode {
    pub name: String,
    pub schemas: Vec<SchemaNode>,
    /// NoSQL databases can expose collections directly under a database.
    pub collections: Vec<CollectionNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaNode {
    pub name: String,
    pub tables: Vec<TableNode>,
    pub views: Vec<ViewNode>,
    pub collections: Vec<CollectionNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableNode {
    pub name: String,
    pub columns: Vec<ColumnMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewNode {
    pub name: String,
    pub columns: Vec<ColumnMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionNode {
    pub name: String,
    /// Inferred fields for schemaless collections; this may be empty.
    pub columns: Vec<ColumnMeta>,
}

#[derive(Debug, Error)]
pub enum DbError {
    #[error("connection failed: {0}")]
    Connection(String),

    #[error("SSH host {host}:{port} is not present in known_hosts ({algorithm} {fingerprint})")]
    UnknownSshHostKey {
        host: String,
        port: u16,
        algorithm: String,
        fingerprint: String,
    },

    #[error("query execution failed: {0}")]
    Query(String),

    #[error("schema discovery failed: {0}")]
    Schema(String),

    #[error("connection '{0}' was not found")]
    NotFound(String),

    #[error("connection '{0}' already exists")]
    AlreadyExists(String),

    #[error("invalid connection configuration: {0}")]
    InvalidConfiguration(String),

    #[error("unsupported database type: {0}")]
    UnsupportedDatabase(String),

    #[error("query was cancelled")]
    Cancelled,

    #[error("query id '{0}' is already running")]
    QueryAlreadyRunning(String),

    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

/// Object-safe asynchronous interface shared by SQL and NoSQL drivers.
#[async_trait]
pub trait DatabaseDriver: Send + Sync {
    async fn connect(&self, config: &ConnectionConfig) -> Result<(), DbError>;

    async fn execute_query(&self, query: &str, limit: usize) -> Result<QueryResult, DbError>;

    async fn fetch_schema(&self) -> Result<SchemaTree, DbError>;

    async fn test_connection(&self) -> Result<bool, DbError>;
}

pub type DriverRegistry = Arc<RwLock<HashMap<String, Box<dyn DatabaseDriver + Send + Sync>>>>;

#[derive(Clone, Default)]
pub struct ConnectionManager {
    connections: DriverRegistry,
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn register(
        &self,
        id: impl Into<String>,
        driver: Box<dyn DatabaseDriver + Send + Sync>,
    ) -> Result<(), DbError> {
        let id = id.into();
        let mut connections = self.connections.write().await;

        if connections.contains_key(&id) {
            return Err(DbError::AlreadyExists(id));
        }

        connections.insert(id, driver);
        Ok(())
    }

    pub async fn remove(&self, id: &str) -> Result<Box<dyn DatabaseDriver + Send + Sync>, DbError> {
        self.connections
            .write()
            .await
            .remove(id)
            .ok_or_else(|| DbError::NotFound(id.to_owned()))
    }

    pub async fn contains(&self, id: &str) -> bool {
        self.connections.read().await.contains_key(id)
    }

    pub async fn connection_ids(&self) -> Vec<String> {
        self.connections.read().await.keys().cloned().collect()
    }

    pub async fn len(&self) -> usize {
        self.connections.read().await.len()
    }

    pub async fn is_empty(&self) -> bool {
        self.connections.read().await.is_empty()
    }

    pub fn registry(&self) -> &DriverRegistry {
        &self.connections
    }
}
