import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Palette, SunMoon } from "lucide-react";
import { useApp } from "../store/appStore";
import { useI18n } from "../hooks/useI18n";
import { SYNTAX_THEMES } from "../store/syntaxThemes";
import { THEMES } from "../store/themes";

type PaletteItem = { id: string; name: string; hint: string; swatch: readonly string[] };

/** 工具栏上的色板下拉:界面主题和代码配色长得一样,只有内容不同。 */
function PalettePicker({ icon, title, items, current, onPick }: {
  icon: ReactNode;
  title: string;
  items: PaletteItem[];
  current: string;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);

  // 点外面或按 Esc 关掉
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!hostRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="syntax-picker" ref={hostRef}>
      <button className="icon-btn" title={title} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {icon}
      </button>
      {open && (
        <div className="syntax-menu" role="listbox" aria-label={title}>
          <div className="syntax-menu-title">{title}</div>
          {items.map((item) => (
            <button
              key={item.id}
              role="option"
              aria-selected={item.id === current}
              className={"syntax-item" + (item.id === current ? " is-active" : "")}
              onClick={() => { onPick(item.id); setOpen(false); }}
            >
              <span className="syntax-swatch" aria-hidden="true">
                {item.swatch.map((c) => <i key={c} style={{ background: c }} />)}
              </span>
              <span className="syntax-text">
                <span className="syntax-name">{item.name}</span>
                <span className="syntax-hint">{item.hint}</span>
              </span>
              {item.id === current && <Check size={14} className="syntax-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 界面主题:墨 / 霜 / 纸。 */
export function ThemePicker() {
  const { t, language } = useI18n();
  const current = useApp((s) => s.theme);
  const zh = language === "zh-CN";
  return (
    <PalettePicker
      icon={<SunMoon size={17} />}
      title={t("toolbar.theme")}
      current={current}
      items={THEMES.map((theme) => ({ id: theme.id, name: zh ? theme.zh : theme.name, hint: zh ? theme.zhHint : theme.hint, swatch: theme.swatch }))}
      onPick={(id) => useApp.getState().setTheme(id as (typeof THEMES)[number]["id"])}
    />
  );
}

/** 代码配色:只换 SQL 编辑器的语法着色,不动界面。 */
export function SyntaxThemePicker() {
  const { t, language } = useI18n();
  const current = useApp((s) => s.syntaxTheme);
  return (
    <PalettePicker
      icon={<Palette size={17} />}
      title={t("toolbar.syntaxTheme")}
      current={current}
      items={SYNTAX_THEMES.map((theme) => ({ id: theme.id, name: language === "zh-CN" ? theme.zh : theme.name, hint: theme.hint, swatch: theme.swatch }))}
      onPick={(id) => useApp.getState().setSyntaxTheme(id as (typeof SYNTAX_THEMES)[number]["id"])}
    />
  );
}
