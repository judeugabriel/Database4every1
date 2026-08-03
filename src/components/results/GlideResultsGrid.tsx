import { useEffect, useState } from "react";
import {
  QueryDataGrid,
  type GridSort,
  type QueryDataGridProps,
} from "../QueryDataGrid";

export type { GridSort };

interface SortState {
  column: string | null;
  direction: "ASC" | "DESC" | null;
}

export function GlideResultsGrid(props: QueryDataGridProps) {
  const [sortState, setSortState] = useState<SortState>({
    column: null,
    direction: null,
  });

  useEffect(() => {
    const active = props.sort;
    setSortState(active ? {
      column: props.result.columns[active.columnIndex]?.name ?? null,
      direction: active.direction.toUpperCase() as "ASC" | "DESC",
    } : { column: null, direction: null });
  }, [props.result.columns, props.sort]);

  const setGridSort = (nextSort: GridSort | undefined) => {
    if (!nextSort) setSortState({ column: null, direction: null });
    props.onSortChange?.(nextSort);
  };

  const handleHeaderClick = (columnIndex: number) => {
    const column = props.result.columns[columnIndex]?.name;
    if (!column) return;

    if (sortState.column !== column) {
      setSortState({ column, direction: "ASC" });
      props.onSortChange?.({ columnIndex, direction: "asc" });
    } else if (sortState.direction === "ASC") {
      setSortState({ column, direction: "DESC" });
      props.onSortChange?.({ columnIndex, direction: "desc" });
    } else {
      // Third click restores the original unsorted query.
      setSortState({ column: null, direction: null });
      props.onSortChange?.(undefined);
    }
  };

  return (
    <div className="glide-results-grid">
      <QueryDataGrid
        {...props}
        onSortChange={setGridSort}
        onHeaderSortClick={handleHeaderClick}
      />
    </div>
  );
}
