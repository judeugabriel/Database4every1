use std::{collections::BTreeMap, path::PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use tauri::{AppHandle, Manager, State};

use crate::db::{
    commands::{CommandError, DatabaseState},
    DbError,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionGroup {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub is_expanded: Option<bool>,
    #[serde(default)]
    pub variables: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredConnection {
    pub id: String,
    pub group_id: Option<String>,
    pub label: String,
    pub engine: String,
    pub accent: String,
    /// Stored connection forms may contain unresolved `{{group_variable}}`
    /// strings, including in numeric fields such as ports and timeouts. Keep
    /// this payload opaque while persisting it; `connect_db` receives the
    /// resolved and strictly typed `ConnectionConfig` separately.
    pub config: Option<Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionWorkspace {
    #[serde(default = "existing_workspace_is_initialized")]
    pub has_initialized_defaults: bool,
    #[serde(default)]
    pub groups: Vec<ConnectionGroup>,
    #[serde(default)]
    pub connections: Vec<StoredConnection>,
}

fn existing_workspace_is_initialized() -> bool {
    true
}

#[tauri::command]
pub async fn load_connection_workspace(
    app: AppHandle,
) -> Result<ConnectionWorkspace, CommandError> {
    read_connection_workspace(&app).await
}

async fn read_connection_workspace(app: &AppHandle) -> Result<ConnectionWorkspace, CommandError> {
    let path = workspace_path(&app)?;
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let mut workspace: ConnectionWorkspace = serde_json::from_slice(&bytes)
                .map_err(|error| storage_error(format!("invalid {}: {error}", path.display())))?;
            // File existence means the user has an established workspace. An empty
            // connection list must remain empty instead of restoring demo seeds.
            workspace.has_initialized_defaults = true;
            let before = workspace.connections.len();
            workspace.connections.retain(|connection| {
                !(connection.id == "documents-mongo"
                    && connection.label == "Documents"
                    && connection.engine == "mongodb")
            });
            if workspace.connections.len() != before {
                write_connection_workspace(app, &workspace).await?;
            }
            Ok(workspace)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(ConnectionWorkspace::default())
        }
        Err(error) => Err(storage_error(format!(
            "cannot read {}: {error}",
            path.display()
        ))),
    }
}

#[tauri::command]
pub async fn save_connection_workspace(
    app: AppHandle,
    workspace: ConnectionWorkspace,
) -> Result<(), CommandError> {
    write_connection_workspace(&app, &workspace).await
}

async fn write_connection_workspace(
    app: &AppHandle,
    workspace: &ConnectionWorkspace,
) -> Result<(), CommandError> {
    let path = workspace_path(&app)?;
    let directory = path
        .parent()
        .ok_or_else(|| storage_error("invalid application config directory"))?;
    tokio::fs::create_dir_all(directory)
        .await
        .map_err(|error| storage_error(format!("cannot create config directory: {error}")))?;
    let bytes = serde_json::to_vec_pretty(&workspace)
        .map_err(|error| storage_error(format!("cannot serialize connections: {error}")))?;
    let temporary = path.with_extension("json.tmp");
    tokio::fs::write(&temporary, bytes)
        .await
        .map_err(|error| storage_error(format!("cannot write connections: {error}")))?;
    restrict_permissions(&temporary).await?;
    tokio::fs::rename(&temporary, &path)
        .await
        .map_err(|error| storage_error(format!("cannot replace connections file: {error}")))?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn delete_connection(
    connection_id: String,
    app: AppHandle,
    state: State<'_, DatabaseState>,
) -> Result<(), CommandError> {
    // A saved connection is not necessarily active, so pool removal is idempotent.
    if state.connections.contains(&connection_id).await {
        state.connections.remove(&connection_id).await?;
    }
    state.schema_cache.write().await.remove(&connection_id);

    let mut workspace = read_connection_workspace(&app).await?;
    workspace
        .connections
        .retain(|connection| connection.id != connection_id);
    // Once a workspace has been written, an empty connection list is intentional.
    workspace.has_initialized_defaults = true;
    write_connection_workspace(&app, &workspace).await
}

fn workspace_path(app: &AppHandle) -> Result<PathBuf, CommandError> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("connections.json"))
        .map_err(|error| storage_error(format!("cannot resolve app config directory: {error}")))
}

#[cfg(unix)]
async fn restrict_permissions(path: &std::path::Path) -> Result<(), CommandError> {
    use std::os::unix::fs::PermissionsExt;
    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .await
        .map_err(|error| storage_error(format!("cannot secure connections file: {error}")))
}

#[cfg(not(unix))]
async fn restrict_permissions(_path: &std::path::Path) -> Result<(), CommandError> {
    Ok(())
}

fn storage_error(message: impl Into<String>) -> CommandError {
    CommandError::from(DbError::Other(anyhow::anyhow!(message.into())))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn save_export_file(path: String, data: String) -> Result<(), CommandError> {
    let bytes = BASE64
        .decode(data)
        .map_err(|error| storage_error(format!("invalid export data: {error}")))?;
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|error| storage_error(format!("cannot write export file: {error}")))
}
