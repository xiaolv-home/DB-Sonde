import { useEffect, useState } from "react";
import type { ColumnInfo, DbKind, IndexInfo, TableInfo } from "../types";
import type { TableTab } from "../store/appStore";
import { EditableText } from "./StructureEditing";
import { useI18n } from "../hooks/useI18n";

export function formatBytes(value?: number | null): string {
  if (value == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}

export function PropertiesPanel({
  tab,
  info,
  onComment,
}: {
  tab: TableTab;
  info?: TableInfo;
  onComment?: (text: string) => void;
}) {
  const { t } = useI18n();
  const fields = [
    [t("inspector.objectName"), tab.table],
    [t("inspector.objectType"), t(tab.objectKind === "view" ? "inspector.view" : "inspector.table")],
    [t("inspector.database"), tab.database],
    [t("inspector.schema"), tab.schema || "—"],
    [t("inspector.engine"), info?.engine || "—"],
    [t("inspector.collation"), info?.collation || "—"],
    [t("inspector.estimatedRows"), info?.estimatedRows?.toLocaleString() ?? "—"],
    [t("inspector.totalSize"), formatBytes(info?.dataSize)],
  ];
  return (
    <div className="property-cards">
      {fields.map(([label, value]) => (
        <div key={label}>
          <b>{label}</b>
          <span>{value}</span>
        </div>
      ))}
      <div className="full">
        <b>{t("inspector.comment")}</b>
        <span>
          <EditableText
            value={info?.comment ?? ""}
            display={info?.comment || t("inspector.noComment")}
            onCommit={onComment}
            placeholder="表注释 · 回车保存 · Esc 取消"
          />
        </span>
      </div>
    </div>
  );
}

export function ColumnsPanel({
  columns,
  onComment,
  onType,
}: {
  columns: ColumnInfo[];
  onComment?: (column: string) => (text: string) => void;
  onType?: (column: string) => (to: string) => void;
}) {
  const { t } = useI18n();
  return (
    <table className="object-grid">
      <thead>
        <tr>
          <th>#</th>
          <th>{t("inspector.column")}</th>
          <th>{t("inspector.dataType")}</th>
          <th>{t("inspector.notNull")}</th>
          <th>{t("inspector.auto")}</th>
          <th>{t("inspector.key")}</th>
          <th>{t("inspector.default")}</th>
          <th>{t("inspector.comment")}</th>
        </tr>
      </thead>
      <tbody>
        {columns.map((column, index) => (
          <tr key={column.name}>
            <td className="numeric">{column.ordinalPosition ?? index + 1}</td>
            <td className="object-name">{column.name}</td>
            <td>
              <EditableText
                value={column.dataType}
                onCommit={onType?.(column.name)}
                placeholder="新类型,比如 varchar(50) · 回车检查"
                mono
              />
            </td>
            <td>{column.nullable ? "" : "✓"}</td>
            <td>{column.autoIncrement ? "✓" : column.generated ? t("inspector.generated") : ""}</td>
            <td>{column.isPrimaryKey ? "PRI" : ""}</td>
            <td className="mono">{column.defaultValue ?? "—"}</td>
            <td>
              <EditableText
                value={column.comment ?? ""}
                display={column.comment || "—"}
                onCommit={onComment?.(column.name)}
                placeholder="列注释 · 回车保存 · Esc 取消"
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function IndexesPanel({ indexes }: { indexes: IndexInfo[] }) {
  const { t } = useI18n();
  return (
    <table className="object-grid">
      <thead>
        <tr>
          <th>{t("inspector.index")}</th>
          <th>{t("inspector.columnsExpression")}</th>
          <th>{t("inspector.unique")}</th>
          <th>{t("inspector.primary")}</th>
          <th>{t("column.type")}</th>
        </tr>
      </thead>
      <tbody>
        {indexes.map((index) => (
          <tr key={index.name}>
            <td className="object-name">{index.name}</td>
            <td className="mono">{index.columns.join(", ")}</td>
            <td>{index.unique ? "✓" : ""}</td>
            <td>{index.primary ? "PRI" : ""}</td>
            <td>{index.indexType || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type DdlCodeModule = typeof import("./DdlCode");
let ddlCodeModule: DdlCodeModule | null = null;
let ddlCodeLoading: Promise<DdlCodeModule> | null = null;

export function preloadDdlCode(): Promise<DdlCodeModule> {
  ddlCodeLoading ??= import("./DdlCode").then((module) => (ddlCodeModule = module));
  return ddlCodeLoading;
}

export function DdlPanel({ ddl, kind }: { ddl: string; kind?: DbKind }) {
  const [module, setModule] = useState<DdlCodeModule | null>(ddlCodeModule);
  useEffect(() => {
    if (module) return;
    let alive = true;
    void preloadDdlCode().then((loaded) => {
      if (alive) setModule(loaded);
    });
    return () => {
      alive = false;
    };
  }, [module]);
  if (!module) {
    return (
      <div className="ddl-view ddl-code">
        <div className="ddl-placeholder" />
      </div>
    );
  }
  const DdlCode = module.default;
  return <DdlCode ddl={ddl} kind={kind} />;
}
