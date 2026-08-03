use std::{collections::BTreeMap, time::Instant};

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use redis::{aio::MultiplexedConnection, Value as RedisValue};
use serde_json::{json, Value};
use tokio::sync::RwLock;
use url::Url;

use super::{
    ssh_tunnel::SshTunnel, CollectionNode, ColumnMeta, ConnectionConfig, DatabaseDriver,
    DatabaseNode, DbError, QueryResult, SchemaNode, SchemaTree, SslMode,
};

struct ActiveRedisConnection {
    client: MultiplexedConnection,
    redis: redis::Client,
    selected_database: Option<i64>,
}

#[derive(Default)]
pub struct RedisDriver {
    connection: RwLock<Option<ActiveRedisConnection>>,
    tunnel: RwLock<Option<SshTunnel>>,
}

impl RedisDriver {
    pub fn new() -> Self {
        Self::default()
    }

    async fn client(&self) -> Result<(MultiplexedConnection, i64), DbError> {
        let connection = self.connection.read().await;
        let connection = connection
            .as_ref()
            .ok_or_else(|| DbError::Connection("Redis driver is not connected".into()))?;
        Ok((connection.client.clone(), connection.selected_database.unwrap_or(0)))
    }

    async fn redis_client(&self) -> Result<(redis::Client, Option<i64>), DbError> {
        let connection = self.connection.read().await;
        let connection = connection
            .as_ref()
            .ok_or_else(|| DbError::Connection("Redis driver is not connected".into()))?;
        Ok((connection.redis.clone(), connection.selected_database))
    }
}

#[async_trait]
impl DatabaseDriver for RedisDriver {
    async fn connect(&self, config: &ConnectionConfig) -> Result<(), DbError> {
        let tunnel = match &config.ssh_tunnel_config {
            Some(ssh) => Some(SshTunnel::start(ssh, &config.host, config.port).await?),
            None => None,
        };
        let host = if tunnel.is_some() { "127.0.0.1" } else { config.host.as_str() };
        let port = tunnel.as_ref().map_or(config.port, SshTunnel::local_port);
        let selected_database = config.database.as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.parse::<i64>().map_err(|_| DbError::InvalidConfiguration(
                "Redis database must be a numeric index, for example 0".into(),
            )))
            .transpose()?;
        let database = selected_database.unwrap_or(0);
        let scheme = if matches!(config.ssl_mode, SslMode::Disable) { "redis" } else { "rediss" };
        let mut url = Url::parse(&format!("{scheme}://{host}:{port}/{database}"))
            .map_err(|error| DbError::InvalidConfiguration(error.to_string()))?;
        if let Some(username) = config.username.as_deref().filter(|value| !value.is_empty()) {
            url.set_username(username)
                .map_err(|_| DbError::InvalidConfiguration("invalid Redis username".into()))?;
        }
        if let Some(password) = config.password.as_deref().filter(|value| !value.is_empty()) {
            url.set_password(Some(password))
                .map_err(|_| DbError::InvalidConfiguration("invalid Redis password".into()))?;
        }
        if config.ignore_tls.unwrap_or(false) {
            url.set_fragment(Some("insecure"));
        }

        let redis = redis::Client::open(url.as_str())
            .map_err(|error| DbError::InvalidConfiguration(error.to_string()))?;
        let mut client = redis.get_multiplexed_async_connection().await.map_err(connection_error)?;
        let pong: String = redis::cmd("PING").query_async(&mut client).await.map_err(connection_error)?;
        if pong != "PONG" {
            return Err(DbError::Connection(format!("unexpected Redis PING response: {pong}")));
        }
        *self.connection.write().await = Some(ActiveRedisConnection {
            client,
            redis,
            selected_database,
        });
        *self.tunnel.write().await = tunnel;
        Ok(())
    }

    async fn execute_query(&self, query: &str, _limit: usize) -> Result<QueryResult, DbError> {
        let (mut client, _) = self.client().await?;
        let arguments = shell_words::split(query.trim())
            .map_err(|error| DbError::Query(format!("invalid Redis command: {error}")))?;
        let command_name = arguments.first()
            .ok_or_else(|| DbError::Query("Redis command cannot be empty".into()))?;
        let started = Instant::now();
        let (value, is_stream) = if command_name.eq_ignore_ascii_case("DUMPVALUE") {
            let (database, key_index) = if arguments.get(1).is_some_and(|value| value.eq_ignore_ascii_case("DB")) {
                let database = arguments.get(2)
                    .ok_or_else(|| DbError::Query("DUMPVALUE DB requires a database index".into()))?
                    .parse::<i64>()
                    .map_err(|_| DbError::Query("DUMPVALUE DB requires a numeric database index".into()))?;
                (Some(database), 3)
            } else {
                (None, 1)
            };
            if let Some(database) = database {
                let (redis, _) = self.redis_client().await?;
                client = connection_for_database(&redis, database).await?;
            }
            let key = arguments.get(key_index)
                .ok_or_else(|| DbError::Query("DUMPVALUE requires a key".into()))?;
            read_key(&mut client, key).await?
        } else {
            let mut command = redis::cmd(command_name);
            command.arg(&arguments[1..]);
            let value = command.query_async::<RedisValue>(&mut client).await.map_err(query_error)?;
            (value, command_name.eq_ignore_ascii_case("XRANGE") || command_name.eq_ignore_ascii_case("XREVRANGE"))
        };
        let elapsed = started.elapsed().as_millis();
        Ok(if is_stream {
            stream_query_result(&value, elapsed).unwrap_or_else(|| query_result(value, elapsed))
        } else {
            query_result(value, elapsed)
        })
    }

    async fn fetch_schema(&self) -> Result<SchemaTree, DbError> {
        let (redis, selected_database) = self.redis_client().await?;
        let databases = match selected_database {
            Some(database) => vec![database],
            None => discover_databases(&redis).await?,
        };
        let mut database_nodes = Vec::new();
        for database in databases {
            let mut client = match connection_for_database(&redis, database).await {
                Ok(client) => client,
                Err(_) if selected_database.is_none() => continue,
                Err(error) => return Err(error),
            };
            let (schemas, collections) = scan_database(&mut client).await?;
            database_nodes.push(DatabaseNode {
                name: format!("db{database}"),
                schemas,
                collections,
            });
        }
        Ok(SchemaTree { databases: database_nodes })
    }

    async fn test_connection(&self) -> Result<bool, DbError> {
        let (mut client, _) = self.client().await?;
        redis::cmd("PING").query_async::<String>(&mut client).await
            .map(|response| response == "PONG").map_err(connection_error)
    }
}

async fn discover_databases(redis: &redis::Client) -> Result<Vec<i64>, DbError> {
    let mut client = redis.get_multiplexed_async_connection().await.map_err(schema_error)?;
    let configured_count = redis::cmd("CONFIG").arg("GET").arg("databases")
        .query_async::<RedisValue>(&mut client).await.ok()
        .and_then(redis_database_count)
        .unwrap_or(16)
        .clamp(1, 256);
    Ok((0..configured_count as i64).collect())
}

fn redis_database_count(value: RedisValue) -> Option<usize> {
    match value {
        RedisValue::BulkString(bytes) => String::from_utf8(bytes).ok()?.parse().ok(),
        RedisValue::SimpleString(text) => text.parse().ok(),
        RedisValue::Int(value) => usize::try_from(value).ok(),
        RedisValue::Array(values) | RedisValue::Set(values) => values.into_iter()
            .rev().find_map(redis_database_count),
        RedisValue::Map(entries) => entries.into_iter().rev()
            .find_map(|(_, value)| redis_database_count(value)),
        _ => None,
    }
}

async fn connection_for_database(
    redis: &redis::Client,
    database: i64,
) -> Result<MultiplexedConnection, DbError> {
    let mut client = redis.get_multiplexed_async_connection().await.map_err(schema_error)?;
    if database != 0 {
        redis::cmd("SELECT").arg(database)
            .query_async::<String>(&mut client).await.map_err(schema_error)?;
    }
    Ok(client)
}

async fn scan_database(
    client: &mut MultiplexedConnection,
) -> Result<(Vec<SchemaNode>, Vec<CollectionNode>), DbError> {
        let mut cursor = 0_u64;
        let mut keys = Vec::new();
        loop {
            let (next, batch): (u64, Vec<String>) = redis::cmd("SCAN")
                .arg(cursor).arg("COUNT").arg(500)
                .query_async(client).await.map_err(schema_error)?;
            keys.extend(batch);
            cursor = next;
            if cursor == 0 || keys.len() >= 5_000 { break; }
        }
        keys.sort_by_key(|key| key.to_lowercase());
        keys.truncate(5_000);
        let mut grouped: BTreeMap<String, Vec<CollectionNode>> = BTreeMap::new();
        let mut collections = Vec::new();
        for key in keys {
            let data_type: String = redis::cmd("TYPE").arg(&key)
                .query_async(client).await.map_err(schema_error)?;
            let collection = CollectionNode {
                name: key,
                columns: vec![ColumnMeta {
                    name: "value".into(), data_type, nullable: true,
                }],
            };
            if let Some(prefix) = collection.name.split_once(':')
                .map(|(prefix, _)| prefix.trim())
                .filter(|prefix| !prefix.is_empty())
            {
                grouped.entry(prefix.to_owned()).or_default().push(collection);
            } else {
                collections.push(collection);
            }
        }
        let schemas = grouped.into_iter().map(|(name, collections)| SchemaNode {
            name,
            tables: Vec::new(),
            views: Vec::new(),
            collections,
        }).collect();
        Ok((schemas, collections))
}

async fn read_key(client: &mut MultiplexedConnection, key: &str) -> Result<(RedisValue, bool), DbError> {
    let data_type: String = redis::cmd("TYPE").arg(key)
        .query_async(client).await.map_err(query_error)?;
    let mut command = match data_type.as_str() {
        "string" => redis::cmd("GET"),
        "hash" => redis::cmd("HGETALL"),
        "set" => redis::cmd("SMEMBERS"),
        "none" => return Err(DbError::Query(format!("Redis key '{key}' no longer exists"))),
        _ => redis::cmd("DUMP"),
    };
    match data_type.as_str() {
        "list" => { command = redis::cmd("LRANGE"); command.arg(key).arg(0).arg(-1); }
        "zset" => { command = redis::cmd("ZRANGE"); command.arg(key).arg(0).arg(-1).arg("WITHSCORES"); }
        "stream" => { command = redis::cmd("XRANGE"); command.arg(key).arg("-").arg("+"); }
        _ => { command.arg(key); }
    }
    command.query_async(client).await
        .map(|value| (value, data_type == "stream"))
        .map_err(query_error)
}

fn stream_query_result(value: &RedisValue, elapsed: u128) -> Option<QueryResult> {
    let RedisValue::Array(entries) = value else { return None };
    let mut field_names = Vec::<String>::new();
    let mut decoded = Vec::<(Value, BTreeMap<String, Value>)>::with_capacity(entries.len());
    for entry in entries {
        let RedisValue::Array(parts) = entry else { return None };
        if parts.len() < 2 { return None; }
        let entry_id = redis_json(parts[0].clone());
        let mut fields = BTreeMap::new();
        match &parts[1] {
            RedisValue::Array(field_values) => {
                for pair in field_values.chunks_exact(2) {
                    let name = redis_text(&pair[0])?;
                    if !field_names.contains(&name) { field_names.push(name.clone()); }
                    fields.insert(name, redis_json(pair[1].clone()));
                }
            }
            RedisValue::Map(field_values) => {
                for (field, value) in field_values {
                    let name = redis_text(field)?;
                    if !field_names.contains(&name) { field_names.push(name.clone()); }
                    fields.insert(name, redis_json(value.clone()));
                }
            }
            _ => return None,
        }
        decoded.push((entry_id, fields));
    }
    let mut columns = vec![ColumnMeta {
        name: "Entry ID".into(), data_type: "stream-id".into(), nullable: false,
    }];
    columns.extend(field_names.iter().map(|name| ColumnMeta {
        name: name.clone(), data_type: "string".into(), nullable: true,
    }));
    let rows = decoded.into_iter().map(|(entry_id, fields)| {
        let mut row = vec![entry_id];
        row.extend(field_names.iter().map(|name| fields.get(name).cloned().unwrap_or(Value::Null)));
        row
    }).collect();
    Some(QueryResult {
        columns, rows, execution_time_ms: elapsed, total_affected: 0,
        total_records: Some(entries.len() as u64),
    })
}

fn redis_text(value: &RedisValue) -> Option<String> {
    match value {
        RedisValue::BulkString(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
        RedisValue::SimpleString(text) => Some(text.clone()),
        RedisValue::Int(value) => Some(value.to_string()),
        _ => None,
    }
}

fn query_result(value: RedisValue, elapsed: u128) -> QueryResult {
    match value {
        RedisValue::Map(entries) => QueryResult {
            columns: vec![column("key"), column("value")],
            rows: entries.into_iter().map(|(key, value)| vec![redis_json(key), redis_json(value)]).collect(),
            execution_time_ms: elapsed, total_affected: 0, total_records: None,
        },
        RedisValue::Array(values) | RedisValue::Set(values) => {
            let count = values.len() as u64;
            QueryResult {
                columns: vec![column("value")],
                rows: values.into_iter().map(|value| vec![redis_json(value)]).collect(),
                execution_time_ms: elapsed, total_affected: 0, total_records: Some(count),
            }
        }
        value => QueryResult {
            columns: vec![column("value")], rows: vec![vec![redis_json(value)]],
            execution_time_ms: elapsed, total_affected: 0, total_records: Some(1),
        },
    }
}

fn column(name: &str) -> ColumnMeta {
    ColumnMeta { name: name.into(), data_type: "dynamic".into(), nullable: true }
}

fn redis_json(value: RedisValue) -> Value {
    match value {
        RedisValue::Nil => Value::Null,
        RedisValue::Int(value) => json!(value),
        RedisValue::BulkString(bytes) => String::from_utf8(bytes.clone()).map(Value::String)
            .unwrap_or_else(|_| json!({ "$binary": STANDARD.encode(bytes) })),
        RedisValue::Array(values) | RedisValue::Set(values) => Value::Array(values.into_iter().map(redis_json).collect()),
        RedisValue::SimpleString(value) => Value::String(value),
        RedisValue::Okay => Value::String("OK".into()),
        RedisValue::Map(entries) => Value::Array(entries.into_iter()
            .map(|(key, value)| json!({ "key": redis_json(key), "value": redis_json(value) })).collect()),
        RedisValue::Attribute { data, attributes } => json!({
            "data": redis_json(*data),
            "attributes": attributes.into_iter().map(|(key, value)| json!([redis_json(key), redis_json(value)])).collect::<Vec<_>>()
        }),
        RedisValue::Double(value) => json!(value),
        RedisValue::Boolean(value) => json!(value),
        RedisValue::VerbatimString { format, text } => json!({ "format": format!("{format:?}"), "text": text }),
        RedisValue::BigNumber(value) => Value::String(String::from_utf8_lossy(&value).into_owned()),
        RedisValue::Push { kind, data } => json!({ "kind": format!("{kind:?}"), "data": data.into_iter().map(redis_json).collect::<Vec<_>>() }),
        RedisValue::ServerError(error) => json!({ "error": error.to_string() }),
        _ => Value::String("Unsupported Redis response".into()),
    }
}

fn connection_error(error: redis::RedisError) -> DbError { DbError::Connection(error.to_string()) }
fn query_error(error: redis::RedisError) -> DbError { DbError::Query(error.to_string()) }
fn schema_error(error: redis::RedisError) -> DbError { DbError::Schema(error.to_string()) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_entries_become_dynamic_grid_columns() {
        let response = RedisValue::Array(vec![RedisValue::Array(vec![
            RedisValue::BulkString(b"1785762016193-0".to_vec()),
            RedisValue::Array(vec![
                RedisValue::BulkString(b"message".to_vec()),
                RedisValue::BulkString(br#"{"asset_id":"Q2JD-QNXV-9KVT"}"#.to_vec()),
                RedisValue::BulkString(b"event_type".to_vec()),
                RedisValue::BulkString(b"Created".to_vec()),
            ]),
        ])]);

        let result = stream_query_result(&response, 4).expect("valid stream response");
        assert_eq!(result.columns.iter().map(|column| column.name.as_str()).collect::<Vec<_>>(),
            vec!["Entry ID", "message", "event_type"]);
        assert_eq!(result.rows[0][0], json!("1785762016193-0"));
        assert_eq!(result.rows[0][1], json!(r#"{"asset_id":"Q2JD-QNXV-9KVT"}"#));
        assert_eq!(result.rows[0][2], json!("Created"));
    }
}
