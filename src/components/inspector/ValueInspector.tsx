import { useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, X } from "lucide-react";
import { copyToClipboard } from "../../utils/clipboard";

interface ValueInspectorProps {
  isOpen?: boolean;
  column: string;
  value: unknown;
  onClose: () => void;
}

export function ValueInspector({ isOpen = true, column, value, onClose }: ValueInspectorProps) {
  // Never leave an invisible event-capturing layer in the document.
  if (!isOpen) return null;

  return <OpenValueInspector column={column} value={value} onClose={onClose} />;
}

function OpenValueInspector({ column, value, onClose }: Omit<ValueInspectorProps, "isOpen">) {
  const [copied, setCopied] = useState(false);

  const formatted = formatInspectorValue(value);
  return createPortal(
    <aside className="value-inspector" role="dialog" aria-label={`Inspect ${column}`}>
      <header>
        <div>
          <span>Value inspector</span>
          <strong>{column}</strong>
        </div>
        <button
          type="button"
          className="interactive-action z-50 cursor-pointer"
          aria-label="Close inspector"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }}
        >
          <X size={15} />
        </button>
      </header>
      <div className="inspector-meta">
        <span>{valueType(value)}</span>
        <span>{new Blob([formatted]).size.toLocaleString()} bytes</span>
        <button
          type="button"
          className="interactive-action"
          onClick={async (event) => {
            event.preventDefault();
            event.stopPropagation();
            await copyToClipboard(formatted);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1_200);
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied!" : "Copy value"}
        </button>
      </div>
      <pre>{formatted}</pre>
      {copied && <div className="copy-toast" role="status">Copied to clipboard!</div>}
    </aside>,
    document.body,
  );
}

function formatInspectorValue(value: unknown) {
  if (typeof value === "object" && value !== null) return JSON.stringify(value, null, 2);
  return String(value ?? "NULL");
}

function valueType(value: unknown) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
