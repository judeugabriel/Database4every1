use std::{collections::BTreeMap, time::Instant};

use async_trait::async_trait;
use elasticsearch::{
    auth::Credentials,
    cert::CertificateValidation,
    http::{
        headers::HeaderMap,
        request::JsonBody,
        transport::{SingleNodeConnectionPool, TransportBuilder},
        Method,
    },
    indices::IndicesGetMappingParts,
    Elasticsearch,
};
use serde_json::{json, Map, Value};
use tokio::sync::RwLock;
use url::Url;

use super::{
    ssh_tunnel::SshTunnel, ColumnMeta, ConnectionConfig, DatabaseDriver, DatabaseNode, DbError,
    QueryResult, SchemaNode, SchemaTree, SslMode, TableNode,
};

struct ElasticsearchConnection {
    client: Elasticsearch,
    default_index: Option<String>,
}

#[derive(Default)]
pub struct ElasticsearchDriver {
    connection: RwLock<Option<ElasticsearchConnection>>,
    tunnel: RwLock<Option<SshTunnel>>,
}

enum ElasticsearchQuery {
    Dsl {
        method: ElasticsearchHttpMethod,
        index: String,
        body: Value,
    },
    Sql(Value),
    IndexDocument { index: String, body: Value },
    Mutation { method: Method, path: String, body: Option<Value> },
}

#[derive(Clone, Copy)]
enum ElasticsearchHttpMethod {
    Get,
    Post,
}

impl From<ElasticsearchHttpMethod> for Method {
    fn from(method: ElasticsearchHttpMethod) -> Self {
        match method {
            ElasticsearchHttpMethod::Get => Method::Get,
            ElasticsearchHttpMethod::Post => Method::Post,
        }
    }
}

impl ElasticsearchDriver {
    pub fn new() -> Self {
        Self::default()
    }

    async fn client(&self) -> Result<(Elasticsearch, Option<String>), DbError> {
        let connection = self.connection.read().await;
        let connection = connection
            .as_ref()
            .ok_or_else(|| DbError::Connection("Elasticsearch driver is not connected".into()))?;
        Ok((connection.client.clone(), connection.default_index.clone()))
    }
}

#[async_trait]
impl DatabaseDriver for ElasticsearchDriver {
    async fn connect(&self, config: &ConnectionConfig) -> Result<(), DbError> {
        let ssh_connect_timeout = config
            .ssh_tunnel_config
            .as_ref()
            .map(|ssh| std::time::Duration::from_secs(ssh.connect_timeout_secs.unwrap_or(15).clamp(1, 300)));
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
        let scheme = if matches!(config.ssl_mode, SslMode::Disable) {
            "http"
        } else {
            "https"
        };
        let url = Url::parse(&format!("{scheme}://{connect_host}:{connect_port}"))
            .map_err(|error| DbError::InvalidConfiguration(error.to_string()))?;
        let pool = SingleNodeConnectionPool::new(url);
        let mut builder = TransportBuilder::new(pool);
        if config.ignore_tls.unwrap_or(false) {
            builder = builder.cert_validation(CertificateValidation::None);
        }
        if let Some(username) = &config.username {
            builder = builder.auth(Credentials::Basic(
                username.clone(),
                config.password.clone().unwrap_or_default(),
            ));
        }
        let transport = builder
            .build()
            .map_err(|error| DbError::Connection(error.to_string()))?;
        let client = Elasticsearch::new(transport);
        let mut ping = client.ping();
        if let Some(timeout) = ssh_connect_timeout {
            ping = ping.request_timeout(timeout);
        }
        let response = ping.send().await.map_err(|error| {
            let hint = if tunnel.is_some()
                && !matches!(config.ssl_mode, SslMode::Disable)
                && !config.ignore_tls.unwrap_or(false)
            {
                " The SSH tunnel connects through 127.0.0.1; if this is a TLS hostname/certificate mismatch on a self-signed development cluster, enable 'Insecure / Ignore TLS Certificate Verification'."
            } else {
                ""
            };
            DbError::Connection(format!("Elasticsearch connection through SSH failed: {error}.{hint}"))
        })?;
        if !response.status_code().is_success() {
            return Err(DbError::Connection(format!(
                "Elasticsearch returned HTTP {}",
                response.status_code()
            )));
        }
        *self.connection.write().await = Some(ElasticsearchConnection {
            client,
            default_index: config.database.clone(),
        });
        *self.tunnel.write().await = tunnel;
        Ok(())
    }

    async fn execute_query(&self, query: &str, limit: usize) -> Result<QueryResult, DbError> {
        let (client, default_index) = self.client().await?;
        let request = parse_query(query, default_index.as_deref())?;
        let started = Instant::now();
        let body = match request {
            ElasticsearchQuery::Dsl {
                method,
                index,
                mut body,
            } => {
                if let Some(object) = body.as_object_mut() {
                    object
                        .entry("size")
                        .or_insert_with(|| json!(limit.min(i64::MAX as usize)));
                }
                apply_nested_sort_contexts(&client, &index, &mut body).await?;
                execute_pit_search(&client, method, &index, body).await?
            }
            ElasticsearchQuery::Sql(body) => {
                let response = client
                    .sql()
                    .query()
                    .body(body)
                    .send()
                    .await
                    .map_err(query_error)?;
                response_body(response).await?
            }
            ElasticsearchQuery::IndexDocument { index, body } => {
                let response = client
                    .send(
                        Method::Post,
                        &format!("/{index}/_doc"),
                        HeaderMap::new(),
                        None::<&()>,
                        Some(JsonBody::new(body)),
                        None,
                    )
                    .await
                    .map_err(query_error)?;
                response_body(response).await?
            }
            ElasticsearchQuery::Mutation { method, path, body } => {
                let response = client
                    .send(method, &path, HeaderMap::new(), None::<&()>, body.map(JsonBody::new), None)
                    .await
                    .map_err(query_error)?;
                response_body(response).await?
            }
        };

        if body.get("result").is_some() && body.get("_index").is_some() {
            Ok(QueryResult { columns: Vec::new(), rows: Vec::new(), execution_time_ms: started.elapsed().as_millis(), total_affected: 1, total_records: None })
        } else if body.get("columns").is_some() && body.get("rows").is_some() {
            sql_result(body, started.elapsed().as_millis())
        } else {
            search_result(body, started.elapsed().as_millis())
        }
    }

    async fn fetch_schema(&self) -> Result<SchemaTree, DbError> {
        let (client, _) = self.client().await?;
        let response = client
            .indices()
            .get_mapping(IndicesGetMappingParts::None)
            .send()
            .await
            .map_err(schema_error)?;
        let status = response.status_code();
        let body: Value = response.json().await.map_err(schema_error)?;
        if !status.is_success() {
            return Err(DbError::Schema(format!(
                "Elasticsearch returned HTTP {status}: {}",
                body.get("error").unwrap_or(&body)
            )));
        }

        let mut tables = Vec::new();
        if let Some(indices) = body.as_object() {
            for (index_name, mapping) in indices {
                let mut fields = BTreeMap::new();
                if let Some(properties) = mapping
                    .pointer("/mappings/properties")
                    .and_then(Value::as_object)
                {
                    mapping_fields(properties, "", &mut fields);
                }
                tables.push(TableNode {
                    name: index_name.clone(),
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
        }

        Ok(SchemaTree {
            databases: vec![DatabaseNode {
                name: "elasticsearch".into(),
                schemas: vec![SchemaNode {
                    name: "indices".into(),
                    tables,
                    views: Vec::new(),
                    collections: Vec::new(),
                }],
                collections: Vec::new(),
            }],
        })
    }

    async fn test_connection(&self) -> Result<bool, DbError> {
        let (client, _) = self.client().await?;
        client
            .ping()
            .send()
            .await
            .map(|response| response.status_code().is_success())
            .map_err(|error| DbError::Connection(error.to_string()))
    }
}

/// Elasticsearch does not infer the nested document context from a dotted
/// field name. Look up the index mapping and enrich generated sort entries
/// before opening the PIT. Explicit user-provided `nested` options are kept.
async fn apply_nested_sort_contexts(
    client: &Elasticsearch,
    index: &str,
    body: &mut Value,
) -> Result<(), DbError> {
    let Some(sort_items) = body.get_mut("sort").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    let sortable_fields: Vec<String> = sort_items
        .iter()
        .filter_map(|item| item.as_object())
        .flat_map(|item| item.keys())
        .filter(|field| field.contains('.') && !field.starts_with('_'))
        .cloned()
        .collect();
    if sortable_fields.is_empty() {
        return Ok(());
    }

    let response = client
        .send(
            Method::Get,
            &format!("/{index}/_mapping"),
            HeaderMap::new(),
            None::<&()>,
            None::<JsonBody<Value>>,
            None,
        )
        .await
        .map_err(schema_error)?;
    let status = response.status_code();
    let mapping: Value = response.json().await.map_err(schema_error)?;
    if !status.is_success() {
        return Err(DbError::Schema(format!(
            "Elasticsearch returned HTTP {status} while resolving nested sort fields: {}",
            mapping.get("error").unwrap_or(&mapping)
        )));
    }
    let properties = mapping
        .get(index)
        .or_else(|| mapping.as_object().and_then(|indices| indices.values().next()))
        .and_then(|index_mapping| index_mapping.pointer("/mappings/properties"))
        .and_then(Value::as_object);
    let Some(properties) = properties else { return Ok(()) };

    for item in sort_items {
        let Some(sort) = item.as_object_mut() else { continue };
        for (field, options) in sort {
            let Some(nested_path) = nested_path_for_field(properties, field) else { continue };
            if options.is_string() {
                let order = options.take();
                *options = json!({ "order": order, "nested": { "path": nested_path } });
            } else if let Some(options) = options.as_object_mut() {
                options
                    .entry("nested")
                    .or_insert_with(|| json!({ "path": nested_path }));
            }
        }
    }
    Ok(())
}

fn nested_path_for_field(properties: &Map<String, Value>, field: &str) -> Option<String> {
    let segments: Vec<&str> = field.split('.').collect();
    let mut current = properties;
    let mut path = String::new();
    let mut nested_path = None;
    for (index, segment) in segments.iter().enumerate() {
        let definition = current.get(*segment)?;
        if !path.is_empty() {
            path.push('.');
        }
        path.push_str(segment);
        if definition.get("type").and_then(Value::as_str) == Some("nested") {
            nested_path = Some(path.clone());
        }
        if index + 1 < segments.len() {
            current = definition
                .get("properties")
                .or_else(|| definition.get("fields"))?
                .as_object()?;
        }
    }
    nested_path
}

async fn execute_pit_search(
    client: &Elasticsearch,
    _method: ElasticsearchHttpMethod,
    index: &str,
    mut body: Value,
) -> Result<Value, DbError> {
    let object = body
        .as_object_mut()
        .ok_or_else(|| DbError::Query("Elasticsearch search body must be an object".into()))?;
    let offset = object.remove("from").and_then(|value| value.as_u64()).unwrap_or(0);
    let page_size = object
        .get("size")
        .and_then(Value::as_u64)
        .unwrap_or(200)
        .clamp(1, 10_000);
    object.insert("track_total_hits".into(), Value::Bool(true));

    let pit_path = format!("/{index}/_pit");
    let keep_alive = [("keep_alive", "2m")];
    let pit_response = client
        .send(
            Method::Post,
            &pit_path,
            HeaderMap::new(),
            Some(&keep_alive),
            None::<JsonBody<Value>>,
            None,
        )
        .await
        .map_err(query_error)?;
    let pit_body = response_body(pit_response).await?;
    let pit_id = pit_body
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| DbError::Query("Elasticsearch did not return a PIT id".into()))?
        .to_owned();

    let result = execute_pit_pages(client, body, &pit_id, offset, page_size).await;

    // PIT cleanup is best-effort; it must not hide a successful search response.
    let _ = client
        .send(
            Method::Delete,
            "/_pit",
            HeaderMap::new(),
            None::<&()>,
            Some(JsonBody::new(json!({ "id": pit_id }))),
            None,
        )
        .await;
    result
}

async fn execute_pit_pages(
    client: &Elasticsearch,
    mut body: Value,
    pit_id: &str,
    offset: u64,
    page_size: u64,
) -> Result<Value, DbError> {
    {
        let object = body.as_object_mut().expect("validated Elasticsearch body");
        object.insert("pit".into(), json!({ "id": pit_id, "keep_alive": "2m" }));
        ensure_pit_sort(object);
    }

    let mut remaining = offset;
    let mut search_after: Option<Value> = None;
    while remaining > 0 {
        let batch_size = remaining.min(10_000);
        {
            let object = body.as_object_mut().expect("validated Elasticsearch body");
            object.insert("size".into(), json!(batch_size));
            set_search_after(object, search_after.as_ref());
        }
        let page = send_pit_page(client, &body).await?;
        let hits = page
            .pointer("/hits/hits")
            .and_then(Value::as_array)
            .ok_or_else(|| DbError::Query("Elasticsearch PIT response has no hits.hits".into()))?;
        if hits.is_empty() {
            return Ok(page);
        }
        remaining = remaining.saturating_sub(hits.len() as u64);
        search_after = hits.last().and_then(|hit| hit.get("sort")).cloned();
        if hits.len() < batch_size as usize && remaining > 0 {
            return Ok(page);
        }
    }

    {
        let object = body.as_object_mut().expect("validated Elasticsearch body");
        object.insert("size".into(), json!(page_size));
        set_search_after(object, search_after.as_ref());
    }
    send_pit_page(client, &body).await
}

fn ensure_pit_sort(object: &mut Map<String, Value>) {
    let sort = object
        .entry("sort")
        .or_insert_with(|| Value::Array(Vec::new()));
    if !sort.is_array() {
        *sort = Value::Array(vec![sort.clone()]);
    }
    let items = sort.as_array_mut().expect("sort was converted to an array");
    let has_tiebreaker = items.iter().any(|item| {
        item.as_str() == Some("_shard_doc")
            || item.as_object().is_some_and(|value| value.contains_key("_shard_doc"))
    });
    if !has_tiebreaker {
        items.push(json!({ "_shard_doc": "asc" }));
    }
}

fn set_search_after(object: &mut Map<String, Value>, value: Option<&Value>) {
    if let Some(value) = value {
        object.insert("search_after".into(), value.clone());
    } else {
        object.remove("search_after");
    }
}

async fn send_pit_page(client: &Elasticsearch, body: &Value) -> Result<Value, DbError> {
    let response = client
        .send(
            Method::Post,
            "/_search",
            HeaderMap::new(),
            None::<&()>,
            Some(JsonBody::new(body.clone())),
            None,
        )
        .await
        .map_err(query_error)?;
    response_body(response).await
}

async fn response_body(response: elasticsearch::http::response::Response) -> Result<Value, DbError> {
    let status = response.status_code();
    let body: Value = response.json().await.map_err(query_error)?;
    if status.is_success() {
        Ok(body)
    } else {
        Err(DbError::Query(format!(
            "Elasticsearch returned HTTP {status}: {}",
            body.get("error").unwrap_or(&body)
        )))
    }
}

fn parse_query(query: &str, default_index: Option<&str>) -> Result<ElasticsearchQuery, DbError> {
    let query = query.trim();
    if query.to_ascii_uppercase().starts_with("SELECT ") {
        return Ok(ElasticsearchQuery::Sql(json!({ "query": query })));
    }
    let uppercase = query.to_ascii_uppercase();
    if uppercase.starts_with("POST ") || uppercase.starts_with("GET ") || uppercase.starts_with("DELETE ") {
        let (request_line, body_text) = query.split_once('\n').unwrap_or((query, ""));
        let (method, path) = request_line
            .split_once(char::is_whitespace)
            .ok_or_else(|| {
                DbError::Query("expected GET or POST followed by an Elasticsearch endpoint".into())
            })?;
        let method_name = method.to_ascii_uppercase();
        if method_name == "DELETE" {
            if !body_text.trim().is_empty() {
                return Err(DbError::Query("DELETE requests must not include a JSON body".into()));
            }
            return Ok(ElasticsearchQuery::Mutation { method: Method::Delete, path: path.trim().to_owned(), body: None });
        }
        let method = match method_name.as_str() {
            "GET" => ElasticsearchHttpMethod::Get,
            "POST" => ElasticsearchHttpMethod::Post,
            _ => {
                return Err(DbError::Query(
                    "only GET and POST requests are supported".into(),
                ))
            }
        };
        let path = path.trim();
        if body_text.trim().is_empty() {
            return Err(DbError::Query("expected a JSON body after the Elasticsearch request line".into()));
        }
        let body: Value = serde_json::from_str(body_text)
            .map_err(|error| DbError::Query(format!("invalid Elasticsearch JSON: {error}")))?;
        if path.trim_end_matches('/') == "/_sql" {
            return Ok(ElasticsearchQuery::Sql(body));
        }
        if let Some(index) = path.strip_prefix('/').and_then(|path| path.strip_suffix("/_doc")).filter(|index| !index.is_empty()) {
            return Ok(ElasticsearchQuery::IndexDocument { index: index.to_owned(), body });
        }
        if path.contains("/_update/") {
            return Ok(ElasticsearchQuery::Mutation { method: Method::Post, path: path.to_owned(), body: Some(body) });
        }
        let index = path
            .strip_prefix('/')
            .and_then(|path| path.strip_suffix("/_search"))
            .filter(|index| !index.is_empty())
            .ok_or_else(|| DbError::Query("expected GET or POST /<index>/_search".into()))?;
        return Ok(ElasticsearchQuery::Dsl {
            method,
            index: index.to_owned(),
            body,
        });
    }

    let body: Value = serde_json::from_str(query)
        .map_err(|error| DbError::Query(format!("invalid Elasticsearch JSON: {error}")))?;
    if let Some(index) = body.get("index").and_then(Value::as_str) {
        let dsl = body
            .get("body")
            .or_else(|| body.get("dsl"))
            .cloned()
            .unwrap_or_else(|| json!({ "query": { "match_all": {} } }));
        return Ok(ElasticsearchQuery::Dsl {
            method: ElasticsearchHttpMethod::Post,
            index: index.to_owned(),
            body: dsl,
        });
    }
    let index = default_index.ok_or_else(|| {
        DbError::Query(
            "raw Elasticsearch DSL requires config.database as the default index, an index envelope, or POST /<index>/_search"
                .into(),
        )
    })?;
    Ok(ElasticsearchQuery::Dsl {
        method: ElasticsearchHttpMethod::Post,
        index: index.to_owned(),
        body,
    })
}

fn search_result(body: Value, elapsed: u128) -> Result<QueryResult, DbError> {
    let hits = body
        .pointer("/hits/hits")
        .and_then(Value::as_array)
        .ok_or_else(|| DbError::Query("Elasticsearch response did not contain hits.hits".into()))?;
    let mut field_names = BTreeMap::new();
    let mut flattened = Vec::with_capacity(hits.len());
    for hit in hits {
        let mut fields = BTreeMap::new();
        if let Some(source) = hit.get("_source").and_then(Value::as_object) {
            flatten_json(source, "", &mut fields);
        }
        if let Some(id) = hit.get("_id") {
            fields.insert("_id".into(), id.clone());
        }
        for (name, value) in &fields {
            field_names
                .entry(name.clone())
                .or_insert_with(|| json_type(value));
        }
        flattened.push(fields);
    }
    let columns: Vec<ColumnMeta> = field_names
        .into_iter()
        .map(|(name, data_type)| ColumnMeta {
            name,
            data_type,
            nullable: true,
        })
        .collect();
    let rows = flattened
        .into_iter()
        .map(|fields| {
            columns
                .iter()
                .map(|column| fields.get(&column.name).cloned().unwrap_or(Value::Null))
                .collect()
        })
        .collect();
    Ok(QueryResult {
        columns,
        rows,
        execution_time_ms: body
            .get("took")
            .and_then(Value::as_u64)
            .map(u128::from)
            .unwrap_or(elapsed),
        total_affected: 0,
        total_records: body
            .pointer("/hits/total/value")
            .and_then(Value::as_u64)
            .or_else(|| body.pointer("/hits/total").and_then(Value::as_u64)),
    })
}

fn sql_result(body: Value, elapsed: u128) -> Result<QueryResult, DbError> {
    let columns = body["columns"]
        .as_array()
        .ok_or_else(|| DbError::Query("SQL response columns must be an array".into()))?
        .iter()
        .map(|column| ColumnMeta {
            name: column["name"].as_str().unwrap_or_default().to_owned(),
            data_type: column["type"].as_str().unwrap_or("unknown").to_owned(),
            nullable: true,
        })
        .collect();
    let rows = body["rows"]
        .as_array()
        .ok_or_else(|| DbError::Query("SQL response rows must be an array".into()))?
        .iter()
        .map(|row| row.as_array().cloned().unwrap_or_default())
        .collect();
    Ok(QueryResult {
        columns,
        rows,
        execution_time_ms: elapsed,
        total_affected: 0,
        total_records: None,
    })
}

fn mapping_fields(
    properties: &Map<String, Value>,
    prefix: &str,
    fields: &mut BTreeMap<String, String>,
) {
    for (name, definition) in properties {
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}.{name}")
        };
        let data_type = definition["type"].as_str().unwrap_or("object");
        fields.insert(path.clone(), data_type.to_owned());
        if let Some(nested) = definition.get("properties").and_then(Value::as_object) {
            mapping_fields(nested, &path, fields);
        }
        if let Some(multifields) = definition.get("fields").and_then(Value::as_object) {
            mapping_fields(multifields, &path, fields);
        }
    }
}

fn flatten_json(object: &Map<String, Value>, prefix: &str, fields: &mut BTreeMap<String, Value>) {
    for (name, value) in object {
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}.{name}")
        };
        if let Some(nested) = value.as_object() {
            flatten_json(nested, &path, fields);
        } else {
            fields.insert(path, value.clone());
        }
    }
}

fn json_type(value: &Value) -> String {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(number) if number.is_i64() || number.is_u64() => "integer",
        Value::Number(_) => "double",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
    .into()
}

fn query_error(error: elasticsearch::Error) -> DbError {
    DbError::Query(error.to_string())
}

fn schema_error(error: elasticsearch::Error) -> DbError {
    DbError::Schema(error.to_string())
}
