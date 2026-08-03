import { useState } from "react";
import {
  AlertCircle,
  CircleStop,
  Rows3,
  TerminalSquare,
  Download,
} from "lucide-react";
import type { BackendError, QueryResult } from "../../types/database";
import { GlideResultsGrid, type GridSort } from "./GlideResultsGrid";
import { ExportResultsModal } from "./ExportResultsModal";

export interface QueryLogEntry {
  timestamp: string;
  level: "info" | "notice" | "warning" | "error";
  message: string;
}

interface QueryResultsPanelProps {
  result?: QueryResult;
  error?: BackendError;
  running: boolean;
  hasMore: boolean;
  logs: QueryLogEntry[];
  onCancel: () => void;
  onLoadMore: (
    offset: number,
    chunkSize: number,
    sort?: GridSort,
  ) => Promise<QueryResult | null>;
  page: number;
  limit: number;
  onLimitChange: (limit: number) => void;
  onExportAll: () => Promise<QueryResult>;
  sort?: GridSort;
  onSortChange: (sort: GridSort | undefined) => void;
  onPageChange: (page: number) => void;
}

export function QueryResultsPanel({
  result,
  error,
  running,
  hasMore,
  logs,
  onCancel,
  onLoadMore,
  page,
  limit,
  onLimitChange,
  onExportAll,
  sort,
  onSortChange,
  onPageChange,
}: QueryResultsPanelProps) {
  const [tab, setTab] = useState<"results" | "output">("results");
  const [exportOpen, setExportOpen] = useState(false);
  return (
    <>
      <div className="result-tabs">
        <button className={`result-tab interactive-action ${tab === "results" ? "active" : ""}`} onClick={(event) => { event.stopPropagation(); setTab("results"); }}>
          <Rows3 size={13} /> Results
          {result && <span className="tab-count">{result.rows.length}</span>}
        </button>
        <button className={`result-tab interactive-action ${tab === "output" ? "active" : ""}`} onClick={(event) => { event.stopPropagation(); setTab("output"); }}>
          <TerminalSquare size={13} /> Output
          {logs.length > 0 && <span className="tab-count">{logs.length}</span>}
        </button>
        <span className="pane-spacer" />
        <label className="tab-limit-control">
          <span>Limit</span>
          <select
            value={limit}
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => onLimitChange(Number(event.target.value))}
          >
            {[50, 100, 200, 500, 1_000].map((value) => (
              <option value={value} key={value}>{value.toLocaleString()}</option>
            ))}
          </select>
        </label>
        <button type="button" className="result-export-button interactive-action" disabled={!result || running} onClick={(event) => { event.stopPropagation(); setExportOpen(true); }}><Download size={12} /> Export</button>
        {running && (
          <button className="cancel-inline interactive-action" onClick={(event) => { event.stopPropagation(); onCancel(); }}>
            <CircleStop size={13} /> Stop
          </button>
        )}
      </div>

      {tab === "results" ? (
        <ResultsView result={result} error={error} running={running} hasMore={hasMore} onLoadMore={onLoadMore} sort={sort} onSortChange={onSortChange} />
      ) : (
        <OutputView result={result} error={error} logs={logs} running={running} />
      )}
      {tab === "results" && result && (
        <PaginationBar result={result} page={page} limit={limit} running={running} onPageChange={onPageChange} />
      )}
      {exportOpen && result && <ExportResultsModal result={result} loadAll={onExportAll} onClose={() => setExportOpen(false)} />}
    </>
  );
}

function ResultsView({
  result,
  error,
  running,
  hasMore,
  onLoadMore,
  sort,
  onSortChange,
}: Pick<QueryResultsPanelProps, "result" | "error" | "running" | "hasMore" | "onLoadMore" | "sort" | "onSortChange">) {
  if (error) {
    return <div className="result-message error-message"><AlertCircle size={22} /><div><strong>{error.code.split("_").join(" ")}</strong><p>{error.message}</p></div></div>;
  }
  if (!result) {
    return <div className="result-message"><Rows3 size={24} /><strong>{running ? "Executing query…" : "No results yet"}</strong><span>Run the query with ⌘/Ctrl + Enter</span></div>;
  }
  return <GlideResultsGrid result={result} hasMore={hasMore} onLoadMore={onLoadMore} sort={sort} onSortChange={onSortChange} />;
}

function PaginationBar({ result, page, limit, running, onPageChange }: {
  result: QueryResult;
  page: number;
  limit: number;
  running: boolean;
  onPageChange: (page: number) => void;
}) {
  const total = result.total_records ?? result.rows.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const current = Math.min(page, pages);
  const first = total === 0 ? 0 : (current - 1) * limit + 1;
  const last = Math.min(current * limit, total);
  return <div className="pagination-bar">
    <span>Showing {first.toLocaleString()}–{last.toLocaleString()} of {total.toLocaleString()} records</span>
    <span className="pane-spacer" />
    <button type="button" className="interactive-action" disabled={running || current <= 1} onClick={(event) => { event.stopPropagation(); onPageChange(1); }}>First</button>
    <button type="button" className="interactive-action" disabled={running || current <= 1} onClick={(event) => { event.stopPropagation(); onPageChange(current - 1); }}>Prev</button>
    <strong>Page {current} of {pages}</strong>
    <button type="button" className="interactive-action" disabled={running || current >= pages} onClick={(event) => { event.stopPropagation(); onPageChange(current + 1); }}>Next</button>
    <button type="button" className="interactive-action" disabled={running || current >= pages} onClick={(event) => { event.stopPropagation(); onPageChange(pages); }}>Last</button>
  </div>;
}

function OutputView({ result, error, logs, running }: Pick<QueryResultsPanelProps, "result" | "error" | "logs" | "running">) {
  return (
    <div className="query-output" role="log" aria-live="polite">
      <div className="output-summary">
        <span><small>Status</small><strong>{running ? "Running" : error ? "Failed" : result ? "Completed" : "Idle"}</strong></span>
        <span><small>Execution time</small><strong>{result ? `${result.execution_time_ms} ms` : "—"}</strong></span>
        <span><small>Affected rows</small><strong>{result?.total_affected.toLocaleString() ?? "—"}</strong></span>
        <span><small>Returned rows</small><strong>{result?.rows.length.toLocaleString() ?? "—"}</strong></span>
      </div>
      <div className="output-log-lines">
        {logs.map((entry, index) => (
          <div className={`output-log ${entry.level}`} key={`${entry.timestamp}-${index}`}>
            <time>{entry.timestamp}</time><b>{entry.level}</b><span>{entry.message}</span>
          </div>
        ))}
        {error && <div className="output-log error"><time>now</time><b>error</b><span>{error.message}</span></div>}
        {logs.length === 0 && !error && <div className="output-empty">Execution logs will appear here.</div>}
      </div>
    </div>
  );
}
