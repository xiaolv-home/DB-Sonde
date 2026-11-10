import { ImageIcon } from "lucide-react";
import type { DashboardWidget } from "../domain";

/** 图片组件:Logo、示意图、截图。不取数。 */
export default function ImageWidget({ widget }: { widget: DashboardWidget }) {
  const io = widget.options.image ?? {};
  if (!io.src) {
    return (
      <div className="dash-widget-state dash-image-empty">
        <ImageIcon size={20} />
        <span>在右边设置里选一张图片</span>
      </div>
    );
  }
  return (
    <div className="dash-image">
      <img src={io.src} alt={io.name ?? widget.title} draggable={false} style={{ objectFit: io.fit ?? "contain" }} />
    </div>
  );
}
