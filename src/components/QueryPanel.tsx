import { useCallback, useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { TerminalSquare } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import {
  cancelQuery,
  executeQuery,
  normalizeBackendError,
} from "../services/database";
import type { BackendError, ConnectionSummary, QueryResult } from "../types/database";
import type { GridSort } from "./results/GlideResultsGrid";
import type { GridDataChange } from "./QueryDataGrid";
import { QueryEditor } from "./editor/QueryEditor";
import { QueryResultsPanel, type QueryLogEntry } from "./results/QueryResultsPanel";
import { useWorkspace } from "./WorkspaceContext";
import { applyQueryControls, type QuerySort } from "../utils/queryBuilder";
import { buildMutationQueries } from "../utils/dataMutations";

export interface QueryPanelParams {
  initialQuery: string;
  ordinal: number;
  autoRun?: boolean;
  connection?: ConnectionSummary;
  tabColor?: string;
  editableTarget?: {
    name: string;
    kind: "table" | "view" | "collection";
    databaseName?: string;
  };
  [key: string]: unknown;
}

export function QueryPanel({ api, params }: IDockviewPanelProps<QueryPanelParams>) {
  const {
    completionCatalogByConnection,
    defaultLimit,
    runRequest,
    cancelRequest,
    reportActivity,
  } = useWorkspace();
  const tabConnection = params.connection;
  const completionCatalog = tabConnection
    ? completionCatalogByConnection[tabConnection.id] ?? { tables: [], fields: [] }
    : { tables: [], fields: [] };
  const [query, setQuery] = useState(params.initialQuery);
  const [limit, setLimit] = useState(defaultLimit);
  const [result, setResult] = useState<QueryResult>();
  const [error, setError] = useState<BackendError>();
  const [running, setRunning] = useState(false);
  const [, setElapsedMs] = useState(0);
  const [split, setSplit] = useState(58);
  const [logs, setLogs] = useState<QueryLogEntry[]>([]);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<GridSort>();
  const [pendingChanges, setPendingChanges] = useState<GridDataChange[]>([]);
  const [editResetVersion, setEditResetVersion] = useState(0);
  const pendingChangesRef = useRef<GridDataChange[]>([]);
  const activeQueryId = useRef<string | undefined>(undefined);
  const lastQueryId = useRef<string | undefined>(undefined);
  const startedAt = useRef(0);
  const queryRef = useRef(query);
  const runningRef = useRef(running);
  const resultRef = useRef<QueryResult | undefined>(result);
  const pageRef = useRef(page);
  const sortRef = useRef<GridSort | undefined>(sort);
  const autoRunHandled = useRef(false);
  const previousLimit = useRef(limit);
  const pendingLimitRefresh = useRef(false);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ queryId: string; level: QueryLogEntry["level"]; message: string }>("query-log", (event) => {
      if (event.payload.queryId !== lastQueryId.current) return;
      setLogs((current) => [...current, {
        timestamp: new Date().toLocaleTimeString(),
        level: event.payload.level,
        message: event.payload.message,
      }]);
    }).then((dispose) => disposed ? dispose() : (unlisten = dispose));
    return () => { disposed = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);
  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  useEffect(() => { resultRef.current = result; }, [result]);
  useEffect(() => { pageRef.current = page; }, [page]);
  useEffect(() => { sortRef.current = sort; }, [sort]);
  useEffect(() => { pendingChangesRef.current = pendingChanges; }, [pendingChanges]);

  useEffect(() => {
    if (!running) return;
    const interval = window.setInterval(() => {
      const elapsed = performance.now() - startedAt.current;
      setElapsedMs(elapsed);
      if (api.isActive) reportActivity({ running: true, elapsedMs: elapsed, status: "running" });
    }, 50);
    return () => window.clearInterval(interval);
  }, [api, reportActivity, running]);

  const run = useCallback(async (
    targetPage = pageRef.current,
    targetSort: GridSort | null | undefined = sortRef.current,
    preserveStructure = false,
  ) => {
    if (!tabConnection || runningRef.current || !queryRef.current.trim()) return;
    if (pendingChangesRef.current.length > 0) {
      if (!window.confirm("Discard the pending grid changes and run this query?")) return;
      pendingChangesRef.current = [];
      setPendingChanges([]);
      setEditResetVersion((version) => version + 1);
    }
    const effectiveSort = targetSort === null ? undefined : targetSort;
    const querySort: QuerySort | undefined = effectiveSort ? {
      column: resultRef.current?.columns[effectiveSort.columnIndex]?.name ?? "",
      direction: effectiveSort.direction,
    } : undefined;
    const nextQuery = applyQueryControls(queryRef.current, tabConnection.engine, {
      limit,
      page: targetPage,
      sort: querySort?.column ? querySort : undefined,
    });
    queryRef.current = nextQuery;
    setQuery(nextQuery);
    setPage(targetPage);
    setSort(effectiveSort);
    pageRef.current = targetPage;
    sortRef.current = effectiveSort;
    const queryId = crypto.randomUUID();
    activeQueryId.current = queryId;
    lastQueryId.current = queryId;
    startedAt.current = performance.now();
    setElapsedMs(0);
    setLogs([]);
    setError(undefined);
    setRunning(true);
    runningRef.current = true;
    reportActivity({ running: true, elapsedMs: 0, status: "running" });

    try {
      const nextResult = await executeQuery(
        tabConnection.id,
        nextQuery,
        limit,
        queryId,
      );
      const elapsed = performance.now() - startedAt.current;
      const structuredResult = preserveStructure && resultRef.current
        ? preserveResultStructure(resultRef.current, nextResult)
        : nextResult;
      resultRef.current = structuredResult;
      setResult(structuredResult);
      setElapsedMs(elapsed);
      reportActivity({ running: false, elapsedMs: elapsed, status: "success" });
    } catch (caught) {
      const normalized = normalizeBackendError(caught);
      const elapsed = performance.now() - startedAt.current;
      setError(normalized);
      setElapsedMs(elapsed);
      reportActivity({
        running: false,
        elapsedMs: elapsed,
        status: normalized.code === "QUERY_CANCELLED" ? "cancelled" : "error",
      });
    } finally {
      activeQueryId.current = undefined;
      setRunning(false);
      runningRef.current = false;
    }
  }, [limit, reportActivity, tabConnection]);

  useEffect(() => {
    const limitChanged = previousLimit.current !== limit;
    previousLimit.current = limit;
    if (!api.isActive) return;
    const nextQuery = applyQueryControls(queryRef.current, tabConnection?.engine, {
      limit,
      page: 1,
      sort: sortRef.current ? {
        column: resultRef.current?.columns[sortRef.current.columnIndex]?.name ?? "",
        direction: sortRef.current.direction,
      } : undefined,
    });
    queryRef.current = nextQuery;
    setQuery(nextQuery);
    setPage(1);
    pageRef.current = 1;
    if (limitChanged && resultRef.current) {
      if (runningRef.current) pendingLimitRefresh.current = true;
      else void run(1, sortRef.current, true);
    }
  }, [api, limit, run, tabConnection?.engine]);

  useEffect(() => {
    if (running || !pendingLimitRefresh.current) return;
    pendingLimitRefresh.current = false;
    void run(1, sortRef.current, true);
  }, [run, running]);

  const cancel = useCallback(async () => {
    if (activeQueryId.current) await cancelQuery(activeQueryId.current);
  }, []);

  useEffect(() => {
    if (!params.autoRun || autoRunHandled.current) return;
    autoRunHandled.current = true;
    void run();
  }, [params.autoRun, run]);

  const loadMore = useCallback(
    async (offset: number, chunkSize: number, _sort?: GridSort) => {
      if (!tabConnection) return null;
      const expanded = await executeQuery(
        tabConnection.id,
        queryRef.current,
        offset + chunkSize,
        crypto.randomUUID(),
      );
      return { ...expanded, rows: expanded.rows.slice(offset) };
    },
    [tabConnection],
  );

  const exportAll = useCallback(async () => {
    if (!tabConnection || !resultRef.current) throw new Error("No query result to export");
    const total = resultRef.current.total_records ?? resultRef.current.rows.length;
    const exportLimit = 1_000;
    const pages = Math.max(1, Math.ceil(total / exportLimit));
    const collected: QueryResult = { ...resultRef.current, rows: [], total_records: total };
    for (let exportPage = 1; exportPage <= pages; exportPage += 1) {
      const querySort: QuerySort | undefined = sortRef.current ? {
        column: resultRef.current.columns[sortRef.current.columnIndex]?.name ?? "",
        direction: sortRef.current.direction,
      } : undefined;
      const exportQuery = applyQueryControls(queryRef.current, tabConnection.engine, { limit: exportLimit, page: exportPage, sort: querySort?.column ? querySort : undefined });
      const pageResult = await executeQuery(tabConnection.id, exportQuery, exportLimit, crypto.randomUUID());
      const normalized = preserveResultStructure(resultRef.current, pageResult);
      collected.rows.push(...normalized.rows);
      if (pageResult.rows.length < exportLimit) break;
    }
    return collected;
  }, [tabConnection]);

  const editable = Boolean(
    params.editableTarget
    && params.editableTarget.kind !== "view"
    && tabConnection
    && ["postgresql", "mysql", "mongodb", "elasticsearch"].includes(tabConnection.engine),
  );

  const commitChanges = useCallback(async () => {
    if (!editable || !tabConnection || !params.editableTarget || !resultRef.current || pendingChanges.length === 0 || runningRef.current) return;
    const inserts = pendingChanges.filter((change) => change.kind === "insert").length;
    const updates = pendingChanges.filter((change) => change.kind === "update").length;
    const deletes = pendingChanges.filter((change) => change.kind === "delete").length;
    if (!window.confirm(`Commit ${pendingChanges.length} pending change(s) to ${params.editableTarget.name}?\n\n${inserts} insert(s), ${updates} update(s), ${deletes} deletion(s).`)) return;
    setRunning(true);
    runningRef.current = true;
    setError(undefined);
    try {
      const queries = buildMutationQueries(
        tabConnection.engine,
        params.editableTarget,
        resultRef.current.columns,
        pendingChanges,
      );
      if (tabConnection.engine === "postgresql" || tabConnection.engine === "mysql") {
        const databaseDirective = queries[0]?.match(/^-- datacraft:database=[^\n]+\n/)?.[0] ?? "";
        const statements = databaseDirective
          ? queries.map((query) => query.startsWith(databaseDirective) ? query.slice(databaseDirective.length) : query)
          : queries;
        const batch = `${databaseDirective}BEGIN;\n${statements.join("\n")}\nCOMMIT;`;
        await executeQuery(tabConnection.id, batch, 1, crypto.randomUUID());
      } else {
        for (const mutationQuery of queries) {
          await executeQuery(tabConnection.id, mutationQuery, 1, crypto.randomUUID());
        }
      }
      pendingChangesRef.current = [];
      setPendingChanges([]);
      setLogs((current) => [...current, {
        timestamp: new Date().toLocaleTimeString(),
        level: "notice",
        message: `Committed ${queries.length} data change(s)`,
      }]);
    } catch (caught) {
      setError(normalizeBackendError(caught));
      return;
    } finally {
      setRunning(false);
      runningRef.current = false;
    }
    await run(pageRef.current, sortRef.current, false);
  }, [editable, params.editableTarget, pendingChanges, run, tabConnection]);

  const cancelChanges = useCallback(() => {
    if (pendingChangesRef.current.length === 0) return;
    pendingChangesRef.current = [];
    setPendingChanges([]);
    setEditResetVersion((version) => version + 1);
    setLogs((current) => [...current, {
      timestamp: new Date().toLocaleTimeString(),
      level: "info",
      message: "Discarded pending data changes",
    }]);
  }, []);

  useEffect(() => {
    const save = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s" || !api.isActive) return;
      event.preventDefault();
      void commitChanges();
    };
    window.addEventListener("keydown", save);
    return () => window.removeEventListener("keydown", save);
  }, [api, commitChanges]);

  useEffect(() => {
    const discard = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !api.isActive || pendingChangesRef.current.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      cancelChanges();
    };
    window.addEventListener("keydown", discard);
    return () => window.removeEventListener("keydown", discard);
  }, [api, cancelChanges]);

  useEffect(() => {
    if (api.isActive && runRequest > 0) void run();
  }, [api, run, runRequest]);

  useEffect(() => {
    if (api.isActive && cancelRequest > 0) void cancel();
  }, [api, cancel, cancelRequest]);

  const language =
    tabConnection?.engine === "mongodb" || tabConnection?.engine === "elasticsearch"
      ? "json"
      : "sql";

  return (
    <div className="query-panel">
      <section className="editor-pane" style={{ height: `${split}%` }}>
        <div className="pane-label">
          <TerminalSquare size={13} />
          <span>Query editor</span>
          <span className="language-badge">{language.toUpperCase()}</span>
          <span className="pane-spacer" />
          <span>{tabConnection?.label ?? "No connection"}</span>
        </div>
        <QueryEditor
          modelKey={`query-${params.ordinal}`}
          language={language}
          query={query}
          completionCatalog={completionCatalog}
          onChange={(nextQuery) => {
            queryRef.current = nextQuery;
          }}
          onRun={() => void run()}
          onFocus={() => {
            if (!api.isActive) api.setActive();
          }}
        />
      </section>

      <div
        className="split-handle"
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={(event) => beginResize(event, setSplit)}
      >
        <span />
      </div>

      <section className="results-pane" style={{ height: `${100 - split}%` }}>
        <QueryResultsPanel
          result={result}
          error={error}
          running={running}
          hasMore={false}
          logs={logs}
          onCancel={() => void cancel()}
          onLoadMore={loadMore}
          page={page}
          limit={limit}
          onLimitChange={(nextLimit) => {
            if (pendingChangesRef.current.length > 0) {
              window.alert("Commit the pending grid changes before changing the limit.");
              return;
            }
            setLimit(nextLimit);
          }}
          onExportAll={exportAll}
          sort={sort}
          onSortChange={(nextSort) => {
            if (pendingChangesRef.current.length > 0) {
              window.alert("Commit the pending grid changes before sorting.");
              return;
            }
            void run(1, nextSort ?? null, true);
          }}
          onPageChange={(nextPage) => {
            if (pendingChangesRef.current.length > 0) {
              window.alert("Commit the pending grid changes before changing pages.");
              return;
            }
            void run(nextPage, sort, true);
          }}
          editable={editable}
          pendingChanges={pendingChanges}
          onChangesChange={setPendingChanges}
          onCommitChanges={() => void commitChanges()}
          onCancelChanges={cancelChanges}
          editResetVersion={editResetVersion}
        />
      </section>
    </div>
  );
}

function preserveResultStructure(previous: QueryResult, next: QueryResult): QueryResult {
  const nextIndex = new Map(next.columns.map((column, index) => [column.name, index]));
  const previousNames = new Set(previous.columns.map((column) => column.name));
  const columns = [
    ...previous.columns,
    ...next.columns.filter((column) => !previousNames.has(column.name)),
  ];
  return {
    ...next,
    columns,
    rows: next.rows.map((row) =>
      columns.map((column) => {
        const index = nextIndex.get(column.name);
        return index === undefined ? null : row[index];
      }),
    ),
  };
}

function beginResize(
  event: React.PointerEvent,
  setSplit: React.Dispatch<React.SetStateAction<number>>,
) {
  event.preventDefault();
  const container = event.currentTarget.parentElement;
  if (!container) return;
  const onMove = (moveEvent: PointerEvent) => {
    const bounds = container.getBoundingClientRect();
    const percent = ((moveEvent.clientY - bounds.top) / bounds.height) * 100;
    setSplit(Math.max(24, Math.min(78, percent)));
  };
  const stop = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", stop);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", stop);
}

export function formatDuration(milliseconds: number) {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1_000).toFixed(2)} s`;
}
