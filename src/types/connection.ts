export interface ConnectionGroup {
  id: string;
  name: string;
  color?: string;
  icon?: "Folder" | "Server" | "ShieldAlert" | "Database";
  isExpanded?: boolean;
  variables?: Record<string, string>;
  variableSecrets?: Record<string, boolean>;
}

export type DatabaseEngine =
  | "postgresql"
  | "mysql"
  | "sqlite"
  | "mongodb"
  | "elasticsearch"
  | "redis";

export type SslMode = "disable" | "prefer" | "require" | "verify_ca" | "verify_full";

export interface SshTunnelConfig {
  host: string;
  port: number | string;
  username: string;
  password?: string;
  private_key_path?: string;
  private_key_passphrase?: string;
  connect_timeout_secs?: number | string;
  /** Transient trust-on-first-use approval; do not persist this value. */
  accept_new_host_key?: boolean;
  expected_host_key_fingerprint?: string;
}

export interface ConnectionConfig {
  id: string;
  groupId?: string;
  host: string;
  port: number | string;
  username?: string;
  password?: string;
  database?: string;
  ssl_mode: SslMode;
  ignore_tls?: boolean;
  ssh_tunnel_config?: SshTunnelConfig;
  db_type: DatabaseEngine;
}

export interface ConnectionSummary {
  id: string;
  groupId?: string;
  label: string;
  engine: DatabaseEngine;
  accent: string;
  config?: ConnectionConfig;
}

export type ExplorerSortOrder = "name_asc" | "name_desc" | "manual";

export interface ExplorerSortPreferences {
  groups: ExplorerSortOrder;
  connections: ExplorerSortOrder;
}

export interface ConnectionWorkspace {
  hasInitializedDefaults: boolean;
  groups: ConnectionGroup[];
  connections: ConnectionSummary[];
  sortPreferences?: ExplorerSortPreferences;
}
