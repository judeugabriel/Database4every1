import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import DataEditor, {
  CompactSelection,
  GridCellKind,
  GridColumnIcon,
  type GridCell,
  type EditableGridCell,
  type GridColumn,
  type GridSelection,
  type Item,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import {
  Braces,
  Check,
  Clipboard,
  Eye,
  LoaderCircle,
  Pencil,
  Trash2,
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
  editable?: boolean;
  onChangesChange?: (changes: GridDataChange[]) => void;
  resetVersion?: number;
}

export interface GridDataChange {
  kind: "insert" | "update" | "delete";
  rowIndex: number;
  original?: unknown[];
  values?: unknown[];
  changedColumns?: number[];
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
  editable = false,
  onChangesChange,
  resetVersion = 0,
}: QueryDataGridProps) {
  const [rows, setRows] = useState(result.rows);
  const [columnWidths, setColumnWidths] = useState<Record<number, number>>({});
  const [selection, setSelection] = useState<GridSelection>(EMPTY_SELECTION);
  const [inspector, setInspector] = useState<{ column: string; value: unknown }>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [canLoadMore, setCanLoadMore] = useState(hasMore);
  const [copyStatus, setCopyStatus] = useState<"csv" | "json">();
  const [insertedRows, setInsertedRows] = useState<Set<number>>(new Set());
  const [deletedRows, setDeletedRows] = useState<Set<number>>(new Set());
  const [cellMenu, setCellMenu] = useState<{ x: number; y: number; columnIndex: number; rowIndex: number }>();
  const [cellEditor, setCellEditor] = useState<{ x: number; y: number; columnIndex: number; rowIndex: number; text: string }>();
  const loadingRef = useRef(false);
  const { containerRef, width, height } = useAutoSizer();

  useEffect(() => {
    setRows(result.rows);
    setCanLoadMore(hasMore);
    setSelection(EMPTY_SELECTION);
    setInsertedRows(new Set());
    setDeletedRows(new Set());
    onChangesChange?.([]);
  }, [hasMore, resetVersion, result]);

  useEffect(() => {
    if (!cellMenu) return;
    const close = () => setCellMenu(undefined);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [cellMenu]);

  const publishChanges = useCallback((nextRows: unknown[][], inserted: Set<number>, deleted: Set<number>) => {
    const changes: GridDataChange[] = [];
    for (let rowIndex = 0; rowIndex < nextRows.length; rowIndex += 1) {
      if (inserted.has(rowIndex)) {
        if (!deleted.has(rowIndex)) changes.push({ kind: "insert", rowIndex, values: nextRows[rowIndex] });
        continue;
      }
      const original = result.rows[rowIndex];
      if (!original) continue;
      if (deleted.has(rowIndex)) {
        changes.push({ kind: "delete", rowIndex, original });
        continue;
      }
      const changedColumns = nextRows[rowIndex]
        .map((value, columnIndex) => valuesEqual(value, original[columnIndex]) ? -1 : columnIndex)
        .filter((index) => index >= 0);
      if (changedColumns.length > 0) changes.push({
        kind: "update", rowIndex, original, values: nextRows[rowIndex], changedColumns,
      });
    }
    onChangesChange?.(changes);
  }, [onChangesChange, result.rows]);

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
        allowOverlay: editable && !deletedRows.has(rowIndex),
        readonly: !editable || deletedRows.has(rowIndex),
        themeOverride:
          deletedRows.has(rowIndex)
            ? { textDark: "#9a5960", bgCell: "#261619", baseFontStyle: "italic 12px" }
            : insertedRows.has(rowIndex)
              ? { bgCell: "#14241e", textDark: "#9bd8c5" }
              : value === null || value === undefined
            ? { textDark: "#5f6c79", baseFontStyle: "italic 12px" }
            : undefined,
      };
    },
    [deletedRows, editable, insertedRows, sortedRows],
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

  const beginEditCell = useCallback((columnIndex: number, rowIndex: number, x: number, y: number) => {
    if (!editable || deletedRows.has(rowIndex)) return;
    const previous = rows[rowIndex]?.[columnIndex];
    setCellEditor({
      x: Math.min(window.innerWidth - 340, Math.max(8, x)),
      y: Math.min(window.innerHeight - 210, Math.max(8, y)),
      columnIndex,
      rowIndex,
      text: previous === null || previous === undefined ? "" : displayValue(previous),
    });
  }, [deletedRows, editable, rows]);

  const applyCellEdit = useCallback(() => {
    if (!cellEditor) return;
    const { columnIndex, rowIndex, text } = cellEditor;
    const previous = rows[rowIndex]?.[columnIndex];
    const nextRows = rows.map((row) => [...row]);
    nextRows[rowIndex][columnIndex] = parseEditedValue(text, previous, result.columns[columnIndex]?.data_type);
    setRows(nextRows);
    publishChanges(nextRows, insertedRows, deletedRows);
    setCellEditor(undefined);
  }, [cellEditor, deletedRows, insertedRows, publishChanges, result.columns, rows]);

  const deleteRow = useCallback((rowIndex: number) => {
    if (!editable) return;
    const nextDeleted = new Set(deletedRows);
    nextDeleted.add(rowIndex);
    setDeletedRows(nextDeleted);
    publishChanges(rows, insertedRows, nextDeleted);
  }, [deletedRows, editable, insertedRows, publishChanges, rows]);

  return (
    <div className="query-data-grid">
      <div className="grid-actions">
        <span>{rows.length.toLocaleString()} rows loaded</span>
        {editable && <span className="grid-edit-hint">Editing enabled · Double-click a cell · Select rows and press Delete</span>}
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
          rowMarkers={editable ? "both" : "number"}
          rowMarkerWidth={54}
          freezeColumns={1}
          minColumnWidth={80}
          smoothScrollX={true}
          smoothScrollY={true}
          scaleToRem={true}
          copyHeaders
          keybindings={{ copy: true, selectAll: true, delete: editable }}
          trailingRowOptions={editable ? { hint: "Add row", sticky: true } : undefined}
          onRowAppended={editable ? () => {
            const rowIndex = rows.length;
            const nextRows = [...rows, result.columns.map(() => null)];
            const nextInserted = new Set(insertedRows).add(rowIndex);
            setRows(nextRows);
            setInsertedRows(nextInserted);
            publishChanges(nextRows, nextInserted, deletedRows);
          } : undefined}
          onCellEdited={editable ? ([columnIndex, rowIndex], newValue: EditableGridCell) => {
            if (deletedRows.has(rowIndex) || newValue.kind !== GridCellKind.Text) return;
            const nextRows = rows.map((row) => [...row]);
            nextRows[rowIndex][columnIndex] = parseEditedValue(newValue.data, rows[rowIndex][columnIndex], result.columns[columnIndex]?.data_type);
            setRows(nextRows);
            publishChanges(nextRows, insertedRows, deletedRows);
          } : undefined}
          onDelete={editable ? (nextSelection) => {
            const selected = new Set(nextSelection.rows.toArray());
            if (selected.size === 0) return false;
            const nextDeleted = new Set(deletedRows);
            selected.forEach((index) => nextDeleted.add(index));
            setDeletedRows(nextDeleted);
            publishChanges(rows, insertedRows, nextDeleted);
            return true;
          } : undefined}
          onHeaderClicked={(columnIndex) => {
            onHeaderSortClick?.(columnIndex);
          }}
          onColumnResize={(_, width, columnIndex) => {
            setColumnWidths((current) => ({ ...current, [columnIndex]: Math.round(width) }));
          }}
          onCellClicked={([columnIndex, rowIndex], event) => {
            setCellMenu(undefined);
            if (event.isDoubleClick && editable) {
              beginEditCell(columnIndex, rowIndex, event.bounds.x + event.localEventX, event.bounds.y + event.localEventY);
              event.preventDefault();
            }
          }}
          onCellContextMenu={([columnIndex, rowIndex], event) => {
            event.preventDefault();
            const bounds = event.bounds;
            setCellMenu({
              x: Math.min(window.innerWidth - 190, Math.max(8, bounds.x + event.localEventX)),
              y: Math.min(window.innerHeight - 126, Math.max(8, bounds.y + event.localEventY)),
              columnIndex,
              rowIndex,
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

      {cellMenu && (
        <div
          className="grid-cell-context-menu"
          style={{ left: cellMenu.x, top: cellMenu.y }}
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" onClick={() => {
            setInspector({
              column: result.columns[cellMenu.columnIndex]?.name ?? `Column ${cellMenu.columnIndex + 1}`,
              value: rows[cellMenu.rowIndex]?.[cellMenu.columnIndex],
            });
            setCellMenu(undefined);
          }}><Eye size={13} /> Show in Value Inspector</button>
          <button type="button" role="menuitem" disabled={!editable || deletedRows.has(cellMenu.rowIndex)} title={editable ? "Edit this cell" : "This query result is read-only"} onClick={() => {
            beginEditCell(cellMenu.columnIndex, cellMenu.rowIndex, cellMenu.x, cellMenu.y);
            setCellMenu(undefined);
          }}><Pencil size={13} /> Edit cell</button>
          <button type="button" role="menuitem" className="danger" disabled={!editable || deletedRows.has(cellMenu.rowIndex)} title={editable ? "Stage this row for deletion" : "This query result is read-only"} onClick={() => {
            deleteRow(cellMenu.rowIndex);
            setCellMenu(undefined);
          }}><Trash2 size={13} /> Delete row</button>
        </div>
      )}

      {cellEditor && (
        <div className="grid-cell-editor" style={{ left: cellEditor.x, top: cellEditor.y }} role="dialog" aria-label={`Edit ${result.columns[cellEditor.columnIndex]?.name ?? "cell"}`}>
          <label>{result.columns[cellEditor.columnIndex]?.name ?? "Cell value"}</label>
          <textarea
            autoFocus
            value={cellEditor.text}
            onChange={(event) => setCellEditor((current) => current ? { ...current, text: event.target.value } : current)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setCellEditor(undefined);
              } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                applyCellEdit();
              }
            }}
          />
          <div>
            <button type="button" onClick={() => setCellEditor(undefined)}>Cancel</button>
            <button type="button" className="primary" onClick={applyCellEdit}>Apply</button>
          </div>
        </div>
      )}

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

function valuesEqual(left: unknown, right: unknown) {
  if (Object.is(left, right)) return true;
  if (typeof left === "object" && typeof right === "object") {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
}

function parseEditedValue(text: string, previous: unknown, dataType?: string): unknown {
  const trimmed = text.trim();
  if (/^null$/i.test(trimmed)) return null;
  if (typeof previous === "boolean" || /bool/i.test(dataType ?? "")) {
    if (/^true$/i.test(trimmed)) return true;
    if (/^false$/i.test(trimmed)) return false;
  }
  if (typeof previous === "number" || /int|float|double|numeric|decimal|real/i.test(dataType ?? "")) {
    const number = Number(trimmed);
    if (Number.isFinite(number)) return number;
  }
  if (typeof previous === "object" && previous !== null || /json|array|object/i.test(dataType ?? "")) {
    try { return JSON.parse(text); } catch { return text; }
  }
  return text;
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
