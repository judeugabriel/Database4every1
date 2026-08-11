import { createContext, useContext } from "react";
import type { CompletionCatalog, SchemaTree } from "../types/database";
import type { ConnectionGroup, ConnectionSummary } from "../types/connection";

export interface QueryActivity {
  running: boolean;
  elapsedMs: number;
  status: "idle" | "running" | "success" | "error" | "cancelled";
}

export interface WorkspaceContextValue {
  completionCatalogByConnection: Record<string, CompletionCatalog>;
  defaultLimit: number;
  runRequest: number;
  cancelRequest: number;
  reportActivity: (activity: QueryActivity) => void;
  connections: ConnectionSummary[];
  groups: ConnectionGroup[];
  ensureConnection: (connectionId: string) => Promise<SchemaTree | undefined>;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("WorkspaceContext is missing");
  return context;
}
