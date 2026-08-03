import { applyQueryControls } from "./queryBuilder";

export function buildObjectPreviewQuery(engine: string | undefined, objectName: string, limit = 200, databaseName?: string) {
  if (engine === "mongodb") {
    return applyQueryControls(`db.${objectName}.find({})`, engine, { limit });
  }
  if (engine === "elasticsearch") {
    return applyQueryControls(`POST /${objectName}/_search
{
  "query": {
    "match_all": {}
  }
}`, engine, { limit });
  }

  const quotedName = quoteQualifiedName(objectName, engine);
  const databaseDirective = engine === "postgresql" && databaseName
    ? `-- datacraft:database=${databaseName}\n`
    : "";
  return applyQueryControls(`${databaseDirective}SELECT * FROM ${quotedName};`, engine, { limit });
}

function quoteQualifiedName(name: string, engine: string | undefined) {
  return name.split(".").map((part) => {
    if (engine === "mysql") return `\`${part.split("`").join("``")}\``;
    if (engine === "mssql") return `[${part.split("]").join("]]" )}]`;
    return `"${part.split('"').join('""')}"`;
  }).join(".");
}
