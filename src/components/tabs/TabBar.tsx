import type { CSSProperties, MouseEvent } from "react";
import type { IDockviewPanelHeaderProps } from "dockview-react";
import { FileCode2, X } from "lucide-react";

interface QueryTabHeaderParams {
  tabColor?: string;
  [key: string]: unknown;
}

export function TabBar({ api, containerApi, params }: IDockviewPanelHeaderProps<QueryTabHeaderParams>) {
  const closeTab = (tabId: string) => {
    containerApi.getPanel(tabId)?.api.close();
  };

  const handleAuxClick = (event: MouseEvent, tabId: string) => {
    // Button 1 is the middle mouse button (scroll wheel click).
    if (event.button === 1) {
      event.preventDefault();
      event.stopPropagation();
      closeTab(tabId);
    }
  };

  return (
    <div
      className="query-tab"
      style={{ "--tab-accent": params.tabColor ?? "#64748B" } as CSSProperties}
      title={`${api.title ?? "Query"} — middle-click to close`}
      onMouseDown={(event) => event.button === 1 && event.preventDefault()}
      onAuxClick={(event) => handleAuxClick(event, api.id)}
    >
      <FileCode2 size={13} />
      <span>{api.title ?? "Query"}</span>
      <button
        type="button"
        aria-label={`Close ${api.title ?? "query tab"}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          closeTab(api.id);
        }}
      >
        <X size={12} />
      </button>
    </div>
  );
}
