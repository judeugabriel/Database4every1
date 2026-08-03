import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import DataEditor, {
  CompactSelection,
  GridCellKind,
  GridColumnIcon,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import {
  Braces,
  Check,
  Clipboard,
  LoaderCircle,
  X,
} from "lucide-react";
import type { QueryResult } from "../types/database";
import { copyToClipboard } from "../utils/clipboard";
import { ValueInspector } from "./inspector/ValueInspector";

export interface GridSort {
  columnIndex: number;
  direction: "asc" | "desc";
}

export interface QueryDataGridProps {
  result: QueryResult;
  hasMore?: boolean;
  chunkSize?: number;
  onLoadMore?: (
    offset: number,
    chunkSize: number,
    sort?: GridSort,
  ) => Promise<QueryResult | null>;
  sort?: GridSort;
  onSortChange?: (sort: GridSort | undefined) => void;
  onHeaderSortClick?: (columnIndex: number) => void;
}

const EMPTY_SELECTION: GridSelection = {
  columns: CompactSelection.empty(),
  rows: CompactSelection.empty(),
};

export function QueryDataGrid({
  result,
  hasMore = false,
  chunkSize = 1_000,
  onLoadMore,
  sort,
  onSortChange,
  onHeaderSortClick,
}: QueryDataGridProps) {
  const [rows, setRows] = useState(result.rows);
  const [columnWidths, setColumnWidths] = useState<Record<number, number>>({});
  const [selection, setSelection] = useState<GridSelection>(EMPTY_SELECTION);
  const [inspector, setInspector] = useState<{ column: string; value: unknown }>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [canLoadMore, setCanLoadMore] = useState(hasMore);
  const [copyStatus, setCopyStatus] = useState<"csv" | "json">();
  const loadingRef = useRef(false);
  const { containerRef, width, height } = useAutoSizer();

  useEffect(() => {
    setRows(result.rows);
    setCanLoadMore(hasMore);
    setSelection(EMPTY_SELECTION);
  }, [hasMore, result]);

  const sortedRows = rows;

  const columns = useMemo<GridColumn[]>(
    () =>
      result.columns.map((column, index) => ({
        id: column.name,
        title: `${column.name}${
          sort?.columnIndex === index ? (sort.direction === "asc" ? "  ↑" : "  ↓") : ""
        }`,
        width: Math.max(
          150,
          column.name.length * 10,
          columnWidths[index] ?? estimateColumnWidth(column.name, column.data_type),
        ),
        icon: iconForType(column.data_type),
      })),
    [columnWidths, result.columns, sort],
  );

  const getCellContent = useCallback(
    ([columnIndex, rowIndex]: Item): GridCell => {
      const value = sortedRows[rowIndex]?.[columnIndex];
      const display = displayValue(value);
      return {
        kind: GridCellKind.Text,
        data: display,
        displayData: display,
        allowOverlay: false,
        readonly: true,
        themeOverride:
          value === null || value === undefined
            ? { textDark: "#5f6c79", baseFontStyle: "italic 12px" }
            : undefined,
      };
    },
    [sortedRows],
  );

  const loadMore = useCallback(async () => {
    if (!onLoadMore || !canLoadMore || loadingRef.current) return;
    loadingRef.current = true;
    setLoadingMore(true);
    try {
      const next = await onLoadMore(rows.length, chunkSize, sort);
      if (!next || next.rows.length === 0) {
        setCanLoadMore(false);
        return;
      }
      setRows((current) => [...current, ...next.rows]);
      if (next.rows.length < chunkSize) setCanLoadMore(false);
    } finally {
      loadingRef.current = false;
      setLoadingMore(false);
    }
  }, [canLoadMore, chunkSize, onLoadMore, rows.length, sort]);

  const copySelection = useCallback(
    async (format: "csv" | "json") => {
      const selected = selectedData(selection, sortedRows, result.columns.map((item) => item.name));
      const text = format === "csv" ? toCsv(selected.columns, selected.rows) : toJson(selected.columns, selected.rows);
      await copyToClipboard(text);
      setCopyStatus(format);
      window.setTimeout(() => setCopyStatus(undefined), 1_200);
    },
    [result.columns, selection, sortedRows],
  );

  return (
    <div className="query-data-grid">
      <div className="grid-actions">
        <span>{rows.length.toLocaleString()} rows loaded</span>
        {sort && (
          <button
            type="button"
            className="grid-sort-chip interactive-action"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onSortChange?.(undefined);
            }}
          >
            {result.columns[sort.columnIndex]?.name} {sort.direction === "asc" ? "↑" : "↓"}
            <X size={11} />
          </button>
        )}
        <span className="pane-spacer" />
        {loadingMore && (
          <span className="grid-loading">
            <LoaderCircle size={12} /> Loading next chunk…
          </span>
        )}
        <button
          type="button"
          className="interactive-action"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void copySelection("csv");
          }}
          title="Copy selected cells as CSV"
        >
          {copyStatus === "csv" ? <Check size={12} /> : <Clipboard size={12} />}
          CSV
        </button>
        <button
          type="button"
          className="interactive-action"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void copySelection("json");
          }}
          title="Copy selected cells as JSON"
        >
          {copyStatus === "json" ? <Check size={12} /> : <Braces size={12} />}
          JSON
        </button>
      </div>

      <div
        className="grid-canvas"
        ref={containerRef}
        onWheel={(event) => event.stopPropagation()}
      >
        <DataEditor
          width={width}
          height={height}
          columns={columns}
          rows={sortedRows.length}
          getCellContent={getCellContent}
          getCellsForSelection={true}
          gridSelection={selection}
          onGridSelectionChange={setSelection}
          rowMarkers="number"
          rowMarkerWidth={54}
          freezeColumns={1}
          minColumnWidth={80}
          smoothScrollX={true}
          smoothScrollY={true}
          scaleToRem={true}
          copyHeaders
          keybindings={{ copy: true, selectAll: true }}
          onHeaderClicked={(columnIndex) => {
            onHeaderSortClick?.(columnIndex);
          }}
          onColumnResize={(_, width, columnIndex) => {
            setColumnWidths((current) => ({ ...current, [columnIndex]: Math.round(width) }));
          }}
          onCellClicked={([columnIndex, rowIndex], event) => {
            if (!event.isDoubleClick) return;
            setInspector({
              column: result.columns[columnIndex]?.name ?? `Column ${columnIndex + 1}`,
              value: sortedRows[rowIndex]?.[columnIndex],
            });
          }}
          onVisibleRegionChanged={(range) => {
            if (range.y + range.height >= sortedRows.length - 50) void loadMore();
          }}
          theme={{
            accentColor: "#58c9a8",
            accentFg: "#0d1714",
            accentLight: "#20473d",
            bgCell: "#0e1319",
            bgCellMedium: "#111820",
            bgHeader: "#171e27",
            bgHeaderHasFocus: "#1b252d",
            bgHeaderHovered: "#202b35",
            borderColor: "#202a34",
            drilldownBorder: "#374451",
            fgIconHeader: "#788694",
            textDark: "#c1cad3",
            textHeader: "#b9c3cd",
            textHeaderSelected: "#e2e8ee",
            textLight: "#63707d",
            textMedium: "#8b98a5",
            fontFamily: "'SFMono-Regular', Consolas, monospace",
            baseFontStyle: "12px",
            headerFontStyle: "600 11px",
          }}
        />
      </div>

      {inspector && (
        <ValueInspector
          column={inspector.column}
          value={inspector.value}
          onClose={() => setInspector(undefined)}
        />
      )}
      {copyStatus && <div className="copy-toast" role="status">Copied to clipboard!</div>}
    </div>
  );
}

function selectedData(selection: GridSelection, rows: unknown[][], columns: string[]) {
  const range = selection.current?.range;
  if (!range) return { columns, rows };
  const selectedColumns = columns.slice(range.x, range.x + range.width);
  const selectedRows = rows
    .slice(range.y, range.y + range.height)
    .map((row) => row.slice(range.x, range.x + range.width));
  return { columns: selectedColumns, rows: selectedRows };
}

function toCsv(columns: string[], rows: unknown[][]) {
  return [columns, ...rows]
    .map((row) => row.map((value) => csvValue(value)).join(","))
    .join("\n");
}

function csvValue(value: unknown) {
  const string = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "");
  return /[",\n\r]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string;
}

function toJson(columns: string[], rows: unknown[][]) {
  return JSON.stringify(
    rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]]))),
    null,
    2,
  );
}

function displayValue(value: unknown) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function estimateColumnWidth(name: string, dataType: string) {
  const likelyWide = /json|text|blob|object|array/i.test(dataType);
  return Math.max(150, Math.min(likelyWide ? 280 : 210, name.length * 9 + 60));
}

function useAutoSizer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const updateSize = () => {
      const bounds = element.getBoundingClientRect();
      setSize({
        width: Math.max(1, Math.floor(bounds.width)),
        height: Math.max(1, Math.floor(bounds.height)),
      });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { containerRef, ...size };
}

function iconForType(type: string): GridColumnIcon {
  if (/int|float|double|decimal|numeric|real/i.test(type)) return GridColumnIcon.HeaderNumber;
  if (/bool/i.test(type)) return GridColumnIcon.HeaderBoolean;
  if (/date|time/i.test(type)) return GridColumnIcon.HeaderDate;
  if (/json|object|array|bson/i.test(type)) return GridColumnIcon.HeaderCode;
  return GridColumnIcon.HeaderString;
}
