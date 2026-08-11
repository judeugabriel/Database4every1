import { useEffect, useMemo, useState } from "react";
import { Database, Download, LoaderCircle, X } from "lucide-react";
import { jsPDF } from "jspdf";
import * as XLSX from "xlsx";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type { QueryResult, SchemaTree } from "../../types/database";
import type { ConnectionSummary, DatabaseEngine } from "../../types/connection";
import { executeQuery, normalizeBackendError } from "../../services/database";
import { useWorkspace } from "../WorkspaceContext";

type ExportFormat = "csv" | "json" | "xml" | "xls" | "pdf" | "database";

interface DestinationTarget {
  value: string;
  label: string;
  name: string;
  databaseName?: string;
}

export function ExportResultsModal({ result, sourceEngine, loadAll, onClose }: {
  result: QueryResult;
  sourceEngine?: DatabaseEngine;
  loadAll: () => Promise<QueryResult>;
  onClose: () => void;
}) {
  const { connections, groups, ensureConnection } = useWorkspace();
  const compatibleConnections = useMemo(
    () => connections.filter((connection) => connection.engine === sourceEngine),
    [connections, sourceEngine],
  );
  const names = useMemo(() => result.columns.map((column) => column.name), [result.columns]);
  const [fields, setFields] = useState(() => new Set(names));
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string>();
  const [destinationConnectionId, setDestinationConnectionId] = useState("");
  const [destinationSchema, setDestinationSchema] = useState<SchemaTree>();
  const [destinationTarget, setDestinationTarget] = useState("");
  const [loadingDestination, setLoadingDestination] = useState(false);
  const destinationConnection = connections.find((connection) => connection.id === destinationConnectionId);
  const destinationTargets = useMemo(
    () => destinationConnection && destinationSchema
      ? schemaTargets(destinationConnection, destinationSchema)
      : [],
    [destinationConnection, destinationSchema],
  );

  useEffect(() => {
    if (!destinationConnectionId) {
      setDestinationSchema(undefined);
      setDestinationTarget("");
      return;
    }
    let active = true;
    setLoadingDestination(true);
    setError(undefined);
    void ensureConnection(destinationConnectionId)
      .then((schema) => {
        if (!active) return;
        if (!schema) throw new Error("The destination did not return schema metadata");
        setDestinationSchema(schema);
        setDestinationTarget("");
      })
      .catch((caught) => {
        if (!active) return;
        setDestinationSchema(undefined);
        setDestinationTarget("");
        setError(errorMessage(caught));
      })
      .finally(() => active && setLoadingDestination(false));
    return () => { active = false; };
  // `ensureConnection` returns freshly loaded metadata. Do not depend on the
  // schema map here or its update would reconnect the destination repeatedly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destinationConnectionId, ensureConnection]);

  const runExport = async () => {
    if (fields.size === 0) return;
    setExporting(true);
    setError(undefined);
    try {
      const full = await loadAll();
      const indexes = full.columns.flatMap((column, index) => fields.has(column.name) ? [index] : []);
      const columns = indexes.map((index) => full.columns[index].name);
      const records = full.rows.map((row) => Object.fromEntries(indexes.map((index, item) => [columns[item], row[index]])));
      const saved = format === "database"
        ? await exportToDatabase(destinationConnection, destinationTargets.find((target) => target.value === destinationTarget), columns, records)
        : await saveExport(format, columns, records);
      if (saved) onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setExporting(false);
    }
  };

  return <div className="export-layer" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="export-modal" role="dialog" aria-modal="true" aria-labelledby="export-title">
      <header><div><span className="eyebrow">Query results</span><h2 id="export-title">Export data</h2></div><button type="button" className="icon-button" onClick={onClose}><X size={16} /></button></header>
      <label><span>Export to</span><select value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}>
        <option value="csv">CSV file</option><option value="json">JSON file</option><option value="xml">XML file</option><option value="xls">Excel file (XLSX)</option><option value="pdf">PDF file</option><option value="database">Another database / index</option>
      </select></label>
      {format === "database" && <div className="export-destination">
        <label><span>Destination connection</span><select value={destinationConnectionId} onChange={(event) => setDestinationConnectionId(event.target.value)}>
          <option value="">Select a connection…</option>
          {compatibleConnections.map((connection) => {
            const group = groups.find((candidate) => candidate.id === connection.groupId);
            return <option key={connection.id} value={connection.id} disabled={connection.engine === "redis" || connection.engine === "sqlite"}>{group ? `[(${group.name}) ${connection.label}]` : connection.label}{connection.engine === "redis" || connection.engine === "sqlite" ? " — unsupported destination" : ""}</option>;
          })}
        </select></label>
        <label><span>Destination table / collection / index</span><select disabled={!destinationConnectionId || loadingDestination} value={destinationTarget} onChange={(event) => setDestinationTarget(event.target.value)}>
          <option value="">{loadingDestination ? "Loading schema…" : "Select a destination…"}</option>
          {destinationTargets.map((target) => <option key={target.value} value={target.value}>{target.label}</option>)}
        </select></label>
      </div>}
      <div className="export-fields-header"><strong>Fields</strong><button type="button" onClick={() => setFields(fields.size === names.length ? new Set() : new Set(names))}>{fields.size === names.length ? "Clear all" : "Select all"}</button></div>
      <div className="export-fields">{names.map((name) => <label key={name}><input type="checkbox" checked={fields.has(name)} onChange={() => setFields((current) => { const next = new Set(current); if (next.has(name)) next.delete(name); else next.add(name); return next; })} /><span>{name}</span></label>)}</div>
      {error && <div className="schema-notice">{error}</div>}
      <footer><button type="button" className="secondary-button" disabled={exporting} onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={exporting || fields.size === 0 || (format === "database" && (!destinationConnection || !destinationTarget))} onClick={() => void runExport()}>{exporting ? <LoaderCircle size={13} className="export-spinner" /> : format === "database" ? <Database size={13} /> : <Download size={13} />} {exporting ? "Exporting…" : format === "database" ? "Transfer all rows" : "Export all rows"}</button></footer>
    </section>
  </div>;
}

function schemaTargets(connection: ConnectionSummary, schema: SchemaTree): DestinationTarget[] {
  const targets: DestinationTarget[] = [];
  for (const database of schema.databases) {
    for (const collection of database.collections) targets.push({
      value: `${database.name}\u0000${collection.name}`,
      label: `${database.name} / ${collection.name}`,
      name: collection.name,
      databaseName: database.name,
    });
    for (const schemaNode of database.schemas) {
      for (const table of schemaNode.tables) {
        const name = connection.engine === "elasticsearch" ? table.name : `${schemaNode.name}.${table.name}`;
        targets.push({
          value: `${database.name}\u0000${name}`,
          label: connection.engine === "elasticsearch" ? table.name : `${database.name} / ${name}`,
          name,
          databaseName: database.name,
        });
      }
      for (const collection of schemaNode.collections) targets.push({
        value: `${database.name}\u0000${schemaNode.name}\u0000${collection.name}`,
        label: `${database.name} / ${schemaNode.name} / ${collection.name}`,
        name: collection.name,
        databaseName: database.name,
      });
    }
  }
  return targets.sort((left, right) => left.label.localeCompare(right.label));
}

async function exportToDatabase(
  connection: ConnectionSummary | undefined,
  target: DestinationTarget | undefined,
  columns: string[],
  records: Record<string, unknown>[],
) {
  if (!connection || !target) throw new Error("Choose a destination connection and object");
  if (connection.engine === "redis" || connection.engine === "sqlite") {
    throw new Error(`Direct result transfer is not supported for ${connection.engine}`);
  }
  if (connection.engine === "elasticsearch") {
    for (let index = 0; index < records.length; index += 1) {
      try {
        const record = { ...records[index] };
        const documentId = record._id;
        for (const metadata of ["_id", "_index", "_score", "_type", "_version"]) delete record[metadata];
        const endpoint = documentId === null || documentId === undefined || String(documentId) === ""
          ? `POST /${target.name}/_doc`
          : `PUT /${target.name}/_doc/${encodeURIComponent(String(documentId))}`;
        await executeQuery(connection.id, `${endpoint}\n${JSON.stringify(expandDottedRecord(record))}`, 1, crypto.randomUUID());
      } catch (error) {
        throw transferError(error, index, records.length);
      }
    }
    return true;
  }
  if (connection.engine === "mongodb") {
    for (let index = 0; index < records.length; index += 1) {
      try {
        await executeQuery(connection.id, `db.${target.name}.insertOne(${JSON.stringify(expandDottedRecord(records[index]))})`, 1, crypto.randomUUID());
      } catch (error) {
        throw transferError(error, index, records.length);
      }
    }
    return true;
  }
  const quote = (value: string) => connection.engine === "mysql"
    ? `\`${value.replace(/`/g, "``")}\``
    : `"${value.replace(/"/g, '""')}"`;
  const table = target.name.split(".").map(quote).join(".");
  const directive = connection.engine === "postgresql" && target.databaseName
    ? `-- datacraft:database=${target.databaseName}\n`
    : "";
  for (let offset = 0; offset < records.length; offset += 250) {
    const batch = records.slice(offset, offset + 250);
    const values = batch.map((record) => `(${columns.map((column) => sqlValue(record[column])).join(", ")})`).join(",\n");
    try {
      await executeQuery(connection.id, `${directive}INSERT INTO ${table} (${columns.map(quote).join(", ")}) VALUES\n${values};`, 1, crypto.randomUUID());
    } catch (error) {
      throw transferError(error, offset, records.length);
    }
  }
  return true;
}

function errorMessage(error: unknown) {
  const normalized = normalizeBackendError(error);
  return normalized.code && normalized.code !== "UNKNOWN"
    ? `${normalized.code.replace(/_/g, " ")}: ${normalized.message}`
    : normalized.message;
}

function transferError(error: unknown, completed: number, total: number) {
  return new Error(`Transfer stopped after ${completed.toLocaleString()} of ${total.toLocaleString()} rows. ${errorMessage(error)}`);
}

function expandDottedRecord(record: Record<string, unknown>) {
  const expanded: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(record)) {
    const parts = path.split(".");
    let cursor = expanded;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) cursor[part] = value;
      else cursor = (cursor[part] && typeof cursor[part] === "object" && !Array.isArray(cursor[part])
        ? cursor[part]
        : (cursor[part] = {})) as Record<string, unknown>;
    });
  }
  return expanded;
}

function sqlValue(value: unknown) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot export a non-finite number");
    return String(value);
  }
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `'${text.replace(/'/g, "''")}'`;
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
