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
import { resolveConnectionConfig } from "../utils/connectionVariables";

interface ConnectionModalProps {
  connection?: ConnectionSummary;
  duplicate?: boolean;
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

export function ConnectionModal({ connection, duplicate = false, groups, onClose, onSave, onDelete }: ConnectionModalProps) {
  const initial = useMemo(() => initialForm(connection, duplicate), [connection, duplicate]);
  const isEditing = Boolean(connection) && !duplicate;
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
      await connectDatabase(temporaryId, resolveConnectionConfig(effectiveConfig, groups));
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
      const connectionId = isEditing ? connection!.id : effectiveConfig.id;
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
  const selectedGroup = groups.find((group) => group.id === config.groupId);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="connection-modal" onSubmit={submit}>
        <header className="modal-header">
          <span className="modal-icon"><Database size={18} /></span>
          <div>
            <span className="eyebrow">Data source</span>
            <h2>{isEditing ? "Edit connection" : duplicate ? "Duplicate connection" : "New connection"}</h2>
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
                      setConfig((current) => ({
                        ...current,
                        db_type,
                        port,
                        ssl_mode: db_type === "redis" ? "disable" : current.ssl_mode,
                      }));
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
                      setConfig((current) => clearPasswordVariableReferences({
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
              {selectedGroup && Object.keys(selectedGroup.variables ?? {}).length > 0 && (
                <div className="connection-variable-hint form-wide">
                  <span>Available:</span>
                  {Object.keys(selectedGroup.variables ?? {}).map((key) => <code key={key}>{`{{${key}}}`}</code>)}
                </div>
              )}
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
                  <input type="text" inputMode="numeric" required value={config.port}
                    placeholder="5432 or {{port}}"
                    onChange={(event) => setConfig((current) => ({ ...current, port: event.target.value }))} />
                </Field>
              )}
              {!isFileDatabase && <Field label="Database"><input value={config.database ?? ""}
                onChange={(event) => setConfig((current) => ({ ...current, database: event.target.value }))} /></Field>}
              {!isFileDatabase && <Field label="User"><input autoComplete="username" value={config.username ?? ""}
                onChange={(event) => setConfig((current) => ({ ...current, username: event.target.value }))} /></Field>}
              {!isFileDatabase && <Field label="Password" compound><PasswordVariableInput
                value={config.password ?? ""}
                group={selectedGroup}
                onChange={(password) => setConfig((current) => ({ ...current, password }))}
              /></Field>}
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
                  <Field label="SSH port"><input type="text" inputMode="numeric" required
                    value={config.ssh_tunnel_config?.port ?? 22}
                    placeholder="22 or {{ssh_port}}"
                    onChange={(event) => updateSsh(setConfig, { port: event.target.value })} /></Field>
                  <Field label="SSH user" wide><input required value={config.ssh_tunnel_config?.username ?? ""}
                    onChange={(event) => updateSsh(setConfig, { username: event.target.value })} /></Field>
                  <Field label="Connect timeout (seconds)" wide><input type="text" inputMode="numeric" required
                    value={config.ssh_tunnel_config?.connect_timeout_secs ?? 15}
                    onChange={(event) => updateSsh(setConfig, { connect_timeout_secs: event.target.value })} /></Field>
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
                    <Field label="Key passphrase" wide compound><PasswordVariableInput
                      value={config.ssh_tunnel_config?.private_key_passphrase ?? ""}
                      group={selectedGroup}
                      onChange={(private_key_passphrase) => updateSsh(setConfig, { private_key_passphrase })}
                    /></Field>
                  </> : <Field label="SSH password" wide compound><PasswordVariableInput
                    required
                    value={config.ssh_tunnel_config?.password ?? ""}
                    group={selectedGroup}
                    onChange={(password) => updateSsh(setConfig, { password })}
                  /></Field>}
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
          {isEditing && onDelete && (
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
            {saving && <LoaderCircle size={14} />} {isEditing ? "Save changes" : duplicate ? "Add duplicate" : "Add connection"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function Field({ label, wide, compound, children }: { label: string; wide?: boolean; compound?: boolean; children: React.ReactNode }) {
  const className = `${wide ? "form-wide " : ""}${compound ? "form-field" : ""}`.trim();
  if (compound) return <div className={className}><span>{label}</span>{children}</div>;
  return <label className={className}><span>{label}</span>{children}</label>;
}

function PasswordVariableInput({
  value,
  group,
  required,
  onChange,
}: {
  value: string;
  group?: ConnectionGroup;
  required?: boolean;
  onChange: (value: string) => void;
}) {
  const variableNames = Object.keys(group?.variables ?? {});
  const referencedVariable = variableReference(value);
  const usesVariable = referencedVariable !== undefined;
  return (
    <div className="password-variable-field">
      {usesVariable ? (
        <div className="select-wrap">
          <select
            required={required}
            aria-label="Password group variable"
            value={referencedVariable}
            onChange={(event) => onChange(event.target.value ? `{{${event.target.value}}}` : "")}
          >
            <option value="">Select a group variable</option>
            {referencedVariable && !variableNames.includes(referencedVariable) && (
              <option value={referencedVariable}>{referencedVariable} (unavailable)</option>
            )}
            {variableNames.map((name) => (
              <option key={name} value={name}>
                {name}{group?.variableSecrets?.[name] ? " (password)" : ""}
              </option>
            ))}
          </select>
          <ChevronDown size={13} />
        </div>
      ) : (
        <input
          type="password"
          required={required}
          autoComplete="new-password"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      <span className="password-variable-toggle">
        <input
          type="checkbox"
          aria-label="Use a group variable for this password"
          checked={usesVariable}
          disabled={variableNames.length === 0}
          onChange={(event) => onChange(event.target.checked && variableNames.length > 0 ? `{{${variableNames[0]}}}` : "")}
        />
        Use group variable
      </span>
    </div>
  );
}

function variableReference(value: string) {
  return value.match(/^\{\{([A-Za-z_][A-Za-z0-9_.-]*)\}\}$/)?.[1];
}

function clearPasswordVariableReferences(config: ConnectionConfig): ConnectionConfig {
  const ssh = config.ssh_tunnel_config;
  return {
    ...config,
    password: config.password && variableReference(config.password) ? "" : config.password,
    ssh_tunnel_config: ssh ? {
      ...ssh,
      password: ssh.password && variableReference(ssh.password) ? "" : ssh.password,
      private_key_passphrase: ssh.private_key_passphrase && variableReference(ssh.private_key_passphrase)
        ? ""
        : ssh.private_key_passphrase,
    } : ssh,
  };
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

function initialForm(connection?: ConnectionSummary, duplicate = false): {
  label: string;
  config: ConnectionConfig;
} {
  const id = connection && !duplicate ? connection.id : `connection-${crypto.randomUUID()}`;
  return {
    label: connection ? `${connection.label}${duplicate ? " Copy" : ""}` : "Local PostgreSQL",
    config: connection?.config ? {
      ...connection.config,
      id,
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
