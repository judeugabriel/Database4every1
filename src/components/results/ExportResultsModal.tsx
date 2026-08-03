import { useMemo, useState } from "react";
import { Download, LoaderCircle, X } from "lucide-react";
import { jsPDF } from "jspdf";
import * as XLSX from "xlsx";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type { QueryResult } from "../../types/database";

type ExportFormat = "csv" | "json" | "xml" | "xls" | "pdf";

export function ExportResultsModal({ result, loadAll, onClose }: {
  result: QueryResult;
  loadAll: () => Promise<QueryResult>;
  onClose: () => void;
}) {
  const names = useMemo(() => result.columns.map((column) => column.name), [result.columns]);
  const [fields, setFields] = useState(() => new Set(names));
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string>();

  const runExport = async () => {
    if (fields.size === 0) return;
    setExporting(true);
    setError(undefined);
    try {
      const full = await loadAll();
      const indexes = full.columns.flatMap((column, index) => fields.has(column.name) ? [index] : []);
      const columns = indexes.map((index) => full.columns[index].name);
      const records = full.rows.map((row) => Object.fromEntries(indexes.map((index, item) => [columns[item], row[index]])));
      const saved = await saveExport(format, columns, records);
      if (saved) onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setExporting(false);
    }
  };

  return <div className="export-layer" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="export-modal" role="dialog" aria-modal="true" aria-labelledby="export-title">
      <header><div><span className="eyebrow">Query results</span><h2 id="export-title">Export data</h2></div><button type="button" className="icon-button" onClick={onClose}><X size={16} /></button></header>
      <label><span>Format</span><select value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}>
        <option value="csv">CSV</option><option value="json">JSON</option><option value="xml">XML</option><option value="xls">Excel (XLSX)</option><option value="pdf">PDF</option>
      </select></label>
      <div className="export-fields-header"><strong>Fields</strong><button type="button" onClick={() => setFields(fields.size === names.length ? new Set() : new Set(names))}>{fields.size === names.length ? "Clear all" : "Select all"}</button></div>
      <div className="export-fields">{names.map((name) => <label key={name}><input type="checkbox" checked={fields.has(name)} onChange={() => setFields((current) => { const next = new Set(current); if (next.has(name)) next.delete(name); else next.add(name); return next; })} /><span>{name}</span></label>)}</div>
      {error && <div className="schema-notice">{error}</div>}
      <footer><button type="button" className="secondary-button" disabled={exporting} onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={exporting || fields.size === 0} onClick={() => void runExport()}>{exporting ? <LoaderCircle size={13} className="export-spinner" /> : <Download size={13} />} {exporting ? "Preparing…" : "Export all rows"}</button></footer>
    </section>
  </div>;
}

async function saveExport(format: ExportFormat, columns: string[], records: Record<string, unknown>[]) {
  const name = `query-results-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  let bytes: Uint8Array;
  let extension: string = format;
  if (format === "xls") {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(records, { header: columns }), "Results");
    bytes = new Uint8Array(XLSX.write(book, { bookType: "xlsx", type: "array" }));
    extension = "xlsx";
  } else if (format === "pdf") {
    const pdf = new jsPDF({ orientation: columns.length > 5 ? "landscape" : "portrait" });
    const lines = [columns.join(" | "), ...records.map((record) => columns.map((column) => printable(record[column])).join(" | "))];
    let y = 12;
    for (const line of lines) { for (const wrapped of pdf.splitTextToSize(line, 275)) { if (y > 195) { pdf.addPage(); y = 12; } pdf.text(wrapped, 8, y); y += 5; } }
    bytes = new Uint8Array(pdf.output("arraybuffer"));
  } else {
    const text = format === "json" ? JSON.stringify(records, null, 2)
      : format === "xml" ? `<?xml version="1.0" encoding="UTF-8"?>\n<rows>\n${records.map((record) => `  <row>${columns.map((column) => `<${xmlName(column)}>${escapeXml(printable(record[column]))}</${xmlName(column)}>`).join("")}</row>`).join("\n")}\n</rows>`
      : [columns, ...records.map((record) => columns.map((column) => record[column]))].map((row) => row.map(csvCell).join(",")).join("\n");
    bytes = new TextEncoder().encode(text);
  }
  const path = await save({ defaultPath: `${name}.${extension}`, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] });
  if (!path) return false;
  await invoke("save_export_file", { path, data: bytesToBase64(bytes) });
  return true;
}

function bytesToBase64(bytes: Uint8Array) { let binary = ""; for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)); return btoa(binary); }

const printable = (value: unknown) => typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "");
const csvCell = (value: unknown) => { const text = printable(value); return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
const escapeXml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const xmlName = (value: string) => value.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^[^A-Za-z_]/, "_$&");
