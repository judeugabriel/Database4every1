export interface ColumnMeta {
  name: string;
  data_type: string;
  nullable: boolean;
}

export interface TableNode {
  name: string;
  columns: ColumnMeta[];
}

export interface CollectionNode {
  name: string;
  columns: ColumnMeta[];
}

export interface SchemaNode {
  name: string;
  tables: TableNode[];
  views: TableNode[];
  collections: CollectionNode[];
}

export interface DatabaseNode {
  name: string;
  schemas: SchemaNode[];
  collections: CollectionNode[];
}

export interface SchemaTree {
  databases: DatabaseNode[];
}

export interface QueryResult {
  columns: ColumnMeta[];
  rows: unknown[][];
  execution_time_ms: number;
  total_affected: number;
  total_records?: number;
}

export interface BackendError {
  code: string;
  message: string;
  details?: unknown;
}

export type {
  ConnectionConfig,
  ConnectionGroup,
  ConnectionSummary,
  ConnectionWorkspace,
  DatabaseEngine,
  SshTunnelConfig,
  SslMode,
} from "./connection";

export interface CompletionField {
  table: string;
  name: string;
  dataType: string;
}

export interface CompletionCatalog {
  tables: string[];
  fields: CompletionField[];
}

export function buildCompletionCatalog(tree: SchemaTree): CompletionCatalog {
  const tables: string[] = [];
  const fields: CompletionField[] = [];

  for (const database of tree.databases) {
    for (const collection of database.collections) {
      tables.push(collection.name);
      for (const column of collection.columns) {
        fields.push({
          table: collection.name,
          name: column.name,
          dataType: column.data_type,
        });
      }
    }

    for (const schema of database.schemas) {
      for (const item of [
        ...schema.tables,
        ...schema.views,
        ...schema.collections,
      ]) {
        const qualifiedName = `${schema.name}.${item.name}`;
        tables.push(qualifiedName);
        tables.push(item.name);
        for (const column of item.columns) {
          fields.push({
            table: qualifiedName,
            name: column.name,
            dataType: column.data_type,
          });
        }
      }
    }
  }

  return { tables: [...new Set(tables)], fields };
}
