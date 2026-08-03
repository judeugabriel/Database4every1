import { useMemo, useState } from "react";
import {
  Braces,
  ChevronDown,
  ChevronRight,
  Columns3,
  Database,
  FolderTree,
  Layers3,
  Plus,
  Pencil,
  RefreshCw,
  Search,
  Table2,
} from "lucide-react";
import type {
  CollectionNode,
  ConnectionSummary,
  SchemaTree,
  TableNode,
} from "../types/database";
import type { ConnectionGroup } from "../types/connection";
import { DatabaseTree } from "./sidebar/DatabaseTree";

interface SchemaSidebarProps {
  connections: ConnectionSummary[];
  groups: ConnectionGroup[];
  activeConnectionId: string;
  schema: SchemaTree;
  loading: boolean;
  error?: string;
  onSelectConnection: (id: string) => void;
  onRefresh: () => void;
  onAddConnection: () => void;
  onEditConnection: (connection?: ConnectionSummary) => void;
  onGroupsChange: (groups: ConnectionGroup[]) => void;
  onConnectionsChange: (connections: ConnectionSummary[]) => void;
  onDeleteConnection: (connection: ConnectionSummary) => void;
  onRefreshConnection: (connectionId: string) => void;
  onOpenObject: (name: string, kind: "table" | "view" | "collection", databaseName?: string) => void;
  onImportObject: (name: string, kind: "table" | "view" | "collection", databaseName?: string) => void;
}

export function SchemaSidebar({
  connections,
  groups,
  activeConnectionId,
  schema,
  loading,
  error,
  onSelectConnection,
  onRefresh,
  onAddConnection,
  onEditConnection,
  onGroupsChange,
  onConnectionsChange,
  onDeleteConnection,
  onRefreshConnection,
  onOpenObject,
  onImportObject,
}: SchemaSidebarProps) {
  const [filter, setFilter] = useState("");
  const normalizedFilter = filter.trim().toLowerCase();
  const activeEngine = connections.find((connection) => connection.id === activeConnectionId)?.engine;
  const filteredSchema = useMemo(
    () => filterSchema(sortSchemaTree(schema), normalizedFilter),
    [schema, normalizedFilter],
  );

  return (
    <aside className="sidebar">
      <div className="sidebar-heading">
        <div>
          <span className="eyebrow">Workspace</span>
          <h1>Data Sources</h1>
        </div>
        <div className="sidebar-heading-actions">
        <button className="icon-button" type="button" onClick={() => onEditConnection()} aria-label="Edit connection" title="Edit connection">
          <Pencil size={14} />
        </button>
        <button className="icon-button" type="button" onClick={onAddConnection} aria-label="Add connection" title="Add connection">
          <Plus size={16} />
        </button>
        </div>
      </div>

      <DatabaseTree
        groups={groups}
        connections={connections}
        activeConnectionId={activeConnectionId}
        onSelectConnection={onSelectConnection}
        onGroupsChange={onGroupsChange}
        onConnectionsChange={onConnectionsChange}
        onDeleteConnection={onDeleteConnection}
        onEditConnection={onEditConnection}
        onRefreshConnection={onRefreshConnection}
      />

      <div className="schema-toolbar">
        <span className="section-label">Database explorer</span>
        <button
          className={`icon-button ${loading ? "spinning" : ""}`}
          onClick={onRefresh}
          aria-label="Refresh schema"
          title="Refresh schema"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <label className="schema-search">
        <Search size={14} />
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter objects"
        />
        <kbd>⌥F</kbd>
      </label>

      <div className="schema-scroll">
        {error && <div className="schema-notice">{error}</div>}
        {!error && !loading && filteredSchema.databases.length === 0 && (
          <div className="schema-empty">
            <FolderTree size={24} />
            <span>No schema objects</span>
          </div>
        )}
        {filteredSchema.databases.map((database) => (
          <TreeBranch
            key={`${activeConnectionId}-${database.name}`}
            label={database.name}
            icon={<Database size={14} />}
          >
            {database.schemas.map((schemaNode) => (
              <TreeBranch
                key={`${activeConnectionId}-${database.name}-${schemaNode.name}`}
                label={schemaNode.name}
                icon={<Layers3 size={14} />}
              >
                {schemaNode.tables.map((table) => (
                  <ObjectNode key={`table-${table.name}`} object={table} queryName={activeEngine === "elasticsearch" ? table.name : `${schemaNode.name}.${table.name}`} databaseName={database.name} kind="table" onOpen={onOpenObject} onImport={onImportObject} />
                ))}
                {schemaNode.views.map((view) => (
                  <ObjectNode key={`view-${view.name}`} object={view} queryName={activeEngine === "elasticsearch" ? view.name : `${schemaNode.name}.${view.name}`} databaseName={database.name} kind="view" onOpen={onOpenObject} onImport={onImportObject} />
                ))}
                {schemaNode.collections.map((collection) => (
                  <ObjectNode
                    key={`collection-${collection.name}`}
                    object={collection}
                    kind="collection"
                    onOpen={onOpenObject}
                    onImport={onImportObject}
                  />
                ))}
              </TreeBranch>
            ))}
            {database.collections.map((collection) => (
              <ObjectNode
                key={`collection-${collection.name}`}
                object={collection}
                kind="collection"
                onOpen={onOpenObject}
                onImport={onImportObject}
              />
            ))}
          </TreeBranch>
        ))}
      </div>

      <div className="sidebar-footer">
        <span className="status-dot" /> Connected
        <span className="footer-spacer" />
        {countObjects(schema)} objects
      </div>
    </aside>
  );
}

function TreeBranch({
  label,
  icon,
  defaultOpen = false,
  children,
  onDoubleClick,
}: {
  label: string;
  icon: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  onDoubleClick?: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="tree-branch">
      <button
        className="tree-row"
        onClick={() => setOpen((value) => !value)}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onDoubleClick?.();
        }}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="tree-icon">{icon}</span>
        <span className="tree-label">{label}</span>
      </button>
      {open && <div className="tree-children">{children}</div>}
    </div>
  );
}

function ObjectNode({
  object,
  queryName,
  databaseName,
  kind,
  onOpen,
  onImport,
}: {
  object: TableNode | CollectionNode;
  queryName?: string;
  databaseName?: string;
  kind: "table" | "view" | "collection";
  onOpen: (name: string, kind: "table" | "view" | "collection", databaseName?: string) => void;
  onImport: (name: string, kind: "table" | "view" | "collection", databaseName?: string) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const icon = kind === "collection" ? <Braces size={14} /> : <Table2 size={14} />;
  return (
    <div onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY }); }}>
    <TreeBranch label={object.name} icon={icon} onDoubleClick={() => onOpen(queryName ?? object.name, kind, databaseName)}>
      {object.columns.map((column) => (
        <div className="column-row" key={column.name} title={column.data_type}>
          <Columns3 size={12} />
          <span>{column.name}</span>
          <small>{column.data_type}</small>
        </div>
      ))}
    </TreeBranch>
    {menu && <div className="group-context-menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
      <button onClick={() => { onOpen(queryName ?? object.name, kind, databaseName); setMenu(undefined); }}>Open data</button>
      {kind !== "view" && <button onClick={() => { onImport(queryName ?? object.name, kind, databaseName); setMenu(undefined); }}>Import CSV / JSON / XLS / XML…</button>}
      <button onClick={() => setMenu(undefined)}>Close</button>
    </div>}
    </div>
  );
}

function filterSchema(tree: SchemaTree, filter: string): SchemaTree {
  if (!filter) return tree;
  return {
    databases: tree.databases
      .map((database) => ({
        ...database,
        schemas: database.schemas
          .map((schema) => ({
            ...schema,
            tables: schema.tables.filter((item) => objectMatches(item, filter)),
            views: schema.views.filter((item) => objectMatches(item, filter)),
            collections: schema.collections.filter((item) => objectMatches(item, filter)),
          }))
          .filter(
            (schema) =>
              schema.name.toLowerCase().includes(filter) ||
              schema.tables.length > 0 ||
              schema.views.length > 0 ||
              schema.collections.length > 0,
          ),
        collections: database.collections.filter((item) => objectMatches(item, filter)),
      }))
      .filter(
        (database) =>
          database.name.toLowerCase().includes(filter) ||
          database.schemas.length > 0 ||
          database.collections.length > 0,
      ),
  };
}

function sortSchemaTree(tree: SchemaTree): SchemaTree {
  const compareNames = (left: { name: string }, right: { name: string }) =>
    left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  const sortObject = <T extends TableNode | CollectionNode>(object: T): T => ({
    ...object,
    columns: [...object.columns].sort(compareNames),
  });

  return {
    databases: [...tree.databases]
      .sort(compareNames)
      .map((database) => ({
        ...database,
        collections: database.collections.map(sortObject).sort(compareNames),
        schemas: [...database.schemas]
          .sort(compareNames)
          .map((schema) => ({
            ...schema,
            tables: schema.tables.map(sortObject).sort(compareNames),
            views: schema.views.map(sortObject).sort(compareNames),
            collections: schema.collections.map(sortObject).sort(compareNames),
          })),
      })),
  };
}

function objectMatches(item: TableNode | CollectionNode, filter: string) {
  return (
    item.name.toLowerCase().includes(filter) ||
    item.columns.some((column) => column.name.toLowerCase().includes(filter))
  );
}

function countObjects(tree: SchemaTree) {
  return tree.databases.reduce(
    (total, database) =>
      total +
      database.collections.length +
      database.schemas.reduce(
        (schemaTotal, schema) =>
          schemaTotal + schema.tables.length + schema.views.length + schema.collections.length,
        0,
      ),
    0,
  );
}
