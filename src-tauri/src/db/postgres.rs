use std::{collections::HashMap, time::Instant};

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use futures_util::TryStreamExt;
use rust_decimal::Decimal;
use serde_json::{json, Value};
use sqlx::{
    postgres::{PgConnectOptions, PgPoolOptions, PgRow, PgSslMode},
    Column, Either, PgPool, Row, TypeInfo, ValueRef,
};
use tokio::sync::RwLock;
use uuid::Uuid;

use super::{
    ssh_tunnel::SshTunnel, CollectionNode, ColumnMeta, ConnectionConfig, DatabaseDriver,
    DatabaseNode, DbError, QueryResult, SchemaNode, SchemaTree, SslMode, TableNode, ViewNode,
};

#[derive(Default)]
pub struct PostgresDriver {
    pool: RwLock<Option<PgPool>>,
    tunnel: RwLock<Option<SshTunnel>>,
    connect_options: RwLock<Option<PgConnectOptions>>,
    discover_all_databases: RwLock<bool>,
    database_pools: RwLock<HashMap<String, PgPool>>,
}

impl PostgresDriver {
    pub fn new() -> Self {
        Self::default()
    }

    async fn pool(&self) -> Result<PgPool, DbError> {
        self.pool
            .read()
            .await
            .clone()
            .ok_or_else(|| DbError::Connection("PostgreSQL driver is not connected".into()))
    }
}

#[async_trait]
impl DatabaseDriver for PostgresDriver {
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

        let mut options = PgConnectOptions::new()
            .host(connect_host)
            .port(connect_port)
            .ssl_mode(pg_ssl_mode(&config.ssl_mode));
        if let Some(value) = &config.username {
            options = options.username(value);
        }
        if let Some(value) = &config.password {
            options = options.password(value);
        }
        let selected_database = config
            .database
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if let Some(value) = selected_database {
            options = options.database(value);
        } else {
            // PostgreSQL requires one database for the administrative pool.
            // `postgres` is used only as the discovery connection; schemas are
            // subsequently loaded from every database the user may connect to.
            options = options.database("postgres");
        }

        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect_with(options.clone())
            .await
            .map_err(|error| DbError::Connection(error.to_string()))?;
        let connected_database: String = sqlx::query_scalar("SELECT current_database()")
            .fetch_one(&pool)
            .await
            .map_err(|error| DbError::Connection(error.to_string()))?;
        self.database_pools
            .write()
            .await
            .insert(connected_database, pool.clone());
        *self.pool.write().await = Some(pool);
        *self.connect_options.write().await = Some(options);
        *self.discover_all_databases.write().await = selected_database.is_none();
        *self.tunnel.write().await = tunnel;
        Ok(())
    }

    async fn execute_query(&self, query: &str, limit: usize) -> Result<QueryResult, DbError> {
        let (target_database, query) = postgres_query_target(query);
        let pool = if let Some(database) = target_database {
            self.database_pools
                .read()
                .await
                .get(database)
                .cloned()
                .ok_or_else(|| {
                    DbError::Query(format!(
                        "database '{database}' is not loaded; refresh the database explorer"
                    ))
                })?
        } else {
            self.pool().await?
        };
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
        if !*self.discover_all_databases.read().await {
            let database: String = sqlx::query_scalar("SELECT current_database()")
                .fetch_one(&pool)
                .await
                .map_err(schema_error)?;
            return Ok(SchemaTree {
                databases: vec![DatabaseNode {
                    name: database,
                    schemas: fetch_postgres_schemas(&pool).await?,
                    collections: Vec::new(),
                }],
            });
        }

        let database_names: Vec<String> = sqlx::query_scalar(
            r#"SELECT datname
               FROM pg_database
               WHERE datallowconn
                 AND NOT datistemplate
                 AND has_database_privilege(datname, 'CONNECT')
               ORDER BY datname"#,
        )
        .fetch_all(&pool)
        .await
        .map_err(schema_error)?;
        let options = self.connect_options.read().await.clone().ok_or_else(|| {
            DbError::Connection("PostgreSQL connection options are missing".into())
        })?;
        let current_database: String = sqlx::query_scalar("SELECT current_database()")
            .fetch_one(&pool)
            .await
            .map_err(schema_error)?;
        let mut databases = Vec::new();
        for database_name in database_names {
            let schemas = if database_name == current_database {
                fetch_postgres_schemas(&pool).await?
            } else {
                let database_pool = PgPoolOptions::new()
                    .max_connections(1)
                    .connect_with(options.clone().database(&database_name))
                    .await
                    .map_err(schema_error)?;
                let schemas = fetch_postgres_schemas(&database_pool).await?;
                self.database_pools
                    .write()
                    .await
                    .insert(database_name.clone(), database_pool);
                schemas
            };
            databases.push(DatabaseNode {
                name: database_name,
                schemas,
                collections: Vec::new(),
            });
        }
        Ok(SchemaTree { databases })
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

fn postgres_query_target(query: &str) -> (Option<&str>, &str) {
    const PREFIX: &str = "-- datacraft:database=";
    let trimmed = query.trim_start();
    if let Some(rest) = trimmed.strip_prefix(PREFIX) {
        if let Some((database, sql)) = rest.split_once('\n') {
            let database = database.trim();
            if !database.is_empty() {
                return (Some(database), sql.trim_start());
            }
        }
    }
    (None, query)
}

async fn fetch_postgres_schemas(pool: &PgPool) -> Result<Vec<SchemaNode>, DbError> {
    let rows = sqlx::query(
        r#"SELECT c.table_schema, c.table_name, t.table_type,
                      c.column_name, c.data_type, c.is_nullable
               FROM information_schema.columns c
               JOIN information_schema.tables t
                 ON t.table_catalog = c.table_catalog
                AND t.table_schema = c.table_schema
                AND t.table_name = c.table_name
               WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
               ORDER BY c.table_schema, c.table_name, c.ordinal_position"#,
    )
    .fetch_all(pool)
    .await
    .map_err(schema_error)?;

    let mut schemas = Vec::new();
    for row in rows {
        let schema_name: String = row.try_get("table_schema").map_err(schema_error)?;
        let object_name: String = row.try_get("table_name").map_err(schema_error)?;
        let object_type: String = row.try_get("table_type").map_err(schema_error)?;
        let column = ColumnMeta {
            name: row.try_get("column_name").map_err(schema_error)?,
            data_type: row.try_get("data_type").map_err(schema_error)?,
            nullable: row
                .try_get::<String, _>("is_nullable")
                .map_err(schema_error)?
                == "YES",
        };
        let schema = schema_mut(&mut schemas, &schema_name);
        if object_type == "VIEW" {
            view_mut(&mut schema.views, &object_name)
                .columns
                .push(column);
        } else {
            table_mut(&mut schema.tables, &object_name)
                .columns
                .push(column);
        }
    }

    Ok(schemas)
}

async fn count_total_records(pool: &PgPool, query: &str) -> Option<u64> {
    let base = countable_query(query)?;
    let count_query = format!("SELECT COUNT(*)::BIGINT FROM ({base}) AS __datacraft_count");
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

fn pg_ssl_mode(mode: &SslMode) -> PgSslMode {
    match mode {
        SslMode::Disable => PgSslMode::Disable,
        SslMode::Prefer => PgSslMode::Prefer,
        SslMode::Require => PgSslMode::Require,
        SslMode::VerifyCa => PgSslMode::VerifyCa,
        SslMode::VerifyFull => PgSslMode::VerifyFull,
    }
}

fn column_metadata(row: &PgRow) -> Vec<ColumnMeta> {
    row.columns()
        .iter()
        .map(|column| ColumnMeta {
            name: column.name().to_owned(),
            data_type: column.type_info().name().to_owned(),
            // PostgreSQL result metadata does not carry nullability.
            nullable: true,
        })
        .collect()
}

fn row_to_json(row: &PgRow) -> Result<Vec<Value>, DbError> {
    row.columns()
        .iter()
        .enumerate()
        .map(|(index, column)| {
            if row.try_get_raw(index).map_err(query_error)?.is_null() {
                return Ok(Value::Null);
            }

            let value = match column.type_info().name() {
                "BOOL" => json!(row.try_get::<bool, _>(index).map_err(query_error)?),
                "INT2" => json!(row.try_get::<i16, _>(index).map_err(query_error)?),
                "INT4" => json!(row.try_get::<i32, _>(index).map_err(query_error)?),
                "INT8" => json!(row.try_get::<i64, _>(index).map_err(query_error)?),
                "FLOAT4" => float_json(row.try_get::<f32, _>(index).map_err(query_error)? as f64),
                "FLOAT8" => float_json(row.try_get::<f64, _>(index).map_err(query_error)?),
                // Decimal is encoded as a string to avoid precision loss in JavaScript.
                "NUMERIC" => json!(row
                    .try_get::<Decimal, _>(index)
                    .map_err(query_error)?
                    .to_string()),
                "JSON" | "JSONB" => row.try_get::<Value, _>(index).map_err(query_error)?,
                "UUID" => json!(row
                    .try_get::<Uuid, _>(index)
                    .map_err(query_error)?
                    .to_string()),
                "DATE" => json!(row
                    .try_get::<NaiveDate, _>(index)
                    .map_err(query_error)?
                    .to_string()),
                "TIME" => json!(row
                    .try_get::<NaiveTime, _>(index)
                    .map_err(query_error)?
                    .to_string()),
                "TIMESTAMP" => json!(row
                    .try_get::<NaiveDateTime, _>(index)
                    .map_err(query_error)?
                    .to_string()),
                "TIMESTAMPTZ" => json!(row
                    .try_get::<DateTime<Utc>, _>(index)
                    .map_err(query_error)?
                    .to_rfc3339()),
                "BYTEA" => {
                    json!(BASE64.encode(row.try_get::<Vec<u8>, _>(index).map_err(query_error)?))
                }
                "BOOL[]" => json!(row
                    .try_get::<Vec<Option<bool>>, _>(index)
                    .map_err(query_error)?),
                "INT2[]" => json!(row
                    .try_get::<Vec<Option<i16>>, _>(index)
                    .map_err(query_error)?),
                "INT4[]" => json!(row
                    .try_get::<Vec<Option<i32>>, _>(index)
                    .map_err(query_error)?),
                "INT8[]" => json!(row
                    .try_get::<Vec<Option<i64>>, _>(index)
                    .map_err(query_error)?),
                "FLOAT4[]" => float_array_json(
                    row.try_get::<Vec<Option<f32>>, _>(index)
                        .map_err(query_error)?
                        .into_iter()
                        .map(|value| value.map(f64::from)),
                ),
                "FLOAT8[]" => float_array_json(
                    row.try_get::<Vec<Option<f64>>, _>(index)
                        .map_err(query_error)?
                        .into_iter(),
                ),
                "NUMERIC[]" => display_array_json(
                    row.try_get::<Vec<Option<Decimal>>, _>(index)
                        .map_err(query_error)?,
                ),
                "TEXT[]" | "VARCHAR[]" | "BPCHAR[]" | "NAME[]" => json!(row
                    .try_get::<Vec<Option<String>>, _>(index)
                    .map_err(query_error)?),
                "JSON[]" | "JSONB[]" => json!(row
                    .try_get::<Vec<Option<Value>>, _>(index)
                    .map_err(query_error)?),
                "UUID[]" => display_array_json(
                    row.try_get::<Vec<Option<Uuid>>, _>(index)
                        .map_err(query_error)?,
                ),
                "DATE[]" => display_array_json(
                    row.try_get::<Vec<Option<NaiveDate>>, _>(index)
                        .map_err(query_error)?,
                ),
                "TIME[]" => display_array_json(
                    row.try_get::<Vec<Option<NaiveTime>>, _>(index)
                        .map_err(query_error)?,
                ),
                "TIMESTAMP[]" => display_array_json(
                    row.try_get::<Vec<Option<NaiveDateTime>>, _>(index)
                        .map_err(query_error)?,
                ),
                "TIMESTAMPTZ[]" => json!(row
                    .try_get::<Vec<Option<DateTime<Utc>>>, _>(index)
                    .map_err(query_error)?
                    .into_iter()
                    .map(|value| value.map(|item| item.to_rfc3339()))
                    .collect::<Vec<_>>()),
                "BYTEA[]" => json!(row
                    .try_get::<Vec<Option<Vec<u8>>>, _>(index)
                    .map_err(query_error)?
                    .into_iter()
                    .map(|value| value.map(|bytes| BASE64.encode(bytes)))
                    .collect::<Vec<_>>()),
                _ => json!(row
                    .try_get::<String, _>(index)
                    .map_err(|_| unsupported_type(column.type_info().name(), column.name()))?),
            };
            Ok(value)
        })
        .collect()
}

fn display_array_json<T: std::fmt::Display>(values: Vec<Option<T>>) -> Value {
    Value::Array(
        values
            .into_iter()
            .map(|value| value.map_or(Value::Null, |item| json!(item.to_string())))
            .collect(),
    )
}

fn float_array_json(values: impl IntoIterator<Item = Option<f64>>) -> Value {
    Value::Array(
        values
            .into_iter()
            .map(|value| value.map_or(Value::Null, float_json))
            .collect(),
    )
}

fn float_json(value: f64) -> Value {
    serde_json::Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or_else(|| json!(value.to_string()))
}

fn unsupported_type(data_type: &str, column: &str) -> DbError {
    DbError::Query(format!(
        "unsupported PostgreSQL type '{data_type}' in column '{column}'"
    ))
}

fn query_error(error: sqlx::Error) -> DbError {
    DbError::Query(error.to_string())
}

fn schema_error(error: sqlx::Error) -> DbError {
    DbError::Schema(error.to_string())
}

fn schema_mut<'a>(items: &'a mut Vec<SchemaNode>, name: &str) -> &'a mut SchemaNode {
    if let Some(index) = items.iter().position(|item| item.name == name) {
        return &mut items[index];
    }
    items.push(SchemaNode {
        name: name.to_owned(),
        tables: Vec::new(),
        views: Vec::new(),
        collections: Vec::<CollectionNode>::new(),
    });
    items.last_mut().expect("schema was inserted")
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
