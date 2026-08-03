import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  Database,
  KeyRound,
  LoaderCircle,
  Network,
  Server,
  ShieldCheck,
  TestTube2,
  X,
  XCircle,
} from "lucide-react";
import {
  connectDatabase,
  disconnectDatabase,
  normalizeBackendError,
} from "../services/database";
import type {
  ConnectionConfig,
  ConnectionGroup,
  ConnectionSummary,
  DatabaseEngine,
  SslMode,
} from "../types/database";
import { ElasticsearchForm } from "./connections/ElasticsearchForm";

interface ConnectionModalProps {
  connection?: ConnectionSummary;
  groups: ConnectionGroup[];
  onClose: () => void;
  onDelete?: () => Promise<boolean>;
  onSave: (
    connection: ConnectionSummary,
    config: ConnectionConfig,
  ) => Promise<void>;
}

const ENGINES: Array<{ value: DatabaseEngine; label: string; port: number; accent: string }> = [
  { value: "postgresql", label: "PostgreSQL", port: 5432, accent: "#5aa7ff" },
  { value: "mysql", label: "MySQL", port: 3306, accent: "#f5a65b" },
  { value: "sqlite", label: "SQLite", port: 0, accent: "#86b9d6" },
  { value: "mongodb", label: "MongoDB", port: 27017, accent: "#65c978" },
  { value: "elasticsearch", label: "Elasticsearch", port: 9200, accent: "#e7c64d" },
  { value: "redis", label: "Redis", port: 6379, accent: "#e76868" },
];

type TestStatus = "idle" | "testing" | "success" | "error";

export function ConnectionModal({ connection, groups, onClose, onSave, onDelete }: ConnectionModalProps) {
  const initial = useMemo(() => initialForm(connection), [connection]);
  const [label, setLabel] = useState(initial.label);
  const [config, setConfig] = useState(initial.config);
  const [sshEnabled, setSshEnabled] = useState(Boolean(initial.config.ssh_tunnel_config));
  const [sshAuth, setSshAuth] = useState<"key" | "password">(
    initial.config.ssh_tunnel_config?.private_key_path ? "key" : "password",
  );
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [message, setMessage] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const effectiveConfig = useMemo(
    () => ({
      ...config,
      groupId: config.groupId || undefined,
      username: config.username || undefined,
      password: config.password || undefined,
      database: config.database || undefined,
      ssh_tunnel_config: sshEnabled
        ? {
            host: config.ssh_tunnel_config?.host ?? "",
            port: config.ssh_tunnel_config?.port ?? 22,
            username: config.ssh_tunnel_config?.username ?? "",
            password:
              sshAuth === "password"
                ? config.ssh_tunnel_config?.password || undefined
                : undefined,
            private_key_path:
              sshAuth === "key"
                ? config.ssh_tunnel_config?.private_key_path || undefined
                : undefined,
            private_key_passphrase:
              sshAuth === "key"
                ? config.ssh_tunnel_config?.private_key_passphrase || undefined
                : undefined,
            connect_timeout_secs: config.ssh_tunnel_config?.connect_timeout_secs ?? 15,
          }
        : undefined,
    }),
    [config, sshAuth, sshEnabled],
  );

  const testConnection = async () => {
    const temporaryId = `connection-test-${crypto.randomUUID()}`;
    setTestStatus("testing");
    setMessage("Opening a secure connection…");
    let connected = false;
    try {
      await connectDatabase(temporaryId, effectiveConfig);
      connected = true;
      setTestStatus("success");
      setMessage("Connection established successfully");
    } catch (error) {
      const normalized = normalizeBackendError(error);
      setTestStatus("error");
      setMessage(normalized.message);
    } finally {
      if (connected) await disconnectDatabase(temporaryId).catch(() => undefined);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage(undefined);
    try {
      const engine = ENGINES.find((item) => item.value === effectiveConfig.db_type)!;
      const connectionId = connection?.id ?? effectiveConfig.id;
      await onSave(
        {
          id: connectionId,
          groupId: effectiveConfig.groupId,
          label: label.trim(),
          engine: effectiveConfig.db_type,
          accent: engine.accent,
          config: effectiveConfig,
        },
        effectiveConfig,
      );
      onClose();
    } catch (error) {
      setTestStatus("error");
      setMessage(normalizeBackendError(error).message);
    } finally {
      setSaving(false);
    }
  };

  const isFileDatabase = config.db_type === "sqlite";

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="connection-modal" onSubmit={submit}>
        <header className="modal-header">
          <span className="modal-icon"><Database size={18} /></span>
          <div>
            <span className="eyebrow">Data source</span>
            <h2>{connection ? "Edit connection" : "New connection"}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={17} />
          </button>
        </header>

        <div className="modal-body">
          <section className="connection-section">
            <div className="section-title"><Server size={14} /><span>Connection</span></div>
            <div className="form-grid">
              <Field label="Name" wide>
                <input required value={label} onChange={(event) => setLabel(event.target.value)} />
              </Field>
              <Field label="Database engine" wide>
                <div className="select-wrap">
                  <select
                    value={config.db_type}
                    onChange={(event) => {
                      const db_type = event.target.value as DatabaseEngine;
                      const port = ENGINES.find((item) => item.value === db_type)?.port ?? 0;
                      setConfig((current) => ({ ...current, db_type, port }));
                      setTestStatus("idle");
                    }}
                  >
                    {ENGINES.map((engine) => <option key={engine.value} value={engine.value}>{engine.label}</option>)}
                  </select>
                  <ChevronDown size={13} />
                </div>
              </Field>
              <Field label="Group" wide>
                <div className="select-wrap group-select-wrap">
                  <select
                    value={config.groupId ?? ""}
                    onChange={(event) =>
                      setConfig((current) => ({
                        ...current,
                        groupId: event.target.value || undefined,
                      }))
                    }
                  >
                    <option value="">None (Unassigned)</option>
                    {groups.map((group) => (
                      <option key={group.id} value={group.id} style={{ color: group.color }}>
                        {`● ${group.name}`}
                      </option>
                    ))}
                  </select>
                  <span
                    className="selected-group-color"
                    style={{
                      backgroundColor:
                        groups.find((group) => group.id === config.groupId)?.color ?? "transparent",
                    }}
                  />
                  <ChevronDown size={13} />
                </div>
              </Field>
              <Field label={isFileDatabase ? "Database file" : "Host"} wide={isFileDatabase}>
                <input
                  required
                  value={isFileDatabase ? config.database ?? "" : config.host}
                  placeholder={isFileDatabase ? "/path/to/database.sqlite" : "localhost"}
                  onChange={(event) => setConfig((current) => isFileDatabase
                    ? { ...current, database: event.target.value }
                    : { ...current, host: event.target.value })}
                />
              </Field>
              {!isFileDatabase && (
                <Field label="Port">
                  <input type="number" min="1" max="65535" required value={config.port}
                    onChange={(event) => setConfig((current) => ({ ...current, port: Number(event.target.value) }))} />
                </Field>
              )}
              {!isFileDatabase && <Field label="Database"><input value={config.database ?? ""}
                onChange={(event) => setConfig((current) => ({ ...current, database: event.target.value }))} /></Field>}
              {!isFileDatabase && <Field label="User"><input autoComplete="username" value={config.username ?? ""}
                onChange={(event) => setConfig((current) => ({ ...current, username: event.target.value }))} /></Field>}
              {!isFileDatabase && <Field label="Password"><input type="password" autoComplete="new-password" value={config.password ?? ""}
                onChange={(event) => setConfig((current) => ({ ...current, password: event.target.value }))} /></Field>}
              {!isFileDatabase && <Field label="SSL mode" wide><div className="select-wrap"><select value={config.ssl_mode}
                onChange={(event) => setConfig((current) => ({ ...current, ssl_mode: event.target.value as SslMode }))}>
                <option value="disable">Disable</option><option value="prefer">Prefer</option>
                <option value="require">Require</option><option value="verify_ca">Verify CA</option>
                <option value="verify_full">Verify full</option>
              </select><ChevronDown size={13} /></div></Field>}
              {config.db_type === "elasticsearch" && (
                <ElasticsearchForm
                  dangerouslyIgnoreTls={config.ignore_tls ?? false}
                  onChange={(ignore_tls) =>
                    setConfig((current) => ({ ...current, ignore_tls }))
                  }
                />
              )}
            </div>
          </section>

          {!isFileDatabase && (
            <section className="connection-section ssh-section">
              <div className="section-title">
                <Network size={14} /><span>SSH tunnel</span>
                <label className="switch"><input type="checkbox" checked={sshEnabled}
                  onChange={(event) => setSshEnabled(event.target.checked)} /><span /></label>
              </div>
              {sshEnabled && (
                <div className="form-grid ssh-fields">
                  <Field label="Jump host"><input required value={config.ssh_tunnel_config?.host ?? ""}
                    onChange={(event) => updateSsh(setConfig, { host: event.target.value })} /></Field>
                  <Field label="SSH port"><input type="number" min="1" max="65535" required
                    value={config.ssh_tunnel_config?.port ?? 22}
                    onChange={(event) => updateSsh(setConfig, { port: Number(event.target.value) })} /></Field>
                  <Field label="SSH user" wide><input required value={config.ssh_tunnel_config?.username ?? ""}
                    onChange={(event) => updateSsh(setConfig, { username: event.target.value })} /></Field>
                  <Field label="Connect timeout (seconds)" wide><input type="number" min="1" max="300" required
                    value={config.ssh_tunnel_config?.connect_timeout_secs ?? 15}
                    onChange={(event) => updateSsh(setConfig, { connect_timeout_secs: Number(event.target.value) })} /></Field>
                  <div className="auth-selector form-wide">
                    <button type="button" className={sshAuth === "key" ? "active" : ""} onClick={() => setSshAuth("key")}>
                      <KeyRound size={13} /> Private key
                    </button>
                    <button type="button" className={sshAuth === "password" ? "active" : ""} onClick={() => setSshAuth("password")}>
                      <ShieldCheck size={13} /> Password
                    </button>
                  </div>
                  {sshAuth === "key" ? <>
                    <Field label="Private key path" wide><input required placeholder="~/.ssh/id_ed25519"
                      value={config.ssh_tunnel_config?.private_key_path ?? ""}
                      onChange={(event) => updateSsh(setConfig, { private_key_path: event.target.value })} /></Field>
                    <Field label="Key passphrase" wide><input type="password" value={config.ssh_tunnel_config?.private_key_passphrase ?? ""}
                      onChange={(event) => updateSsh(setConfig, { private_key_passphrase: event.target.value })} /></Field>
                  </> : <Field label="SSH password" wide><input type="password" required
                    value={config.ssh_tunnel_config?.password ?? ""}
                    onChange={(event) => updateSsh(setConfig, { password: event.target.value })} /></Field>}
                  <div className="known-hosts-note form-wide">
                    <ShieldCheck size={13} /> Host keys are verified against <code>~/.ssh/known_hosts</code>.
                  </div>
                </div>
              )}
            </section>
          )}
        </div>

        <div className={`test-status ${testStatus}`}>
          {testStatus === "testing" && <LoaderCircle size={14} />}
          {testStatus === "success" && <CheckCircle2 size={14} />}
          {testStatus === "error" && <XCircle size={14} />}
          {testStatus === "idle" && <TestTube2 size={14} />}
          <span>{message ?? "Test the connection before saving."}</span>
        </div>

        <footer className="modal-footer">
          {connection && onDelete && (
            <button
              type="button"
              className="secondary-button danger-button"
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                const deleted = await onDelete().finally(() => setSaving(false));
                if (deleted) onClose();
              }}
            >
              Delete
            </button>
          )}
          <button type="button" className="secondary-button" onClick={() => void testConnection()}
            disabled={testStatus === "testing" || saving}>
            {testStatus === "testing" ? <LoaderCircle size={14} /> : <TestTube2 size={14} />} Test connection
          </button>
          <span />
          <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button" disabled={saving || !label.trim()}>
            {saving && <LoaderCircle size={14} />} {connection ? "Save changes" : "Add connection"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return <label className={wide ? "form-wide" : ""}><span>{label}</span>{children}</label>;
}

function updateSsh(
  setConfig: React.Dispatch<React.SetStateAction<ConnectionConfig>>,
  patch: Partial<NonNullable<ConnectionConfig["ssh_tunnel_config"]>>,
) {
  setConfig((current) => ({
    ...current,
    ssh_tunnel_config: {
      host: current.ssh_tunnel_config?.host ?? "",
      port: current.ssh_tunnel_config?.port ?? 22,
      username: current.ssh_tunnel_config?.username ?? "",
      ...current.ssh_tunnel_config,
      ...patch,
    },
  }));
}

function initialForm(connection?: ConnectionSummary): {
  label: string;
  config: ConnectionConfig;
} {
  const id = connection?.id ?? `connection-${crypto.randomUUID()}`;
  return {
    label: connection?.label ?? "Local PostgreSQL",
    config: connection?.config ? {
      ...connection.config,
      groupId: connection.groupId ?? connection.config.groupId,
    } : {
      id,
      host: "localhost",
      port: 5432,
      database: "",
      username: "",
      password: "",
      ssl_mode: "prefer" as const,
      db_type: "postgresql" as const,
    },
  };
}
