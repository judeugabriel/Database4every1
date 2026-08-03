export type QuerySort = { column: string; direction: "asc" | "desc" };

export interface QueryControls {
  limit: number;
  page?: number;
  sort?: QuerySort;
}

export function applyQueryControls(
  query: string,
  engine: string | undefined,
  { limit, page = 1, sort }: QueryControls,
): string {
  const offset = Math.max(0, page - 1) * limit;
  if (engine === "mongodb") return buildMongoQuery(query, limit, offset, sort);
  if (engine === "elasticsearch") return buildElasticsearchQuery(query, limit, offset, sort);
  return buildSqlQuery(query, limit, offset, sort, engine === "mssql");
}

function buildSqlQuery(query: string, limit: number, offset: number, sort: QuerySort | undefined, isMsSql: boolean) {
  let sql = query.trim().replace(/;\s*$/, "");
  sql = sql.replace(/\s+LIMIT\s+\d+(?:\s+OFFSET\s+\d+)?\s*$/i, "");
  sql = sql.replace(/\s+OFFSET\s+\d+\s*$/i, "");
  sql = sql.replace(/\s+ORDER\s+BY\s+[\s\S]*$/i, "");
  sql = sql.replace(/^(\s*SELECT\s+)TOP\s+\d+\s+/i, "$1");
  if (sort) sql += ` ORDER BY ${quoteIdentifier(sort.column)} ${sort.direction.toUpperCase()}`;
  if (isMsSql) {
    if (offset === 0) return sql.replace(/^(\s*SELECT\s+)/i, `$1TOP ${limit} `) + ";";
    if (!sort) sql += " ORDER BY (SELECT NULL)";
    return `${sql} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY;`;
  }
  return `${sql} LIMIT ${limit} OFFSET ${offset};`;
}

function buildMongoQuery(query: string, limit: number, offset: number, sort?: QuerySort) {
  let mongo = query.trim().replace(/;\s*$/, "")
    .replace(/\.sort\(\{[\s\S]*?\}\)/g, "")
    .replace(/\.skip\(\d+\)/g, "")
    .replace(/\.limit\(\d+\)/g, "");
  if (sort) mongo += `.sort({ ${JSON.stringify(sort.column)}: ${sort.direction === "asc" ? 1 : -1} })`;
  return `${mongo}.skip(${offset}).limit(${limit})`;
}

function buildElasticsearchQuery(query: string, limit: number, offset: number, sort?: QuerySort) {
  const trimmed = query.trim();
  const newline = trimmed.indexOf("\n");
  const hasRequestLine = /^(GET|POST)\s+/i.test(trimmed);
  const requestLine = hasRequestLine ? trimmed.slice(0, newline).replace(/^GET/i, "POST") : undefined;
  const jsonText = hasRequestLine ? trimmed.slice(newline + 1) : trimmed;
  try {
    const body = JSON.parse(jsonText) as Record<string, unknown>;
    body.size = limit;
    body.from = offset;
    body.track_total_hits = true;
    if (sort) {
      const previous = findElasticsearchSortOptions(body.sort, sort.column);
      body.sort = [{
        [sort.column]: previous && typeof previous === "object"
          ? { ...previous, order: sort.direction }
          : sort.direction,
      }];
    }
    else delete body.sort;
    const formatted = JSON.stringify(body, null, 2);
    return requestLine ? `${requestLine}\n${formatted}` : formatted;
  } catch {
    return query;
  }
}

function findElasticsearchSortOptions(sortValue: unknown, column: string): Record<string, unknown> | undefined {
  if (!Array.isArray(sortValue)) return undefined;
  for (const item of sortValue) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const options = (item as Record<string, unknown>)[column];
    if (options && typeof options === "object" && !Array.isArray(options)) {
      return options as Record<string, unknown>;
    }
  }
  return undefined;
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.split('"').join('""')}"`;
}
