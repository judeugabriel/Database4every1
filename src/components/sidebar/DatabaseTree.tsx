import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownAZ,
  ChevronDown,
  ChevronRight,
  Database,
  Copy,
  Download,
  Folder,
  FolderPlus,
  MoreHorizontal,
  RefreshCw,
  Server,
  ShieldAlert,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type {
  ConnectionGroup,
  ConnectionSummary,
  ExplorerSortOrder,
  ExplorerSortPreferences,
} from "../../types/connection";
import { DatabaseEngineIcon } from "../icons/DatabaseEngineIcon";

interface DatabaseTreeProps {
  groups: ConnectionGroup[];
  connections: ConnectionSummary[];
  activeConnectionId: string;
  onSelectConnection: (id: string) => void;
  onGroupsChange: (groups: ConnectionGroup[]) => void | Promise<void>;
  onConnectionsChange: (connections: ConnectionSummary[]) => void;
  onDeleteConnection: (connection: ConnectionSummary) => void;
  onEditConnection: (connection: ConnectionSummary) => void;
  onDuplicateConnection: (connection: ConnectionSummary) => void;
  onRefreshConnection: (connectionId: string) => void;
  sortPreferences: ExplorerSortPreferences;
  onSortPreferencesChange: (preferences: ExplorerSortPreferences) => void;
  onExport: () => void;
  onImport: () => void;
}

const COLORS = ["#EF4444", "#F59E0B", "#22C55E", "#3B82F6", "#8B5CF6", "#64748B"];
const ICONS: NonNullable<ConnectionGroup["icon"]>[] = [
  "Folder",
  "Server",
  "ShieldAlert",
  "Database",
];

export function DatabaseTree({
  groups,
  connections,
  activeConnectionId,
  onSelectConnection,
  onGroupsChange,
  onConnectionsChange,
  onDeleteConnection,
  onEditConnection,
  onDuplicateConnection,
  onRefreshConnection,
  sortPreferences,
  onSortPreferencesChange,
  onExport,
  onImport,
}: DatabaseTreeProps) {
  const [editor, setEditor] = useState<ConnectionGroup | null>();
  const [context, setContext] = useState<{ group: ConnectionGroup; x: number; y: number }>();
  const [connectionContext, setConnectionContext] = useState<{
    connection: ConnectionSummary;
    x: number;
    y: number;
  }>();
  const [sortOpen, setSortOpen] = useState(false);
  const orderedGroups = useMemo(
    () => sortItems(groups, sortPreferences.groups, (group) => group.name),
    [groups, sortPreferences.groups],
  );
  const orderedConnections = useMemo(
    () => sortItems(connections, sortPreferences.connections, (connection) => connection.label),
    [connections, sortPreferences.connections],
  );
  const ungrouped = orderedConnections.filter((connection) => !connection.groupId);

  useEffect(() => {
    const close = () => {
      setContext(undefined);
      setConnectionContext(undefined);
      setSortOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, []);

  const moveConnection = (connectionId: string, groupId?: string) => {
    onConnectionsChange(
      connections.map((connection) =>
        connection.id === connectionId
          ? {
              ...connection,
              groupId,
              config: connection.config
                ? { ...connection.config, groupId }
                : connection.config,
            }
          : connection,
      ),
    );
  };

  const saveGroup = async (group: ConnectionGroup) => {
    const exists = groups.some((item) => item.id === group.id);
    await onGroupsChange(exists ? groups.map((item) => (item.id === group.id ? group : item)) : [...groups, group]);
    setEditor(undefined);
  };

  const deleteGroup = (groupId: string, removeConnections: boolean) => {
    onGroupsChange(groups.filter((group) => group.id !== groupId));
    onConnectionsChange(
      removeConnections
        ? connections.filter((connection) => connection.groupId !== groupId)
        : connections.map((connection) =>
            connection.groupId === groupId
              ? {
                  ...connection,
                  groupId: undefined,
                  config: connection.config
                    ? { ...connection.config, groupId: undefined }
                    : connection.config,
                }
              : connection,
          ),
    );
    setContext(undefined);
  };

  const duplicateGroup = (source: ConnectionGroup) => {
    const groupId = `group-${crypto.randomUUID()}`;
    const duplicate: ConnectionGroup = {
      ...source,
      id: groupId,
      name: `${source.name} Copy`,
      isExpanded: true,
      variables: { ...source.variables },
      variableSecrets: { ...source.variableSecrets },
    };
    const duplicatedConnections = connections
      .filter((connection) => connection.groupId === source.id)
      .map((connection) => {
        const id = `connection-${crypto.randomUUID()}`;
        return {
          ...connection,
          id,
          groupId,
          config: connection.config
            ? { ...connection.config, id, groupId }
            : connection.config,
        };
      });
    onGroupsChange([...groups, duplicate]);
    onConnectionsChange([...connections, ...duplicatedConnections]);
    setContext(undefined);
    setEditor(duplicate);
  };

  return (
    <div className="database-tree">
      <div className="database-tree-toolbar">
        <button
          className="create-group-button"
          onClick={() =>
            setEditor({
              id: `group-${crypto.randomUUID()}`,
              name: "New Group",
              color: COLORS[3],
              icon: "Folder",
              isExpanded: true,
            })
          }
        >
          <FolderPlus size={14} /> Create New Group
        </button>
        <button
          type="button"
          className={`explorer-sort-button ${sortOpen ? "active" : ""}`}
          title="Sort data sources"
          aria-label="Choose group and connection sorting"
          aria-expanded={sortOpen}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setSortOpen((open) => !open)}
        >
          <ArrowDownAZ size={15} />
        </button>
        <button type="button" className="explorer-sort-button" title="Export data sources" aria-label="Export data sources" onClick={onExport}>
          <Download size={14} />
        </button>
        <button type="button" className="explorer-sort-button" title="Import data sources" aria-label="Import data sources" onClick={onImport}>
          <Upload size={14} />
        </button>
        {sortOpen && (
          <div className="explorer-sort-panel" onPointerDown={(event) => event.stopPropagation()}>
            <SortSelect
              label="Groups"
              value={sortPreferences.groups}
              onChange={(groupsOrder) =>
                onSortPreferencesChange({ ...sortPreferences, groups: groupsOrder })
              }
            />
            <SortSelect
              label="Connections"
              value={sortPreferences.connections}
              onChange={(connectionOrder) =>
                onSortPreferencesChange({ ...sortPreferences, connections: connectionOrder })
              }
            />
          </div>
        )}
      </div>
      <div className="group-scroll">
        {orderedGroups.map((group) => {
          const children = orderedConnections.filter((connection) => connection.groupId === group.id);
          return (
            <ConnectionGroupNode
              key={group.id}
              group={group}
              connections={children}
              activeConnectionId={activeConnectionId}
              onSelectConnection={onSelectConnection}
              onRefreshConnection={onRefreshConnection}
              onConnectionContextMenu={(event, connection) => {
                event.preventDefault();
                event.stopPropagation();
                setConnectionContext({ connection, x: event.clientX, y: event.clientY });
              }}
              onToggle={() =>
                onGroupsChange(
                  groups.map((item) =>
                    item.id === group.id ? { ...item, isExpanded: item.isExpanded === false } : item,
                  ),
                )
              }
              onDropConnection={(connectionId) => moveConnection(connectionId, group.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setContext({ group, x: event.clientX, y: event.clientY });
              }}
            />
          );
        })}

        <div
          className="ungrouped-zone"
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            event.currentTarget.classList.add("drag-over");
          }}
          onDragLeave={(event) => event.currentTarget.classList.remove("drag-over")}
          onDrop={(event) => {
            event.preventDefault();
            event.currentTarget.classList.remove("drag-over");
            const connectionId = event.dataTransfer.getData("text/plain");
            if (connectionId) moveConnection(connectionId);
          }}
        >
          <span className="ungrouped-label">Ungrouped <b>{ungrouped.length}</b></span>
          {ungrouped.map((connection) => (
            <ConnectionItem
              key={connection.id}
              connection={connection}
              active={connection.id === activeConnectionId}
              onSelect={() => onSelectConnection(connection.id)}
              onRefresh={() => onRefreshConnection(connection.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setConnectionContext({ connection, x: event.clientX, y: event.clientY });
              }}
            />
          ))}
          {ungrouped.length === 0 && <small>Drop connections here to remove them from a group</small>}
        </div>
      </div>

      {editor !== undefined && (
        <GroupEditor group={editor} onSave={saveGroup} onClose={() => setEditor(undefined)} />
      )}

      {context && (
        <div
          className="group-context-menu"
          style={{ left: context.x, top: context.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button onClick={() => { setEditor(context.group); setContext(undefined); }}>Edit Group</button>
          <button onClick={() => { setEditor(context.group); setContext(undefined); }}>Rename</button>
          <button onClick={() => duplicateGroup(context.group)}><Copy size={12} /> Duplicate Group and Connections</button>
          <div className="context-colors">
            <span>Change Color</span>
            {COLORS.map((color) => (
              <button
                key={color}
                style={{ backgroundColor: color }}
                aria-label={`Set color ${color}`}
                onClick={() => {
                  onGroupsChange(groups.map((item) => item.id === context.group.id ? { ...item, color } : item));
                  setContext(undefined);
                }}
              />
            ))}
          </div>
          <button onClick={() => deleteGroup(context.group.id, false)}>Delete Group — Keep Connections</button>
          <button className="danger" onClick={() => deleteGroup(context.group.id, true)}>
            Delete Group — Remove All
          </button>
        </div>
      )}

      {connectionContext && (
        <div
          className="group-context-menu"
          style={{ left: connectionContext.x, top: connectionContext.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            onClick={() => {
              onEditConnection(connectionContext.connection);
              setConnectionContext(undefined);
            }}
          >
            Edit Connection
          </button>
          <button
            onClick={() => {
              onDuplicateConnection(connectionContext.connection);
              setConnectionContext(undefined);
            }}
          >
            <Copy size={12} /> Duplicate Connection
          </button>
          <button
            className="danger"
            onClick={() => {
              onDeleteConnection(connectionContext.connection);
              setConnectionContext(undefined);
            }}
          >
            Delete Connection
          </button>
        </div>
      )}
    </div>
  );
}

function SortSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ExplorerSortOrder;
  onChange: (value: ExplorerSortOrder) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as ExplorerSortOrder)}>
        <option value="name_asc">Name A–Z</option>
        <option value="name_desc">Name Z–A</option>
        <option value="manual">Manual / created order</option>
      </select>
    </label>
  );
}

function sortItems<T>(items: T[], order: ExplorerSortOrder, getName: (item: T) => string): T[] {
  if (order === "manual") return items;
  const direction = order === "name_desc" ? -1 : 1;
  return [...items].sort((left, right) =>
    direction * getName(left).localeCompare(getName(right), undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
}

function ConnectionGroupNode({
  group,
  connections,
  activeConnectionId,
  onSelectConnection,
  onConnectionContextMenu,
  onRefreshConnection,
  onToggle,
  onDropConnection,
  onContextMenu,
}: {
  group: ConnectionGroup;
  connections: ConnectionSummary[];
  activeConnectionId: string;
  onSelectConnection: (id: string) => void;
  onConnectionContextMenu: (event: React.MouseEvent, connection: ConnectionSummary) => void;
  onRefreshConnection: (connectionId: string) => void;
  onToggle: () => void;
  onDropConnection: (id: string) => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const Icon = groupIcon(group.icon);
  const expanded = group.isExpanded !== false;
  return (
    <div className="connection-group">
      <button
        className="group-header"
        onClick={onToggle}
        onContextMenu={onContextMenu}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          event.currentTarget.parentElement?.classList.add("drag-over");
        }}
        onDragLeave={(event) =>
          event.currentTarget.parentElement?.classList.remove("drag-over")
        }
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.parentElement?.classList.remove("drag-over");
          const connectionId = event.dataTransfer.getData("text/plain");
          if (connectionId) onDropConnection(connectionId);
        }}
      >
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="group-icon" style={{ color: group.color, backgroundColor: `${group.color}22` }}>
          <Icon size={13} />
        </span>
        <strong>{group.name}</strong>
        <span className="group-count">{connections.length}</span>
        <MoreHorizontal size={13} onClick={onContextMenu} />
      </button>
      {expanded && (
        <div className="group-connections">
          {connections.map((connection) => (
            <ConnectionItem
              key={connection.id}
              connection={connection}
              active={connection.id === activeConnectionId}
              onSelect={() => onSelectConnection(connection.id)}
              onRefresh={() => onRefreshConnection(connection.id)}
              onContextMenu={(event) => onConnectionContextMenu(event, connection)}
            />
          ))}
          {connections.length === 0 && <small>Drop a connection into this group</small>}
        </div>
      )}
    </div>
  );
}

function ConnectionItem({
  connection,
  active,
  onSelect,
  onContextMenu,
  onRefresh,
}: {
  connection: ConnectionSummary;
  active: boolean;
  onSelect: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
  onRefresh: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      className={`connection-card compact ${active ? "active" : ""}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onSelect();
      }}
      onContextMenu={onContextMenu}
      onDragStart={(event) => {
        event.dataTransfer.setData("text/plain", connection.id);
        event.dataTransfer.effectAllowed = "move";
      }}
    >
      <span className="connection-mark engine-mark" style={{ backgroundColor: `${connection.accent}22` }}>
        <DatabaseEngineIcon engine={connection.engine} size={15} />
      </span>
      <span className="connection-copy"><strong>{connection.label}</strong><small>{connection.engine}</small></span>
      <button
        type="button"
        className="connection-refresh"
        title={`Refresh schema for ${connection.label}`}
        aria-label={`Refresh schema for ${connection.label}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onRefresh();
        }}
      >
        <RefreshCw size={12} />
      </button>
      <span className="status-dot" />
    </div>
  );
}

function GroupEditor({ group, onSave, onClose }: { group: ConnectionGroup | null; onSave: (group: ConnectionGroup) => void | Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState(group ?? {
    id: `group-${crypto.randomUUID()}`,
    name: "New Group",
    color: COLORS[3],
    icon: "Folder" as const,
    isExpanded: true,
  });
  const [variableRows, setVariableRows] = useState(() =>
    Object.entries(group?.variables ?? {}).map(([key, value]) => ({
      id: crypto.randomUUID(),
      key,
      value,
      isPassword: group?.variableSecrets?.[key] === true,
    })),
  );
  const [variableError, setVariableError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const keys = variableRows.map((row) => row.key.trim());
    if (keys.some((key) => !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key))) {
      setVariableError("Variable names must start with a letter or underscore.");
      return;
    }
    if (new Set(keys).size !== keys.length) {
      setVariableError("Variable names must be unique.");
      return;
    }
    setSaving(true);
    try {
      await onSave({
        ...draft,
        variables: Object.fromEntries(variableRows.map((row) => [row.key.trim(), row.value])),
        variableSecrets: Object.fromEntries(
          variableRows
            .filter((row) => row.isPassword)
            .map((row) => [row.key.trim(), true]),
        ),
      });
    } catch (error) {
      setVariableError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="group-editor-backdrop">
      <form className="group-editor" onSubmit={submit}>
        <header><strong>{group ? "Edit group" : "Create group"}</strong><button type="button" onClick={onClose}><X size={14} /></button></header>
        <label><span>Group name</span><input autoFocus required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label><span>Icon</span><div className="group-icon-options">{ICONS.map((icon) => { const Icon = groupIcon(icon); return <button type="button" key={icon} className={draft.icon === icon ? "active" : ""} onClick={() => setDraft({ ...draft, icon })}><Icon size={15} />{icon}</button>; })}</div></label>
        <label><span>Color</span><div className="group-color-options">{COLORS.map((color) => <button type="button" aria-label={color} key={color} className={draft.color === color ? "active" : ""} style={{ backgroundColor: color }} onClick={() => setDraft({ ...draft, color })} />)}</div></label>
        <div className="group-variables">
          <div className="group-variables-header">
            <span>Environment variables</span>
            <button type="button" onClick={() => {
              setVariableRows((rows) => [...rows, { id: crypto.randomUUID(), key: "", value: "", isPassword: false }]);
              setVariableError(undefined);
            }}><FolderPlus size={12} /> Add variable</button>
          </div>
          <p>Use these values in grouped connections as <code>{"{{variable}}"}</code>.</p>
          <div className="group-variable-list">
            {variableRows.map((row) => (
              <div className="group-variable-row" key={row.id}>
                <input aria-label="Variable name" placeholder="key" value={row.key} onChange={(event) => {
                  const key = event.target.value;
                  setVariableRows((rows) => rows.map((item) => item.id === row.id ? { ...item, key } : item));
                  setVariableError(undefined);
                }} />
                <span>→</span>
                <input type={row.isPassword ? "password" : "text"} autoComplete="off" aria-label={`Value for ${row.key || "variable"}`} placeholder="value" value={row.value} onChange={(event) => {
                  const value = event.target.value;
                  setVariableRows((rows) => rows.map((item) => item.id === row.id ? { ...item, value } : item));
                }} />
                <label className="group-variable-password" title="Mask this variable as a password">
                  <input type="checkbox" checked={row.isPassword} onChange={(event) => {
                    const isPassword = event.target.checked;
                    setVariableRows((rows) => rows.map((item) => item.id === row.id
                      ? { ...item, isPassword, value: !isPassword && item.isPassword ? "" : item.value }
                      : item));
                  }} />
                  Password
                </label>
                <button type="button" title="Remove variable" onClick={() => setVariableRows((rows) => rows.filter((item) => item.id !== row.id))}><Trash2 size={13} /></button>
              </div>
            ))}
            {variableRows.length === 0 && <small>No variables configured.</small>}
          </div>
          {variableError && <div className="group-variable-error">{variableError}</div>}
        </div>
        <footer><button type="button" onClick={onClose} disabled={saving}>Cancel</button><button type="submit" className="primary-button" disabled={saving}>{saving ? "Saving…" : "Save Group"}</button></footer>
      </form>
    </div>
  );
}

function groupIcon(name?: ConnectionGroup["icon"]) {
  return { Folder, Server, ShieldAlert, Database }[name ?? "Folder"];
}
