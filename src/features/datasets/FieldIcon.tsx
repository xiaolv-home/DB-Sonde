/** 字段的小图标:计算字段 Σ、时间 📅、数值 #、其它维度 T。看板和数据集两边都用,颜色在 studio-kit.css。 */
import { Calendar, Hash, Sigma, Type } from "lucide-react";
import { isTimeField, type DatasetField } from "./domain";

export function FieldIcon({ field, size = 13 }: { field?: Pick<DatasetField, "name" | "type" | "role" | "expr" | "grouping">; size?: number }) {
  if (!field) return <Type size={size} />;
  if (field.expr) return <Sigma size={size} className="st-ic calc" />;
  if (isTimeField(field)) return <Calendar size={size} className="st-ic time" />;
  if (field.role === "measure") return <Hash size={size} className="st-ic measure" />;
  return <Type size={size} className="st-ic dim" />;
}
