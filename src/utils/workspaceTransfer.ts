import type { ConnectionGroup, ConnectionSummary } from "../types/connection";

export const WORKSPACE_BUNDLE_KIND = "database4every1-data-sources";

export interface DataSourceBundle {
  kind: typeof WORKSPACE_BUNDLE_KIND;
  version: 1;
  exportedAt: string;
  groups: ConnectionGroup[];
  connections: ConnectionSummary[];
}

export function createDataSourceBundle(
  groups: ConnectionGroup[],
  connections: ConnectionSummary[],
  selectedGroupIds: Set<string>,
  selectedConnectionIds: Set<string>,
  includeSecrets: boolean,
): DataSourceBundle {
  const exportedGroups = groups
    .filter((group) => selectedGroupIds.has(group.id))
    .map(cloneGroup);
  const groupIds = new Set(exportedGroups.map((group) => group.id));
  const exportedConnections = connections
    .filter((connection) => selectedConnectionIds.has(connection.id))
    .map((connection) => {
      const groupId = connection.groupId && groupIds.has(connection.groupId)
        ? connection.groupId
        : undefined;
      return sanitizeConnection({
        ...connection,
        groupId,
        config: connection.config ? { ...connection.config, groupId } : undefined,
      }, includeSecrets);
    });
  return {
    kind: WORKSPACE_BUNDLE_KIND,
    version: 1,
    exportedAt: new Date().toISOString(),
    groups: exportedGroups,
    connections: exportedConnections,
  };
}

export function parseDataSourceBundle(text: string): DataSourceBundle {
  const candidate = JSON.parse(text) as Partial<DataSourceBundle>;
  if (
    candidate.kind !== WORKSPACE_BUNDLE_KIND ||
    candidate.version !== 1 ||
    !Array.isArray(candidate.groups) ||
    !Array.isArray(candidate.connections)
  ) {
    throw new Error("This is not a valid Database4every1 data-source bundle.");
  }
  return candidate as DataSourceBundle;
}

export function mergeDataSourceBundle(
  existingGroups: ConnectionGroup[],
  existingConnections: ConnectionSummary[],
  bundle: DataSourceBundle,
  selectedGroupIds: Set<string>,
  selectedConnectionIds: Set<string>,
) {
  const groupIdMap = new Map<string, string>();
  const usedGroupNames = existingGroups.map((item) => item.name);
  const importedGroups = bundle.groups
    .filter((group) => selectedGroupIds.has(group.id))
    .map((group) => {
      const id = `group-${crypto.randomUUID()}`;
      groupIdMap.set(group.id, id);
      const name = uniqueName(group.name, usedGroupNames);
      usedGroupNames.push(name);
      return { ...cloneGroup(group), id, name };
    });
  const usedConnectionNames = existingConnections.map((item) => item.label);
  const importedConnections = bundle.connections
    .filter((connection) => selectedConnectionIds.has(connection.id))
    .map((connection) => {
      const clone = structuredClone(connection);
      const id = `connection-${crypto.randomUUID()}`;
      const groupId = clone.groupId ? groupIdMap.get(clone.groupId) : undefined;
      const label = uniqueName(clone.label, usedConnectionNames);
      usedConnectionNames.push(label);
      return {
        ...clone,
        id,
        groupId,
        label,
        config: clone.config ? { ...clone.config, id, groupId } : undefined,
      };
    });
  return {
    groups: [...existingGroups, ...importedGroups],
    connections: [...existingConnections, ...importedConnections],
    importedGroupCount: importedGroups.length,
    importedConnectionCount: importedConnections.length,
  };
}

function sanitizeConnection(connection: ConnectionSummary, includeSecrets: boolean): ConnectionSummary {
  const clone = structuredClone(connection);
  if (clone.config?.ssh_tunnel_config) {
    clone.config.ssh_tunnel_config.accept_new_host_key = undefined;
  }
  if (includeSecrets || !clone.config) return clone;
  clone.config.password = portableCredential(clone.config.password);
  if (clone.config.ssh_tunnel_config) {
    clone.config.ssh_tunnel_config.password = portableCredential(
      clone.config.ssh_tunnel_config.password,
    );
    clone.config.ssh_tunnel_config.private_key_passphrase = portableCredential(
      clone.config.ssh_tunnel_config.private_key_passphrase,
    );
    clone.config.ssh_tunnel_config.private_key_path = undefined;
  }
  return clone;
}

function cloneGroup(group: ConnectionGroup): ConnectionGroup {
  return {
    ...structuredClone(group),
    variables: { ...(group.variables ?? {}) },
    variableSecrets: { ...(group.variableSecrets ?? {}) },
  };
}

function portableCredential(value?: string) {
  return value && /^\{\{[A-Za-z_][A-Za-z0-9_.-]*\}\}$/.test(value) ? value : undefined;
}

function uniqueName(name: string, existingNames: string[]) {
  const used = new Set(existingNames.map((item) => item.toLocaleLowerCase()));
  if (!used.has(name.toLocaleLowerCase())) return name;
  let suffix = 2;
  while (used.has(`${name} (Imported ${suffix})`.toLocaleLowerCase())) suffix += 1;
  return `${name} (Imported ${suffix})`;
}
