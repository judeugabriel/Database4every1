use std::{collections::BTreeMap, time::Instant};

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use futures_util::TryStreamExt;
use rust_decimal::Decimal;
use serde_json::{json, Value};
use sqlx::{
    mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlRow, MySqlSslMode},
    Column, Either, MySqlPool, Row, TypeInfo, ValueRef,
};
use tokio::sync::RwLock;

use super::{
    ssh_tunnel::SshTunnel, CollectionNode, ColumnMeta, ConnectionConfig, DatabaseDriver,
    DatabaseNode, DbError, QueryResult, SchemaNode, SchemaTree, SslMode, TableNode, ViewNode,
};

#[derive(Default)]
pub struct MySqlDriver {
    pool: RwLock<Option<MySqlPool>>,
    tunnel: RwLock<Option<SshTunnel>>,
    database_filter: RwLock<Option<String>>,
}

impl MySqlDriver {
    pub fn new() -> Self {
        Self::default()
    }

    async fn pool(&self) -> Result<MySqlPool, DbError> {
        self.pool
            .read()
            .await
            .clone()
            .ok_or_else(|| DbError::Connection("MySQL driver is not connected".into()))
    }
}

#[async_trait]
impl DatabaseDriver for MySqlDriver {
    async fn connect(&self, config: &ConnectionConfig) -> Result<(), DbError> {
        let tunnel = match &config.ssh_tunnel_config {
            Some(ssh) => Some(SshTunnel::start(ssh, &config.host, config.port).await?),
            None => None,
        };
        let connect_host = if tunnel.is_some() {
            "127.0.0.1"
        } else {
            config.host.as_str()
        };
        let connect_port = tunnel.as_ref().map_or(config.port, SshTunnel::local_port);

        let mut options = MySqlConnectOptions::new()
            .host(connect_host)
            .port(connect_port)
            .ssl_mode(mysql_ssl_mode(&config.ssl_mode));
        if let Some(value) = &config.username {
            options = options.username(value);
        }
        if let Some(value) = &config.password {
            options = options.password(value);
        }
        if let Some(value) = &config.database {
            options = options.database(value);
        }

        let pool = MySqlPoolOptions::new()
            .max_connections(10)
            .connect_with(options)
            .await
            .map_err(|error| DbError::Connection(error.to_string()))?;
        *self.pool.write().await = Some(pool);
        *self.database_filter.write().await = config
            .database
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        *self.tunnel.write().await = tunnel;
        Ok(())
    }

    async fn execute_query(&self, query: &str, limit: usize) -> Result<QueryResult, DbError> {
        let pool = self.pool().await?;
        let started = Instant::now();
        let total_records = count_total_records(&pool, query).await;
        let mut stream = sqlx::raw_sql(query).fetch_many(&pool);
        let mut columns = Vec::new();
        let mut rows = Vec::new();
        let mut total_affected = 0;

        while let Some(item) = stream
            .try_next()
            .await
            .map_err(|error| DbError::Query(error.to_string()))?
        {
            match item {
                Either::Left(result) => total_affected += result.rows_affected(),
                Either::Right(row) => {
                    if columns.is_empty() {
                        columns = column_metadata(&row);
                    }
                    if rows.len() < limit {
                        rows.push(row_to_json(&row)?);
                    }
                }
            }
        }

        Ok(QueryResult {
            columns,
            rows,
            execution_time_ms: started.elapsed().as_millis(),
            total_affected,
            total_records,
        })
    }

    async fn fetch_schema(&self) -> Result<SchemaTree, DbError> {
        let pool = self.pool().await?;
        let database_filter = self.database_filter.read().await.clone();
        let rows = sqlx::query(
            r#"SELECT c.TABLE_SCHEMA, c.TABLE_NAME, t.TABLE_TYPE, c.COLUMN_NAME,
                      c.COLUMN_TYPE, c.IS_NULLABLE
               FROM information_schema.COLUMNS c
               JOIN information_schema.TABLES t
                 ON t.TABLE_SCHEMA = c.TABLE_SCHEMA
                AND t.TABLE_NAME = c.TABLE_NAME
               WHERE c.TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
                 AND (? IS NULL OR c.TABLE_SCHEMA = ?)
               ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION"#,
        )
        .bind(database_filter.as_deref())
        .bind(database_filter.as_deref())
        .fetch_all(&pool)
        .await
        .map_err(schema_error)?;

        let mut databases: BTreeMap<String, (Vec<TableNode>, Vec<ViewNode>)> = BTreeMap::new();
        for row in rows {
            let database_name: String = row.try_get("TABLE_SCHEMA").map_err(schema_error)?;
            let object_name: String = row.try_get("TABLE_NAME").map_err(schema_error)?;
            let object_type: String = row.try_get("TABLE_TYPE").map_err(schema_error)?;
            let column = ColumnMeta {
                name: row.try_get("COLUMN_NAME").map_err(schema_error)?,
                data_type: row.try_get("COLUMN_TYPE").map_err(schema_error)?,
                nullable: row
                    .try_get::<String, _>("IS_NULLABLE")
                    .map_err(schema_error)?
                    == "YES",
            };
            let (tables, views) = databases.entry(database_name).or_default();
            if object_type == "VIEW" {
                view_mut(views, &object_name).columns.push(column);
            } else {
                table_mut(tables, &object_name).columns.push(column);
            }
        }

        Ok(SchemaTree {
            databases: databases
                .into_iter()
                .map(|(name, (tables, views))| DatabaseNode {
                    name: name.clone(),
                    schemas: vec![SchemaNode {
                        name,
                        tables,
                        views,
                        collections: Vec::<CollectionNode>::new(),
                    }],
                    collections: Vec::new(),
                })
                .collect(),
        })
    }

    async fn test_connection(&self) -> Result<bool, DbError> {
        let pool = self.pool().await?;
        sqlx::query_scalar::<_, i32>("SELECT 1")
            .fetch_one(&pool)
            .await
            .map(|value| value == 1)
            .map_err(|error| DbError::Connection(error.to_string()))
    }
}

async fn count_total_records(pool: &MySqlPool, query: &str) -> Option<u64> {
    let base = countable_query(query)?;
    let count_query = format!("SELECT COUNT(*) FROM ({base}) AS __datacraft_count");
    sqlx::query_scalar::<_, i64>(&count_query)
        .fetch_one(pool)
        .await
        .ok()
        .and_then(|count| u64::try_from(count).ok())
}

fn countable_query(query: &str) -> Option<String> {
    let trimmed = query.trim().trim_end_matches(';').trim();
    let upper = trimmed.to_ascii_uppercase();
    if !(upper.starts_with("SELECT ") || upper.starts_with("WITH ")) || trimmed.contains(';') {
        return None;
    }
    let mut end = trimmed.len();
    for marker in [" LIMIT ", " OFFSET ", " ORDER BY "] {
        if let Some(index) = upper[..end].rfind(marker) {
            end = end.min(index);
        }
    }
    Some(trimmed[..end].trim().to_owned())
}

fn mysql_ssl_mode(mode: &SslMode) -> MySqlSslMode {
    match mode {
        SslMode::Disable => MySqlSslMode::Disabled,
        SslMode::Prefer => MySqlSslMode::Preferred,
        SslMode::Require => MySqlSslMode::Required,
        SslMode::VerifyCa => MySqlSslMode::VerifyCa,
        SslMode::VerifyFull => MySqlSslMode::VerifyIdentity,
    }
}

fn column_metadata(row: &MySqlRow) -> Vec<ColumnMeta> {
    row.columns()
        .iter()
        .map(|column| ColumnMeta {
            name: column.name().to_owned(),
            data_type: column.type_info().name().to_owned(),
            // MySQL result metadata exposed by SQLx does not provide this here.
            nullable: true,
        })
        .collect()
}

fn row_to_json(row: &MySqlRow) -> Result<Vec<Value>, DbError> {
    row.columns()
        .iter()
        .enumerate()
        .map(|(index, column)| {
            if row.try_get_raw(index).map_err(query_error)?.is_null() {
                return Ok(Value::Null);
            }

            let data_type = column.type_info().name().to_ascii_uppercase();
            let value = match data_type.as_str() {
                "BOOLEAN" | "BOOL" => json!(row.try_get::<bool, _>(index).map_err(query_error)?),
                "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "INTEGER" | "BIGINT" => {
                    match row.try_get::<i64, _>(index) {
                        Ok(value) => json!(value),
                        Err(_) => json!(row.try_get::<u64, _>(index).map_err(query_error)?),
                    }
                }
                "FLOAT" => float_json(row.try_get::<f32, _>(index).map_err(query_error)? as f64),
                "DOUBLE" => float_json(row.try_get::<f64, _>(index).map_err(query_error)?),
                // Decimal is encoded as a string to avoid precision loss in JavaScript.
                "DECIMAL" | "NEWDECIMAL" => {
                    json!(row
                        .try_get::<Decimal, _>(index)
                        .map_err(query_error)?
                        .to_string())
                }
                "JSON" => row.try_get::<Value, _>(index).map_err(query_error)?,
                "DATE" => json!(row
                    .try_get::<NaiveDate, _>(index)
                    .map_err(query_error)?
                    .to_string()),
                "TIME" => json!(row
                    .try_get::<NaiveTime, _>(index)
                    .map_err(query_error)?
                    .to_string()),
                "DATETIME" | "TIMESTAMP" => json!(row
                    .try_get::<NaiveDateTime, _>(index)
                    .map_err(query_error)?
                    .to_string()),
                "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BINARY" | "VARBINARY"
                | "BIT" => {
                    json!(BASE64.encode(row.try_get::<Vec<u8>, _>(index).map_err(query_error)?))
                }
                _ => json!(row
                    .try_get::<String, _>(index)
                    .map_err(|_| unsupported_type(column.type_info().name(), column.name()))?),
            };
            Ok(value)
        })
        .collect()
}

fn float_json(value: f64) -> Value {
    serde_json::Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or_else(|| json!(value.to_string()))
}

fn unsupported_type(data_type: &str, column: &str) -> DbError {
    DbError::Query(format!(
        "unsupported MySQL type '{data_type}' in column '{column}'"
    ))
}

fn query_error(error: sqlx::Error) -> DbError {
    DbError::Query(error.to_string())
}

fn schema_error(error: sqlx::Error) -> DbError {
    DbError::Schema(error.to_string())
}

fn table_mut<'a>(items: &'a mut Vec<TableNode>, name: &str) -> &'a mut TableNode {
    if let Some(index) = items.iter().position(|item| item.name == name) {
        return &mut items[index];
    }
    items.push(TableNode {
        name: name.to_owned(),
        columns: Vec::new(),
    });
    items.last_mut().expect("table was inserted")
}

fn view_mut<'a>(items: &'a mut Vec<ViewNode>, name: &str) -> &'a mut ViewNode {
    if let Some(index) = items.iter().position(|item| item.name == name) {
        return &mut items[index];
    }
    items.push(ViewNode {
        name: name.to_owned(),
        columns: Vec::new(),
    });
    items.last_mut().expect("view was inserted")
}
