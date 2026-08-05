use std::{collections::BTreeMap, time::Instant};

use async_trait::async_trait;
use futures_util::TryStreamExt;
use mongodb::{
    bson::{doc, Bson, Document},
    options::ClientOptions,
    Client, Database,
};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::RwLock;
use url::Url;

use super::{
    ssh_tunnel::SshTunnel, CollectionNode, ColumnMeta, ConnectionConfig, DatabaseDriver,
    DatabaseNode, DbError, QueryResult, SchemaTree, SslMode,
};

struct MongoConnection {
    client: Client,
    database_name: String,
}

#[derive(Default)]
pub struct MongoDbDriver {
    connection: RwLock<Option<MongoConnection>>,
    tunnel: RwLock<Option<SshTunnel>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FindEnvelope {
    collection: String,
    #[serde(default)]
    filter: Document,
    projection: Option<Document>,
    sort: Option<Document>,
    skip: Option<u64>,
}

enum MongoMutation {
    Insert { collection: String, document: Document },
    Update { collection: String, filter: Document, update: Document },
    Delete { collection: String, filter: Document },
}

impl MongoDbDriver {
    pub fn new() -> Self {
        Self::default()
    }

    async fn database(&self) -> Result<Database, DbError> {
        let connection = self.connection.read().await;
        let connection = connection
            .as_ref()
            .ok_or_else(|| DbError::Connection("MongoDB driver is not connected".into()))?;
        Ok(connection.client.database(&connection.database_name))
    }
}

#[async_trait]
impl DatabaseDriver for MongoDbDriver {
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
        let database_name = config.database.clone().ok_or_else(|| {
            DbError::InvalidConfiguration("MongoDB requires a database name".into())
        })?;
        let mut url = Url::parse("mongodb://localhost")
            .map_err(|error| DbError::InvalidConfiguration(error.to_string()))?;
        url.set_host(Some(connect_host))
            .map_err(|_| DbError::InvalidConfiguration("invalid MongoDB host".into()))?;
        url.set_port(Some(connect_port))
            .map_err(|_| DbError::InvalidConfiguration("invalid MongoDB port".into()))?;
        url.set_path(&format!("/{database_name}"));
        if let Some(username) = &config.username {
            url.set_username(username)
                .map_err(|_| DbError::InvalidConfiguration("invalid MongoDB username".into()))?;
        }
        if let Some(password) = &config.password {
            url.set_password(Some(password))
                .map_err(|_| DbError::InvalidConfiguration("invalid MongoDB password".into()))?;
        }
        if !matches!(config.ssl_mode, SslMode::Disable) {
            url.query_pairs_mut().append_pair("tls", "true");
        }

        let options = ClientOptions::parse(url.as_str())
            .await
            .map_err(|error| DbError::Connection(error.to_string()))?;
        let client = Client::with_options(options)
            .map_err(|error| DbError::Connection(error.to_string()))?;
        client
            .database("admin")
            .run_command(doc! { "ping": 1 })
            .await
            .map_err(|error| DbError::Connection(error.to_string()))?;
        *self.connection.write().await = Some(MongoConnection {
            client,
            database_name,
        });
        *self.tunnel.write().await = tunnel;
        Ok(())
    }

    async fn execute_query(&self, query: &str, limit: usize) -> Result<QueryResult, DbError> {
        let database = self.database().await?;
        if let Some(mutation) = parse_mutation_query(query)? {
            let started = Instant::now();
            let affected = match mutation {
                MongoMutation::Insert { collection, document } => {
                    database.collection::<Document>(&collection).insert_one(document).await.map_err(query_error)?;
                    1
                }
                MongoMutation::Update { collection, filter, update } => database
                    .collection::<Document>(&collection).update_one(filter, update).await.map_err(query_error)?.modified_count,
                MongoMutation::Delete { collection, filter } => database
                    .collection::<Document>(&collection).delete_one(filter).await.map_err(query_error)?.deleted_count,
            };
            return Ok(QueryResult { columns: Vec::new(), rows: Vec::new(), execution_time_ms: started.elapsed().as_millis(), total_affected: affected, total_records: None });
        }
        let request = parse_find_query(query)?;
        let started = Instant::now();
        let collection = database.collection::<Document>(&request.collection);
        let total_records = collection
            .count_documents(request.filter.clone())
            .await
            .map_err(query_error)?;
        let mut find = collection
            .find(request.filter)
            .limit(limit.min(i64::MAX as usize) as i64);
        if let Some(projection) = request.projection {
            find = find.projection(projection);
        }
        if let Some(sort) = request.sort {
            find = find.sort(sort);
        }
        if let Some(skip) = request.skip {
            find = find.skip(skip);
        }
        let documents: Vec<Document> = find
            .await
            .map_err(query_error)?
            .try_collect()
            .await
            .map_err(query_error)?;

        let mut fields = BTreeMap::new();
        for document in &documents {
            infer_document_fields(document, "", &mut fields);
        }
        let columns: Vec<ColumnMeta> = fields
            .into_iter()
            .map(|(name, data_type)| ColumnMeta {
                name,
                data_type,
                nullable: true,
            })
            .collect();
        let rows = documents
            .into_iter()
            .map(|document| {
                columns
                    .iter()
                    .map(|column| {
                        bson_path(&document, &column.name)
                            .map(bson_json)
                            .unwrap_or(Value::Null)
                    })
                    .collect()
            })
            .collect();

        Ok(QueryResult {
            columns,
            rows,
            execution_time_ms: started.elapsed().as_millis(),
            total_affected: 0,
            total_records: Some(total_records),
        })
    }

    async fn fetch_schema(&self) -> Result<SchemaTree, DbError> {
        let database = self.database().await?;
        let names = database
            .list_collection_names()
            .await
            .map_err(schema_error)?;
        let mut collections = Vec::with_capacity(names.len());

        for name in names {
            let samples: Vec<Document> = database
                .collection::<Document>(&name)
                .find(doc! {})
                .limit(100)
                .await
                .map_err(schema_error)?
                .try_collect()
                .await
                .map_err(schema_error)?;
            let mut fields = BTreeMap::new();
            for sample in &samples {
                infer_document_fields(sample, "", &mut fields);
            }
            collections.push(CollectionNode {
                name,
                columns: fields
                    .into_iter()
                    .map(|(name, data_type)| ColumnMeta {
                        name,
                        data_type,
                        nullable: true,
                    })
                    .collect(),
            });
        }

        Ok(SchemaTree {
            databases: vec![DatabaseNode {
                name: database.name().to_owned(),
                schemas: Vec::new(),
                collections,
            }],
        })
    }

    async fn test_connection(&self) -> Result<bool, DbError> {
        self.database()
            .await?
            .run_command(doc! { "ping": 1 })
            .await
            .map(|_| true)
            .map_err(|error| DbError::Connection(error.to_string()))
    }
}

fn parse_mutation_query(query: &str) -> Result<Option<MongoMutation>, DbError> {
    let query = query.trim().trim_end_matches(';').trim();
    let Some(rest) = query.strip_prefix("db.") else { return Ok(None) };
    for (operation, kind) in [(".insertOne(", "insert"), (".updateOne(", "update"), (".deleteOne(", "delete")] {
        let Some((collection, arguments)) = rest.split_once(operation) else { continue };
        let arguments = arguments.strip_suffix(')').ok_or_else(|| DbError::Query(format!("invalid MongoDB {kind} syntax")))?;
        let parts = split_top_level(arguments)?;
        return match kind {
            "insert" => Ok(Some(MongoMutation::Insert {
                collection: collection.to_owned(),
                document: parse_document(parts.first().copied().unwrap_or("{}"), "insert document")?,
            })),
            "update" => {
                if parts.len() < 2 { return Err(DbError::Query("updateOne requires a filter and update document".into())); }
                Ok(Some(MongoMutation::Update {
                    collection: collection.to_owned(),
                    filter: parse_document(parts[0], "update filter")?,
                    update: parse_document(parts[1], "update document")?,
                }))
            }
            _ => Ok(Some(MongoMutation::Delete {
                collection: collection.to_owned(),
                filter: parse_document(parts.first().copied().unwrap_or("{}"), "delete filter")?,
            })),
        };
    }
    Ok(None)
}

fn parse_find_query(query: &str) -> Result<FindEnvelope, DbError> {
    let query = query.trim().trim_end_matches(';').trim();
    if query.starts_with('{') {
        return serde_json::from_str(query).map_err(|error| {
            DbError::Query(format!("invalid MongoDB JSON query envelope: {error}"))
        });
    }
    if let Some(rest) = query.strip_prefix("db.") {
        let (collection, expression) = rest
            .split_once(".find(")
            .ok_or_else(|| DbError::Query("expected db.<collection>.find(<filter>)".into()))?;
        let close = matching_parenthesis(expression).ok_or_else(|| {
            DbError::Query("Mongo find expression has unbalanced parentheses".into())
        })?;
        let arguments = &expression[..close];
        let tail = expression[close + 1..].trim();
        let parts = split_top_level(arguments)?;
        let filter = parse_document(parts.first().copied().unwrap_or("{}"), "filter")?;
        let projection = parts
            .get(1)
            .map(|value| parse_document(value, "projection"))
            .transpose()?;
        let sort = chain_argument(tail, "sort")
            .map(|value| parse_document(value, "sort"))
            .transpose()?;
        let skip = chain_argument(tail, "skip")
            .map(|value| value.trim().parse::<u64>())
            .transpose()
            .map_err(|error| DbError::Query(format!("invalid MongoDB skip: {error}")))?;
        return Ok(FindEnvelope {
            collection: collection.to_owned(),
            filter,
            projection,
            sort,
            skip,
        });
    }
    if query.len() >= 14 && query[..14].eq_ignore_ascii_case("SELECT * FROM ") {
        let rest = query[14..].trim();
        let (collection, filter) = match_ci_once(rest, " WHERE ")
            .map(|(collection, filter)| (collection, filter))
            .unwrap_or((rest, "{}"));
        return Ok(FindEnvelope {
            collection: collection.trim().to_owned(),
            filter: parse_document(filter, "WHERE filter")?,
            projection: None,
            sort: None,
            skip: None,
        });
    }
    Err(DbError::Query(
        "use a JSON envelope, db.<collection>.find({...}), or SELECT * FROM <collection> WHERE {...}"
            .into(),
    ))
}

fn matching_parenthesis(expression: &str) -> Option<usize> {
    let mut depth = 1_i32;
    let mut quoted = false;
    let mut escaped = false;
    for (index, character) in expression.char_indices() {
        if quoted {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                quoted = false;
            }
            continue;
        }
        match character {
            '"' => quoted = true,
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

fn chain_argument<'a>(tail: &'a str, method: &str) -> Option<&'a str> {
    let marker = format!(".{method}(");
    let start = tail.find(&marker)? + marker.len();
    let rest = &tail[start..];
    let close = matching_parenthesis(rest)?;
    Some(rest[..close].trim())
}

fn parse_document(input: &str, label: &str) -> Result<Document, DbError> {
    serde_json::from_str(input.trim())
        .map_err(|error| DbError::Query(format!("invalid MongoDB {label}: {error}")))
}

fn split_top_level(input: &str) -> Result<Vec<&str>, DbError> {
    let mut depth = 0_i32;
    let mut quoted = false;
    let mut escaped = false;
    let mut start = 0;
    let mut parts = Vec::new();
    for (index, character) in input.char_indices() {
        if quoted {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                quoted = false;
            }
            continue;
        }
        match character {
            '"' => quoted = true,
            '{' | '[' => depth += 1,
            '}' | ']' => depth -= 1,
            ',' if depth == 0 => {
                parts.push(input[start..index].trim());
                start = index + 1;
            }
            _ => {}
        }
        if depth < 0 {
            return Err(DbError::Query("unbalanced MongoDB expression".into()));
        }
    }
    if quoted || depth != 0 {
        return Err(DbError::Query("unbalanced MongoDB expression".into()));
    }
    if !input.trim().is_empty() {
        parts.push(input[start..].trim());
    }
    Ok(parts)
}

fn match_ci_once<'a>(value: &'a str, needle: &str) -> Option<(&'a str, &'a str)> {
    let index = value
        .to_ascii_uppercase()
        .find(&needle.to_ascii_uppercase())?;
    Some((&value[..index], &value[index + needle.len()..]))
}

fn infer_document_fields(document: &Document, prefix: &str, fields: &mut BTreeMap<String, String>) {
    for (name, value) in document {
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}.{name}")
        };
        fields
            .entry(path.clone())
            .and_modify(|current| {
                let incoming = bson_type(value);
                if current != incoming {
                    *current = "mixed".into();
                }
            })
            .or_insert_with(|| bson_type(value).into());
        if let Bson::Document(nested) = value {
            infer_document_fields(nested, &path, fields);
        }
    }
}

fn bson_path<'a>(document: &'a Document, path: &str) -> Option<&'a Bson> {
    let mut parts = path.split('.');
    let mut value = document.get(parts.next()?)?;
    for part in parts {
        value = value.as_document()?.get(part)?;
    }
    Some(value)
}

fn bson_json(value: &Bson) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

fn bson_type(value: &Bson) -> &'static str {
    match value {
        Bson::Double(_) => "double",
        Bson::String(_) => "string",
        Bson::Array(_) => "array",
        Bson::Document(_) => "object",
        Bson::Boolean(_) => "boolean",
        Bson::Null => "null",
        Bson::RegularExpression(_) => "regex",
        Bson::JavaScriptCode(_) | Bson::JavaScriptCodeWithScope(_) => "javascript",
        Bson::Int32(_) => "int32",
        Bson::Int64(_) => "int64",
        Bson::Timestamp(_) => "timestamp",
        Bson::Binary(_) => "binary",
        Bson::ObjectId(_) => "objectId",
        Bson::DateTime(_) => "date",
        Bson::Symbol(_) => "symbol",
        Bson::Decimal128(_) => "decimal128",
        Bson::Undefined => "undefined",
        Bson::MaxKey => "maxKey",
        Bson::MinKey => "minKey",
        Bson::DbPointer(_) => "dbPointer",
    }
}

fn query_error(error: mongodb::error::Error) -> DbError {
    DbError::Query(error.to_string())
}

fn schema_error(error: mongodb::error::Error) -> DbError {
    DbError::Schema(error.to_string())
}
