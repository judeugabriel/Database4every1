import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  Activity,
  CircleStop,
  Command,
  PanelLeftClose,
  Play,
  Plus,
  Settings2,
  X,
} from "lucide-react";
import "./App.css";
import appIcon from "../src-tauri/icons/icon.png";
import * as XLSX from "xlsx";
import { QueryPanel, formatDuration } from "./components/QueryPanel";
import { TabBar } from "./components/tabs/TabBar";
import { ConnectionModal } from "./components/ConnectionModal";
import { SchemaSidebar } from "./components/SchemaSidebar";
import { DataSourceTransferModal } from "./components/sidebar/DataSourceTransferModal";
import {
  WorkspaceContext,
  type QueryActivity,
} from "./components/WorkspaceContext";
import {
  connectDatabase,
  deleteStoredConnection,
  disconnectDatabase,
  fetchSchemaTree,
  executeQuery,
  loadConnectionWorkspace,
  normalizeBackendError,
  refreshSchemaCache,
  saveConnectionWorkspace,
} from "./services/database";
import {
  buildCompletionCatalog,
  type ConnectionSummary,
  type ConnectionConfig,
  type ConnectionGroup,
  type ConnectionWorkspace,
  type ExplorerSortPreferences,
  type SchemaTree,
} from "./types/database";
import { buildObjectPreviewQuery } from "./utils/queryTemplates";
import { resolveConnectionConfig } from "./utils/connectionVariables";
import {
  createDataSourceBundle,
  mergeDataSourceBundle,
  parseDataSourceBundle,
  type DataSourceBundle,
} from "./utils/workspaceTransfer";

const INITIAL_CONNECTIONS: ConnectionSummary[] = [
  {
    id: "local-postgres",
    label: "Local PostgreSQL",
    engine: "postgresql",
    accent: "#5aa7ff",
    groupId: "group-local",
    config: {
      id: "local-postgres",
      groupId: "group-local",
      db_type: "postgresql",
      host: "localhost",
      port: 5432,
      database: "northwind",
      username: "postgres",
      ssl_mode: "prefer",
    },
  },
  {
    id: "analytics-mysql",
    label: "Analytics MySQL",
    engine: "mysql",
    accent: "#f5a65b",
    groupId: "group-staging",
    config: {
      id: "analytics-mysql",
      groupId: "group-staging",
      db_type: "mysql",
      host: "localhost",
      port: 3306,
      database: "analytics",
      username: "root",
      ssl_mode: "prefer",
    },
  },
];

const INITIAL_GROUPS: ConnectionGroup[] = [
  {
    id: "group-local",
    name: "Local Dev",
    color: "#3B82F6",
    icon: "Database",
    isExpanded: true,
  },
  {
    id: "group-staging",
    name: "Staging",
    color: "#F59E0B",
    icon: "Server",
    isExpanded: true,
  },
];

const EMPTY_SCHEMA: SchemaTree = { databases: [] };
const DEFAULT_EXPLORER_SORT: ExplorerSortPreferences = {
  groups: "name_asc",
  connections: "name_asc",
};

const PREVIEW_SCHEMA: SchemaTree = {
  databases: [
    {
      name: "northwind",
      collections: [],
      schemas: [
        {
          name: "public",
          collections: [],
          views: [
            {
              name: "active_customers",
              columns: [
                { name: "id", data_type: "uuid", nullable: false },
                { name: "company_name", data_type: "varchar", nullable: false },
              ],
            },
          ],
          tables: [
            {
              name: "customers",
              columns: [
                { name: "id", data_type: "uuid", nullable: false },
                { name: "company_name", data_type: "varchar", nullable: false },
                { name: "email", data_type: "varchar", nullable: true },
                { name: "created_at", data_type: "timestamptz", nullable: false },
              ],
            },
            {
              name: "orders",
              columns: [
                { name: "id", data_type: "bigint", nullable: false },
                { name: "customer_id", data_type: "uuid", nullable: false },
                { name: "status", data_type: "varchar", nullable: false },
                { name: "total", data_type: "numeric", nullable: false },
                { name: "ordered_at", data_type: "timestamp", nullable: false },
              ],
            },
            {
              name: "products",
              columns: [
                { name: "id", data_type: "bigint", nullable: false },
                { name: "name", data_type: "varchar", nullable: false },
                { name: "unit_price", data_type: "numeric", nullable: false },
                { name: "in_stock", data_type: "integer", nullable: false },
              ],
            },
          ],
        },
      ],
    },
  ],
};

function App() {
  const [connections, setConnections] = useState(INITIAL_CONNECTIONS);
  const [groups, setGroups] = useState(INITIAL_GROUPS);
  const [sortPreferences, setSortPreferences] = useState<ExplorerSortPreferences>(DEFAULT_EXPLORER_SORT);
  const [dataSourceTransfer, setDataSourceTransfer] = useState<
    { mode: "export" } | { mode: "import"; bundle: DataSourceBundle }
  >();
  const [storageReady, setStorageReady] = useState(false);
  const [activeConnectionId, setActiveConnectionId] = useState(INITIAL_CONNECTIONS[0].id);
  const [connectionModal, setConnectionModal] = useState<{
    connection?: ConnectionSummary;
    duplicate?: boolean;
  }>();
  const [schemaByConnection, setSchemaByConnection] = useState<Record<string, SchemaTree>>({
    [INITIAL_CONNECTIONS[0].id]: PREVIEW_SCHEMA,
  });
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaError, setSchemaError] = useState<string>();
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [limit, setLimit] = useState(500);
  const [runRequest, setRunRequest] = useState(0);
  const [cancelRequest, setCancelRequest] = useState(0);
  const [activity, setActivity] = useState<QueryActivity>({
    running: false,
    elapsedMs: 0,
    status: "idle",
  });
  const [hasActiveQueryTab, setHasActiveQueryTab] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const dockviewApi = useRef<DockviewApi | undefined>(undefined);
  const queryOrdinal = useRef(0);
  const workspaceMutation = useRef(0);
  const workspaceSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const connectionAttempts = useRef(new Map<string, Promise<SchemaTree | undefined>>());

  const persistWorkspace = useCallback((workspace: ConnectionWorkspace) => {
    const save = workspaceSaveQueue.current
      .catch(() => undefined)
      .then(() => saveConnectionWorkspace(workspace));
    workspaceSaveQueue.current = save;
    return save;
  }, []);

  const activeConnection = connections.find(
    (connection) => connection.id === activeConnectionId,
  );
  const schema = schemaByConnection[activeConnectionId] ?? EMPTY_SCHEMA;
  const completionCatalogByConnection = useMemo(
    () => Object.fromEntries(
      Object.entries(schemaByConnection).map(([connectionId, connectionSchema]) => [
        connectionId,
        buildCompletionCatalog(connectionSchema),
      ]),
    ),
    [schemaByConnection],
  );

  const loadSchemaFor = useCallback(async (connectionId: string) => {
    if (!connectionId) return;
    setSchemaLoading(true);
    setSchemaError(undefined);
    try {
      await refreshSchemaCache(connectionId);
      const nextSchema = await fetchSchemaTree(connectionId);
      setSchemaByConnection((current) => ({
        ...current,
        [connectionId]: nextSchema,
      }));
      return nextSchema;
    } catch (error) {
      setSchemaError(
        typeof error === "object" && error && "message" in error
          ? String(error.message)
          : "Connection is not active. Showing preview metadata.",
      );
    } finally {
      setSchemaLoading(false);
    }
  }, []);

  const loadSchema = useCallback(
    () => loadSchemaFor(activeConnectionId),
    [activeConnectionId, loadSchemaFor],
  );

  const connectAndLoadConnection = useCallback(async (connectionId: string) => {
    const pending = connectionAttempts.current.get(connectionId);
    if (pending) return pending;
    const connection = connections.find((item) => item.id === connectionId);
    if (!connection?.config) {
      setSchemaError("This connection has no saved configuration.");
      return undefined;
    }
    const attempt = (async () => {
      setSchemaLoading(true);
      setSchemaError(undefined);
      try {
        await connectDatabase(connectionId, resolveConnectionConfig(connection.config!, groups));
      } catch (error) {
        const normalized = normalizeBackendError(error);
        if (normalized.code !== "CONNECTION_ALREADY_EXISTS") {
          setSchemaError(normalized.message);
          return undefined;
        }
      }
      return loadSchemaFor(connectionId);
    })().finally(() => connectionAttempts.current.delete(connectionId));
    connectionAttempts.current.set(connectionId, attempt);
    return attempt;
  }, [connections, groups, loadSchemaFor]);

  const ensureExportConnection = useCallback(async (connectionId: string) => {
    const connection = connections.find((item) => item.id === connectionId);
    if (!connection?.config) throw new Error("This connection has no saved configuration.");
    try {
      await connectDatabase(connectionId, resolveConnectionConfig(connection.config, groups));
    } catch (error) {
      const normalized = normalizeBackendError(error);
      if (normalized.code !== "CONNECTION_ALREADY_EXISTS") throw error;
    }
    await refreshSchemaCache(connectionId);
    const nextSchema = await fetchSchemaTree(connectionId);
    setSchemaByConnection((current) => ({ ...current, [connectionId]: nextSchema }));
    return nextSchema;
  }, [connections, groups]);

  const selectConnection = useCallback((connectionId: string) => {
    setActiveConnectionId(connectionId);
    void connectAndLoadConnection(connectionId);
  }, [connectAndLoadConnection]);

  useEffect(() => {
    if (storageReady && activeConnectionId) void connectAndLoadConnection(activeConnectionId);
  }, [activeConnectionId, connectAndLoadConnection, storageReady]);

  useEffect(() => {
    let active = true;
    const loadGeneration = workspaceMutation.current;
    void loadConnectionWorkspace()
      .then((workspace) => {
        if (!active || workspaceMutation.current !== loadGeneration) return;
        if (workspace.hasInitializedDefaults) {
          setConnections(workspace.connections);
          setGroups(workspace.groups);
          setSortPreferences(workspace.sortPreferences ?? DEFAULT_EXPLORER_SORT);
          if (workspace.connections.length > 0) {
            setActiveConnectionId(workspace.connections[0].id);
          } else {
            setActiveConnectionId("");
          }
        }
      })
      .catch(() => undefined)
      .finally(() => active && setStorageReady(true));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    const timeout = window.setTimeout(() => {
      void persistWorkspace({ hasInitializedDefaults: true, groups, connections, sortPreferences })
        .catch((error) => setSchemaError(normalizeBackendError(error).message));
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [connections, groups, persistWorkspace, sortPreferences, storageReady]);

  const addQueryTab = useCallback(() => {
    const api = dockviewApi.current;
    if (!api) return;
    const ordinal = ++queryOrdinal.current;
    api.addPanel({
      id: `query-${crypto.randomUUID()}`,
      component: "query",
      tabComponent: "queryTab",
      title: queryTabTitle(activeConnection, groups, `Query ${ordinal}`),
      params: {
        ordinal,
        connection: activeConnection,
        tabColor: queryTabColor(activeConnection, groups),
        initialQuery: initialQueryFor(activeConnection?.engine),
      },
    });
  }, [activeConnection, groups]);

  const openSchemaObject = useCallback(
    (name: string, _kind: "table" | "view" | "collection", databaseName?: string) => {
      const api = dockviewApi.current;
      if (!api) return;
      const ordinal = ++queryOrdinal.current;
      api.addPanel({
        id: `query-${crypto.randomUUID()}`,
        component: "query",
        tabComponent: "queryTab",
        title: queryTabTitle(activeConnection, groups, name),
        params: {
          ordinal,
          connection: activeConnection,
          tabColor: queryTabColor(activeConnection, groups),
          editableTarget: activeConnection ? { name, kind: _kind, databaseName } : undefined,
          initialQuery: buildObjectPreviewQuery(activeConnection?.engine, name, limit, databaseName),
          autoRun: true,
        },
      });
    },
    [activeConnection, groups, limit],
  );

  const importSchemaObject = useCallback((name: string, kind: "table" | "view" | "collection") => {
    if (!activeConnection || kind === "view") return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,.json,.xls,.xlsx,.xml";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const records = await readImportRecords(file);
        if (records.length === 0) throw new Error("The selected file contains no records");
        if (activeConnection.engine === "elasticsearch") {
          for (const record of records) {
            await executeQuery(activeConnection.id, `POST /${name}/_doc\n${JSON.stringify(record)}`, 1, crypto.randomUUID());
          }
        } else if (["postgresql", "mysql", "sqlite", "mssql"].includes(activeConnection.engine)) {
          const columns = [...new Set(records.flatMap((record) => Object.keys(record)))];
          const quote = (value: string) => activeConnection.engine === "mysql" ? `\`${value.split("`").join("``")}\`` : `"${value.split('"').join('""')}"`;
          const target = name.split(".").map(quote).join(".");
          for (let offset = 0; offset < records.length; offset += 250) {
            const values = records.slice(offset, offset + 250).map((record) => `(${columns.map((column) => sqlImportValue(record[column])).join(",")})`).join(",");
            await executeQuery(activeConnection.id, `INSERT INTO ${target} (${columns.map(quote).join(",")}) VALUES ${values};`, 1, crypto.randomUUID());
          }
        } else throw new Error("Import is currently supported for SQL tables and Elasticsearch indices");
        await loadSchemaFor(activeConnection.id);
        window.alert(`Imported ${records.length.toLocaleString()} records into ${name}.`);
      } catch (error) { window.alert(error instanceof Error ? error.message : String(error)); }
    };
    input.click();
  }, [activeConnection, loadSchemaFor]);

  const onDockReady = useCallback(
    (event: DockviewReadyEvent) => {
      dockviewApi.current = event.api;
      setHasActiveQueryTab(Boolean(event.api.activePanel));
      event.api.onDidActivePanelChange(() => {
        setHasActiveQueryTab(Boolean(event.api.activePanel));
        setActivity({ running: false, elapsedMs: 0, status: "idle" });
      });
    },
    [],
  );

  const workspaceValue = useMemo(
    () => ({
      completionCatalogByConnection,
      defaultLimit: limit,
      runRequest,
      cancelRequest,
      reportActivity: setActivity,
      connections,
      groups,
      ensureConnection: ensureExportConnection,
    }),
    [cancelRequest, completionCatalogByConnection, connections, ensureExportConnection, groups, limit, runRequest],
  );

  const isRunDisabled = !hasActiveQueryTab || activity.running;

  const saveConnection = useCallback(
    async (summary: ConnectionSummary, config: ConnectionConfig) => {
      if (connections.some((item) => item.id === summary.id)) {
        await disconnectDatabase(summary.id).catch(() => undefined);
      }
      await connectDatabase(summary.id, resolveConnectionConfig(config, groups));
      setConnections((current) => {
        const index = current.findIndex((item) => item.id === summary.id);
        if (index < 0) return [...current, summary];
        const next = [...current];
        next[index] = summary;
        return next;
      });
      setActiveConnectionId(summary.id);
      await loadSchemaFor(summary.id);
    },
    [connections, groups, loadSchemaFor],
  );

  const updateGroups = useCallback(async (nextGroups: ConnectionGroup[]) => {
    const changedGroupIds = new Set(
      groups
        .filter((group) => {
          const next = nextGroups.find((candidate) => candidate.id === group.id);
          return !next || JSON.stringify(next.variables ?? {}) !== JSON.stringify(group.variables ?? {});
        })
        .map((group) => group.id),
    );
    for (const connection of connections) {
      if (connection.groupId && changedGroupIds.has(connection.groupId)) {
        void disconnectDatabase(connection.id).catch(() => undefined);
      }
    }
    setGroups(nextGroups);
    await persistWorkspace({
      hasInitializedDefaults: true,
      groups: nextGroups,
      connections,
      sortPreferences,
    });
  }, [connections, groups, persistWorkspace, sortPreferences]);

  const updateConnections = useCallback(
    (nextConnections: ConnectionSummary[]) => {
      const nextIds = new Set(nextConnections.map((connection) => connection.id));
      for (const connection of connections) {
        if (!nextIds.has(connection.id)) {
          void deleteStoredConnection(connection.id).catch(() => undefined);
        }
      }
      setConnections(nextConnections);
      if (!nextIds.has(activeConnectionId) && nextConnections.length > 0) {
        setActiveConnectionId(nextConnections[0].id);
      }
    },
    [activeConnectionId, connections],
  );

  const deleteConnection = useCallback(
    async (connection: ConnectionSummary): Promise<boolean> => {
      const deletingActive = connection.id === activeConnectionId;
      const tabWarning = deletingActive && (dockviewApi.current?.totalPanels ?? 0) > 0
        ? " Open query tabs using this connection will also be closed."
        : "";
      if (!window.confirm(
        `Are you sure you want to delete connection '${connection.label}'?${tabWarning}`,
      )) return false;

      workspaceMutation.current += 1;
      await deleteStoredConnection(connection.id);
      if (deletingActive) {
        for (const panel of [...(dockviewApi.current?.panels ?? [])]) panel.api.close();
      }
      const remaining = connections.filter((item) => item.id !== connection.id);
      setConnections(remaining);
      // Deletion is cleanup only. Do not select/connect/test another data
      // source as a side effect of removing the active connection.
      if (deletingActive) setActiveConnectionId("");
      await saveConnectionWorkspace({
        hasInitializedDefaults: true,
        groups,
        connections: remaining,
        sortPreferences,
      });
      return true;
    },
    [activeConnectionId, connections, groups, sortPreferences],
  );

  const selectImportBundle = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Database4every1 Data Sources", extensions: ["json", "db4e1"] }],
      });
      if (!selected || Array.isArray(selected)) return;
      const text = await invoke<string>("read_import_file", { path: selected });
      setDataSourceTransfer({ mode: "import", bundle: parseDataSourceBundle(text) });
    } catch (error) {
      setSchemaError(normalizeBackendError(error).message);
    }
  }, []);

  const exportDataSources = useCallback(async (
    selectedGroupIds: Set<string>,
    selectedConnectionIds: Set<string>,
    includeSecrets: boolean,
  ) => {
    const bundle = createDataSourceBundle(
      groups,
      connections,
      selectedGroupIds,
      selectedConnectionIds,
      includeSecrets,
    );
    const path = await save({
      defaultPath: `database4every1-data-sources-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "Database4every1 Data Sources", extensions: ["json"] }],
    });
    if (!path) return;
    const bytes = new TextEncoder().encode(JSON.stringify(bundle, null, 2));
    await invoke("save_export_file", { path, data: bytesToBase64(bytes) });
  }, [connections, groups]);

  const importDataSources = useCallback(async (
    bundle: DataSourceBundle,
    selectedGroupIds: Set<string>,
    selectedConnectionIds: Set<string>,
  ) => {
    const merged = mergeDataSourceBundle(
      groups,
      connections,
      bundle,
      selectedGroupIds,
      selectedConnectionIds,
    );
    workspaceMutation.current += 1;
    setGroups(merged.groups);
    setConnections(merged.connections);
    await persistWorkspace({
      hasInitializedDefaults: true,
      groups: merged.groups,
      connections: merged.connections,
      sortPreferences,
    });
  }, [connections, groups, persistWorkspace, sortPreferences]);

  return (
    <WorkspaceContext.Provider value={workspaceValue}>
      <div className="app-shell">
        <header className="topbar">
          <div className="brand">
            <span className="brand-icon">
              <img src={appIcon} alt="" />
            </span>
            <span>Database4every1</span>
          </div>

          <button
            className="toolbar-icon"
            onClick={() => setSidebarVisible((visible) => !visible)}
            title="Toggle database explorer"
          >
            <PanelLeftClose size={17} />
          </button>
          <div className="toolbar-divider" />

          <button
            className="run-button"
            disabled={isRunDisabled}
            onClick={() => {
              if (!isRunDisabled) setRunRequest((value) => value + 1);
            }}
            title={
              !hasActiveQueryTab
                ? "Open a query tab to run a query"
                : undefined
            }
          >
            <Play size={14} fill="currentColor" />
            Run query
            <kbd>
              <Command size={11} />↵
            </kbd>
          </button>
          {activity.running && (
            <button
              className="stop-button"
              onClick={() => setCancelRequest((value) => value + 1)}
            >
              <CircleStop size={14} /> Stop
            </button>
          )}

          <span className={`execution-timer ${activity.status}`}>
            {activity.running ? <span className="activity-pulse" /> : <Activity size={13} />}
            {formatDuration(activity.elapsedMs)}
          </span>

          <span className="topbar-spacer" />
          <button className="toolbar-icon" title="New query" onClick={addQueryTab}>
            <Plus size={17} />
          </button>
          <button
            type="button"
            className="toolbar-icon"
            title="Settings"
            aria-label="Open settings"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 size={17} />
          </button>
        </header>

        <div className="workspace">
          {sidebarVisible && (
            <SchemaSidebar
              connections={connections}
              groups={groups}
              activeConnectionId={activeConnectionId}
              schema={schema}
              loading={schemaLoading}
              error={schemaError}
              onSelectConnection={selectConnection}
              onRefresh={() => void loadSchema()}
              onAddConnection={() => setConnectionModal({})}
              onEditConnection={(connection) => {
                const target = connection ?? activeConnection;
                if (target) setConnectionModal({ connection: target });
              }}
              onDuplicateConnection={(connection) => setConnectionModal({ connection, duplicate: true })}
              onGroupsChange={updateGroups}
              onConnectionsChange={updateConnections}
              onDeleteConnection={(connection) => void deleteConnection(connection)}
              onRefreshConnection={(connectionId) => void connectAndLoadConnection(connectionId)}
              sortPreferences={sortPreferences}
              onSortPreferencesChange={setSortPreferences}
              onExportDataSources={() => setDataSourceTransfer({ mode: "export" })}
              onImportDataSources={() => void selectImportBundle()}
              onOpenObject={openSchemaObject}
              onImportObject={importSchemaObject}
            />
          )}
          <main className="dock-area">
            <DockviewReact
              className="dockview-theme-abyss"
              components={{ query: QueryPanel }}
              tabComponents={{ queryTab: TabBar }}
              onReady={onDockReady}
              disableFloatingGroups
            />
          </main>
        </div>
        {connectionModal !== undefined && (
          <ConnectionModal
            connection={connectionModal.connection}
            duplicate={connectionModal.duplicate}
            groups={groups}
            onClose={() => setConnectionModal(undefined)}
            onSave={saveConnection}
            onDelete={connectionModal.connection && !connectionModal.duplicate
              ? () => deleteConnection(connectionModal.connection!)
              : undefined}
          />
        )}
        {dataSourceTransfer && (
          <DataSourceTransferModal
            mode={dataSourceTransfer.mode}
            groups={dataSourceTransfer.mode === "import" ? dataSourceTransfer.bundle.groups : groups}
            connections={dataSourceTransfer.mode === "import" ? dataSourceTransfer.bundle.connections : connections}
            onClose={() => setDataSourceTransfer(undefined)}
            onConfirm={(groupIds, connectionIds, includeSecrets) =>
              dataSourceTransfer.mode === "export"
                ? exportDataSources(groupIds, connectionIds, includeSecrets)
                : importDataSources(dataSourceTransfer.bundle, groupIds, connectionIds)
            }
          />
        )}
        {settingsOpen && (
          <div
            className="settings-layer"
            role="presentation"
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) setSettingsOpen(false);
            }}
          >
            <section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
              <header>
                <div>
                  <span className="eyebrow">Application</span>
                  <h2 id="settings-title">Settings</h2>
                </div>
                <button type="button" className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="Close settings">
                  <X size={16} />
                </button>
              </header>
              <label>
                <span>Default query limit</span>
                <select value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
                  {[50, 100, 200, 500, 1_000].map((value) => <option key={value} value={value}>{value.toLocaleString()}</option>)}
                </select>
              </label>
              <label className="settings-checkbox">
                <input type="checkbox" checked={sidebarVisible} onChange={(event) => setSidebarVisible(event.target.checked)} />
                <span>Show database explorer</span>
              </label>
              <footer>
                <button type="button" className="primary-button" onClick={() => setSettingsOpen(false)}>Done</button>
              </footer>
            </section>
          </div>
        )}
      </div>
    </WorkspaceContext.Provider>
  );
}

function queryTabTitle(
  connection: ConnectionSummary | undefined,
  groups: ConnectionGroup[],
  subject: string,
): string {
  if (!connection) return `[No connection] ${subject}`;
  const group = groups.find((item) => item.id === connection.groupId);
  return group
    ? `[(${group.name}) ${connection.label}] ${subject}`
    : `[${connection.label}] ${subject}`;
}

function queryTabColor(
  connection: ConnectionSummary | undefined,
  groups: ConnectionGroup[],
): string {
  if (!connection) return "#64748B";
  return groups.find((item) => item.id === connection.groupId)?.color
    ?? connection.accent
    ?? "#64748B";
}

function initialQueryFor(engine?: ConnectionSummary["engine"]) {
  if (engine === "mongodb") {
    return `db.customers.find({\n  "active": true\n})`;
  }
  if (engine === "elasticsearch") {
    return `POST /customers/_search\n{\n  "query": { "match_all": {} }\n}`;
  }
  if (engine === "redis") {
    return `SCAN 0 MATCH * COUNT 200`;
  }
  return `SELECT\n  c.company_name,\n  COUNT(o.id) AS order_count,\n  SUM(o.total) AS lifetime_value\nFROM public.customers c\nJOIN public.orders o ON o.customer_id = c.id\nWHERE o.status = 'completed'\nGROUP BY c.id, c.company_name\nORDER BY lifetime_value DESC;`;
}

async function readImportRecords(file: File): Promise<Record<string, unknown>[]> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "json") {
    const value = JSON.parse(await file.text());
    return (Array.isArray(value) ? value : [value]) as Record<string, unknown>[];
  }
  if (extension === "xml") {
    const document = new DOMParser().parseFromString(await file.text(), "application/xml");
    if (document.querySelector("parsererror")) throw new Error("Invalid XML file");
    return [...document.querySelectorAll("row")].map((row) => Object.fromEntries([...row.children].map((field) => [field.tagName, field.textContent ?? ""])));
  }
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
}

function sqlImportValue(value: unknown) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `'${text.split("'").join("''")}'`;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export default App;
