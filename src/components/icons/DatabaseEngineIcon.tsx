import type { IconType } from "react-icons";
import { DiMsqlServer } from "react-icons/di";
import {
  SiElasticsearch,
  SiMongodb,
  SiMysql,
  SiPostgresql,
  SiRedis,
  SiSqlite,
} from "react-icons/si";
import type { DatabaseEngine } from "../../types/connection";

const ENGINE_ICONS: Record<DatabaseEngine, { icon: IconType; color: string }> = {
  postgresql: { icon: SiPostgresql, color: "#4169E1" },
  mysql: { icon: SiMysql, color: "#4479A1" },
  sqlite: { icon: SiSqlite, color: "#54A9D8" },
  mongodb: { icon: SiMongodb, color: "#47A248" },
  elasticsearch: { icon: SiElasticsearch, color: "#FEC514" },
  redis: { icon: SiRedis, color: "#DC382D" },
};

interface DatabaseEngineIconProps {
  engine: DatabaseEngine | "mssql";
  size?: number;
  className?: string;
}

export function DatabaseEngineIcon({
  engine,
  size = 15,
  className,
}: DatabaseEngineIconProps) {
  const definition = engine === "mssql"
    ? { icon: DiMsqlServer, color: "#CC2927" }
    : ENGINE_ICONS[engine];
  const Icon = definition.icon;
  return (
    <Icon
      aria-hidden="true"
      className={className}
      color={definition.color}
      size={size}
      title={engine}
    />
  );
}
