import { Download, ShieldAlert, Upload, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { ConnectionGroup, ConnectionSummary } from "../../types/connection";

interface DataSourceTransferModalProps {
  mode: "export" | "import";
  groups: ConnectionGroup[];
  connections: ConnectionSummary[];
  onClose: () => void;
  onConfirm: (groupIds: Set<string>, connectionIds: Set<string>, includeSecrets: boolean) => Promise<void>;
}

export function DataSourceTransferModal({
  mode,
  groups,
  connections,
  onClose,
  onConfirm,
}: DataSourceTransferModalProps) {
  const [groupIds, setGroupIds] = useState(() => new Set(groups.map((group) => group.id)));
  const [connectionIds, setConnectionIds] = useState(() => new Set(connections.map((connection) => connection.id)));
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ungrouped = useMemo(() => connections.filter((connection) => !connection.groupId), [connections]);
  const selectedCount = groupIds.size + connectionIds.size;

  const toggleGroup = (group: ConnectionGroup, checked: boolean) => {
    setGroupIds((current) => toggled(current, group.id, checked));
    const children = connections.filter((connection) => connection.groupId === group.id);
    setConnectionIds((current) => {
      const next = new Set(current);
      for (const child of children) checked ? next.add(child.id) : next.delete(child.id);
      return next;
    });
  };

  const submit = async () => {
    if (selectedCount === 0) return;
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm(groupIds, connectionIds, includeSecrets);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="export-layer datasource-transfer-layer" role="presentation" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="datasource-transfer-modal" role="dialog" aria-modal="true" aria-labelledby="datasource-transfer-title">
        <header>
          <div>
            <span className="eyebrow">Data Sources</span>
            <h2 id="datasource-transfer-title">{mode === "export" ? "Export connections" : "Import connections"}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>
        <p>Select the groups and individual connections to {mode}. Group checkboxes include their child connections.</p>
        <div className="datasource-transfer-selection">
          {groups.map((group) => {
            const children = connections.filter((connection) => connection.groupId === group.id);
            return (
              <div className="transfer-group" key={group.id}>
                <label className="transfer-group-label">
                  <input type="checkbox" checked={groupIds.has(group.id)} onChange={(event) => toggleGroup(group, event.target.checked)} />
                  <span className="transfer-color" style={{ backgroundColor: group.color ?? "#64748B" }} />
                  <strong>{group.name}</strong><small>{children.length}</small>
                </label>
                {children.map((connection) => (
                  <TransferConnection key={connection.id} connection={connection} checked={connectionIds.has(connection.id)} onChange={(checked) => {
                    setConnectionIds((current) => toggled(current, connection.id, checked));
                    if (checked) setGroupIds((current) => toggled(current, group.id, true));
                  }} />
                ))}
              </div>
            );
          })}
          {ungrouped.length > 0 && (
            <div className="transfer-group">
              <div className="transfer-group-label"><strong>Ungrouped</strong><small>{ungrouped.length}</small></div>
              {ungrouped.map((connection) => (
                <TransferConnection key={connection.id} connection={connection} checked={connectionIds.has(connection.id)} onChange={(checked) => setConnectionIds((current) => toggled(current, connection.id, checked))} />
              ))}
            </div>
          )}
        </div>
        {mode === "export" && (
          <label className="transfer-secrets">
            <input type="checkbox" checked={includeSecrets} onChange={(event) => setIncludeSecrets(event.target.checked)} />
            <ShieldAlert size={15} />
            <span><strong>Include connection passwords and SSH credentials</strong><small>Group variables are always included. Only enable this for a trusted recipient; the JSON file is not encrypted.</small></span>
          </label>
        )}
        {error && <div className="schema-notice">{error}</div>}
        <footer>
          <span>{selectedCount} item{selectedCount === 1 ? "" : "s"} selected</span>
          <div>
            <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="button" className="primary-button" onClick={() => void submit()} disabled={busy || selectedCount === 0}>
              {mode === "export" ? <Download size={14} /> : <Upload size={14} />}
              {busy ? `${mode === "export" ? "Exporting" : "Importing"}…` : mode === "export" ? "Export selected" : "Import selected"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function TransferConnection({ connection, checked, onChange }: { connection: ConnectionSummary; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="transfer-connection"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span>{connection.label}</span><small>{connection.engine}</small></label>;
}

function toggled(current: Set<string>, id: string, checked: boolean) {
  const next = new Set(current);
  checked ? next.add(id) : next.delete(id);
  return next;
}
