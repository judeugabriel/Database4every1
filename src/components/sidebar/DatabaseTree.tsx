import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Database,
  Folder,
  FolderPlus,
  MoreHorizontal,
  RefreshCw,
  Server,
  ShieldAlert,
  X,
} from "lucide-react";
import type { ConnectionGroup, ConnectionSummary } from "../../types/connection";
import { DatabaseEngineIcon } from "../icons/DatabaseEngineIcon";

interface DatabaseTreeProps {
  groups: ConnectionGroup[];
  connections: ConnectionSummary[];
  activeConnectionId: string;
  onSelectConnection: (id: string) => void;
  onGroupsChange: (groups: ConnectionGroup[]) => void;
  onConnectionsChange: (connections: ConnectionSummary[]) => void;
  onDeleteConnection: (connection: ConnectionSummary) => void;
  onEditConnection: (connection: ConnectionSummary) => void;
  onRefreshConnection: (connectionId: string) => void;
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
  onRefreshConnection,
}: DatabaseTreeProps) {
  const [editor, setEditor] = useState<ConnectionGroup | null>();
  const [context, setContext] = useState<{ group: ConnectionGroup; x: number; y: number }>();
  const [connectionContext, setConnectionContext] = useState<{
    connection: ConnectionSummary;
    x: number;
    y: number;
  }>();
  const ungrouped = connections.filter((connection) => !connection.groupId);

  useEffect(() => {
    const close = () => {
      setContext(undefined);
      setConnectionContext(undefined);
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

  const saveGroup = (group: ConnectionGroup) => {
    const exists = groups.some((item) => item.id === group.id);
    onGroupsChange(exists ? groups.map((item) => (item.id === group.id ? group : item)) : [...groups, group]);
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

  return (
    <div className="database-tree">
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
      <div className="group-scroll">
        {groups.map((group) => {
          const children = connections.filter((connection) => connection.groupId === group.id);
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

function GroupEditor({ group, onSave, onClose }: { group: ConnectionGroup | null; onSave: (group: ConnectionGroup) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(group ?? {
    id: `group-${crypto.randomUUID()}`,
    name: "New Group",
    color: COLORS[3],
    icon: "Folder" as const,
    isExpanded: true,
  });
  return (
    <div className="group-editor-backdrop">
      <form className="group-editor" onSubmit={(event) => { event.preventDefault(); onSave(draft); }}>
        <header><strong>{group ? "Edit group" : "Create group"}</strong><button type="button" onClick={onClose}><X size={14} /></button></header>
        <label><span>Group name</span><input autoFocus required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label><span>Icon</span><div className="group-icon-options">{ICONS.map((icon) => { const Icon = groupIcon(icon); return <button type="button" key={icon} className={draft.icon === icon ? "active" : ""} onClick={() => setDraft({ ...draft, icon })}><Icon size={15} />{icon}</button>; })}</div></label>
        <label><span>Color</span><div className="group-color-options">{COLORS.map((color) => <button type="button" aria-label={color} key={color} className={draft.color === color ? "active" : ""} style={{ backgroundColor: color }} onClick={() => setDraft({ ...draft, color })} />)}</div></label>
        <footer><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button">Save Group</button></footer>
      </form>
    </div>
  );
}

function groupIcon(name?: ConnectionGroup["icon"]) {
  return { Folder, Server, ShieldAlert, Database }[name ?? "Folder"];
}
