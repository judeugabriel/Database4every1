import { invoke } from "@tauri-apps/api/core";
import type {
  BackendError,
  QueryResult,
  SchemaTree,
} from "../types/database";
import type { ConnectionConfig, ConnectionWorkspace } from "../types/connection";

export async function fetchSchemaTree(connectionId: string): Promise<SchemaTree> {
  return invoke<SchemaTree>("get_schema_tree", { connectionId });
}

export async function refreshSchemaCache(connectionId: string): Promise<void> {
  return invoke<void>("refresh_schema_cache", { connectionId });
}

export async function executeQuery(
  connectionId: string,
  query: string,
  limit: number,
  queryId: string,
): Promise<QueryResult> {
  return invoke<QueryResult>("run_query", {
    connectionId,
    queryId,
    query,
    limit,
  });
}

export async function cancelQuery(queryId: string): Promise<boolean> {
  return invoke<boolean>("cancel_query", { queryId });
}

export async function connectDatabase(connectionId: string, config: ConnectionConfig) {
  try {
    return await invoke<void>("connect_db", { connectionId, config });
  } catch (error) {
    const normalized = normalizeBackendError(error);
    if (normalized.code !== "SSH_HOST_KEY_UNKNOWN" || !config.ssh_tunnel_config) throw error;
    const details = normalized.details as Partial<{
      host: string;
      port: number;
      algorithm: string;
      fingerprint: string;
    }> | undefined;
    const host = details?.host ?? config.ssh_tunnel_config.host;
    const port = details?.port ?? config.ssh_tunnel_config.port;
    const accepted = window.confirm(
      `The SSH host '${host}:${port}' is not trusted yet.\n\n` +
      `Algorithm: ${details?.algorithm ?? "Unknown"}\n` +
      `Fingerprint: ${details?.fingerprint ?? "Unavailable"}\n\n` +
      "Only continue if you recognize this server. Add this key to known_hosts?",
    );
    if (!accepted) throw error;
    return invoke<void>("connect_db", {
      connectionId,
      config: {
        ...config,
        ssh_tunnel_config: {
          ...config.ssh_tunnel_config,
          accept_new_host_key: true,
          expected_host_key_fingerprint: details?.fingerprint,
        },
      },
    });
  }
}

export async function disconnectDatabase(connectionId: string) {
  return invoke<void>("disconnect_db", { connectionId });
}

export async function deleteStoredConnection(connectionId: string): Promise<void> {
  return invoke<void>("delete_connection", { connectionId });
}

export async function loadConnectionWorkspace(): Promise<ConnectionWorkspace> {
  return invoke<ConnectionWorkspace>("load_connection_workspace");
}

export async function saveConnectionWorkspace(workspace: ConnectionWorkspace): Promise<void> {
  return invoke<void>("save_connection_workspace", { workspace });
}

export function normalizeBackendError(error: unknown): BackendError {
  if (typeof error === "object" && error !== null) {
    const candidate = error as Partial<BackendError>;
    if (typeof candidate.message === "string") {
      return {
        code: candidate.code ?? "UNKNOWN",
        message: candidate.message,
        details: candidate.details,
      };
    }
  }
  return {
    code: "UNKNOWN",
    message: error instanceof Error ? error.message : String(error),
  };
}
