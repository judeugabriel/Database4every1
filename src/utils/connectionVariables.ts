import type { ConnectionConfig, ConnectionGroup } from "../types/connection";

const VARIABLE_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;

export function resolveConnectionConfig(
  config: ConnectionConfig,
  groups: ConnectionGroup[],
): ConnectionConfig {
  const variables = groups.find((group) => group.id === config.groupId)?.variables ?? {};
  const resolve = (value: unknown, stack: string[] = []): string =>
    String(value ?? "").replace(VARIABLE_PATTERN, (_placeholder, key: string) => {
      if (!(key in variables)) throw new Error(`Group variable "${key}" is not defined`);
      if (stack.includes(key)) throw new Error(`Circular group variable: ${[...stack, key].join(" → ")}`);
      return resolve(variables[key], [...stack, key]);
    });
  const text = (value: string | null | undefined) => value == null ? undefined : resolve(value);
  const number = (value: number | string | null | undefined, field: string): number => {
    const resolved = typeof value === "number" ? value : Number(resolve(value));
    if (!Number.isFinite(resolved)) throw new Error(`${field} must resolve to a number`);
    return resolved;
  };

  return {
    ...config,
    host: resolve(config.host),
    port: number(config.port, "Port"),
    username: text(config.username),
    password: text(config.password),
    database: text(config.database),
    ssh_tunnel_config: config.ssh_tunnel_config
      ? {
          ...config.ssh_tunnel_config,
          host: resolve(config.ssh_tunnel_config.host),
          port: number(config.ssh_tunnel_config.port, "SSH port"),
          username: resolve(config.ssh_tunnel_config.username),
          password: text(config.ssh_tunnel_config.password),
          private_key_path: text(config.ssh_tunnel_config.private_key_path),
          private_key_passphrase: text(config.ssh_tunnel_config.private_key_passphrase),
          connect_timeout_secs: config.ssh_tunnel_config.connect_timeout_secs === undefined
            ? undefined
            : number(config.ssh_tunnel_config.connect_timeout_secs, "SSH connect timeout"),
        }
      : undefined,
  };
}

export function templateVariableNames(value: string): string[] {
  return [...value.matchAll(VARIABLE_PATTERN)].map((match) => match[1]);
}
