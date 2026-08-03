import { createContext, useContext } from "react";
import type { CompletionCatalog } from "../types/database";

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
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("WorkspaceContext is missing");
  return context;
}
