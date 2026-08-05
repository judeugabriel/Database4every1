import type { ColumnMeta, DatabaseEngine } from "../types/database";
import type { GridDataChange } from "../components/QueryDataGrid";

export function buildMutationQueries(
  engine: DatabaseEngine,
  target: { name: string; databaseName?: string },
  columns: ColumnMeta[],
  changes: GridDataChange[],
): string[] {
  if (engine === "mongodb") return mongoMutations(target.name, columns, changes);
  if (engine === "elasticsearch") return elasticsearchMutations(target.name, columns, changes);
  if (engine !== "postgresql" && engine !== "mysql") throw new Error(`Grid editing is not supported for ${engine}`);
  const table = target.name.split(".").map((part) => quoteIdentifier(part, engine)).join(".");
  const directive = engine === "postgresql" && target.databaseName
    ? `-- datacraft:database=${target.databaseName}\n`
    : "";
  return changes.map((change) => {
    if (change.kind === "insert") {
      const values = change.values ?? [];
      const included = columns.map((column, index) => ({ column, index })).filter(({ index }) => values[index] !== null && values[index] !== undefined);
      if (included.length === 0) return `${directive}INSERT INTO ${table} DEFAULT VALUES;`;
      return `${directive}INSERT INTO ${table} (${included.map(({ column }) => quoteIdentifier(column.name, engine)).join(", ")}) VALUES (${included.map(({ column, index }) => sqlValue(values[index], column.data_type, engine)).join(", ")});`;
    }
    const original = change.original ?? [];
    const predicate = columns.map((column, index) => comparison(column.name, original[index], column.data_type, engine)).join(" AND ");
    if (change.kind === "delete") return `${directive}DELETE FROM ${table} WHERE ${predicate};`;
    const values = change.values ?? [];
    const assignments = (change.changedColumns ?? []).map((index) =>
      `${quoteIdentifier(columns[index].name, engine)} = ${sqlValue(values[index], columns[index].data_type, engine)}`,
    ).join(", ");
    return `${directive}UPDATE ${table} SET ${assignments} WHERE ${predicate};`;
  });
}

function mongoMutations(collection: string, columns: ColumnMeta[], changes: GridDataChange[]): string[] {
  const idIndex = columns.findIndex((column) => column.name === "_id");
  return changes.map((change) => {
    if (change.kind === "insert") return `db.${collection}.insertOne(${JSON.stringify(rowObject(columns, change.values ?? []))})`;
    if (idIndex < 0) throw new Error("MongoDB updates and deletes require an _id column");
    const filter = { _id: change.original?.[idIndex] };
    if (change.kind === "delete") return `db.${collection}.deleteOne(${JSON.stringify(filter)})`;
    const set = Object.fromEntries((change.changedColumns ?? [])
      .filter((index) => columns[index].name !== "_id")
      .map((index) => [columns[index].name, change.values?.[index]]));
    return `db.${collection}.updateOne(${JSON.stringify(filter)}, ${JSON.stringify({ $set: set })})`;
  });
}

function elasticsearchMutations(index: string, columns: ColumnMeta[], changes: GridDataChange[]): string[] {
  const idIndex = columns.findIndex((column) => column.name === "_id");
  return changes.map((change) => {
    if (change.kind === "insert") return `POST /${index}/_doc\n${JSON.stringify(rowObject(columns, change.values ?? [], true), null, 2)}`;
    if (idIndex < 0 || change.original?.[idIndex] == null) throw new Error("Elasticsearch updates and deletes require an _id column");
    const id = encodeURIComponent(String(change.original[idIndex]));
    if (change.kind === "delete") return `DELETE /${index}/_doc/${id}`;
    const document: Record<string, unknown> = {};
    for (const columnIndex of change.changedColumns ?? []) {
      const name = columns[columnIndex].name;
      if (name.startsWith("_")) continue;
      setNestedValue(document, name, change.values?.[columnIndex]);
    }
    return `POST /${index}/_update/${id}\n${JSON.stringify({ doc: document }, null, 2)}`;
  });
}

function rowObject(columns: ColumnMeta[], values: unknown[], omitMetadata = false) {
  const result: Record<string, unknown> = {};
  columns.forEach((column, index) => {
    if (omitMetadata && column.name.startsWith("_")) return;
    if (values[index] !== undefined) setNestedValue(result, column.name, values[index]);
  });
  return result;
}

function setNestedValue(target: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".");
  let cursor = target;
  parts.forEach((part, index) => {
    if (index === parts.length - 1) cursor[part] = value;
    else {
      const existing = cursor[part];
      cursor = existing && typeof existing === "object" && !Array.isArray(existing)
        ? existing as Record<string, unknown>
        : (cursor[part] = {}) as Record<string, unknown>;
    }
  });
}

function comparison(name: string, value: unknown, dataType: string, engine: DatabaseEngine) {
  const identifier = quoteIdentifier(name, engine);
  if (value === null || value === undefined) return `${identifier} IS NULL`;
  const literal = sqlValue(value, dataType, engine);
  return engine === "mysql" ? `${identifier} <=> ${literal}` : `${identifier} IS NOT DISTINCT FROM ${literal}`;
}

function sqlValue(value: unknown, dataType: string, engine: DatabaseEngine): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite numbers cannot be saved");
    return String(value);
  }
  if (Array.isArray(value) && engine === "postgresql" && dataType.endsWith("[]")) {
    if (!/^[A-Za-z0-9_ ]+\[\]$/.test(dataType)) throw new Error(`Unsupported PostgreSQL array type: ${dataType}`);
    const elementType = dataType.slice(0, -2);
    return `ARRAY[${value.map((item) => sqlValue(item, elementType, engine)).join(", ")}]::${dataType}`;
  }
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  const literal = `'${text.replace(/'/g, "''")}'`;
  if (engine === "postgresql" && /^(JSON|JSONB)$/i.test(dataType)) return `${literal}::${dataType}`;
  return literal;
}

function quoteIdentifier(identifier: string, engine: DatabaseEngine) {
  return engine === "mysql"
    ? `\`${identifier.replace(/`/g, "``")}\``
    : `"${identifier.replace(/"/g, '""')}"`;
}
