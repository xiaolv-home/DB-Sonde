import { useCallback, Fragment, memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Download } from "lucide-react";
import type { Cell } from "../../../types";
import { buildPivot, num, type Rec, type TableColumnSpec } from "../pivot";
import { columnWindow } from "../columnWindow";
import type { DashboardTableOptions } from "../domain";
import { exportSheet } from "../export/sheet";
import { maxOf, minOf } from "../../../lib/numbers";
import { compareText } from "../../../lib/collate";


interface Props {
  columns: TableColumnSpec[];
  rows: Cell[][];
  options?: DashboardTableOptions;
  onDrill?: (field: string, value: string) => void;
  filename?: string;
  /** 取数撞到行数上限、只回来一段。必须说出来 —— 不说的话上面那个「536 行」
   *  看着就像是全部,排序、小计、导出全建立在一段残缺的数据上。 */
  truncated?: boolean;
}

const SUBTOTAL = "\u0001subtotal"; // 标记小计行(避免和真实值冲突)
/* 汇总不回去的格子(平均、去重计数)显示「—」。留空会被当成"这里没数据",
   而它其实是"这个数按定义就不能这么加起来"。 */
const NOT_ROLLABLE = "—";
/* 缺省值要是个常量。写成 options = {} 的话每次渲染都是一个新对象,下面那几个
   以 options.* 为依赖的 useMemo 就永远命中不了。 */
const NO_OPTIONS: DashboardTableOptions = {};
/** 按列的聚合口径把一组值合成一个 —— 比率/均值列加总是错的。 */
/**
 * 小计 / 总计。
 *
 * 注意进来的值**已经被数据库聚合过一轮**了 —— 每一行就是一个分组的结果。所以:
 *   求和的总计 = 各组求和相加            ✓
 *   计数的总计 = 各组计数**相加**        ✓(原来返回 values.length,那是"有几组",
 *                                          五家店各一百单会显示 5)
 *   最大/最小  = 各组最大/最小的最大/最小 ✓
 *   平均       = 算不回去 —— 各组行数不同,平均数的平均数不是总平均
 *   去重计数   = 算不回去 —— 各组的去重集合会重叠,相加是重复计算
 * 后两种返回 null,界面显示「—」。给个错数字比不给更糟:那是会被拿去汇报的。
 */
function rollup(values: number[], how: TableColumnSpec["aggregation"]): number | null {
  if (how === "avg" || how === "count_distinct") return null;
  if (!values.length) return 0;
  // 循环取极值:明细表现在最多取二十万行,参数展开会直接 RangeError
  if (how === "min") return minOf(values);
  if (how === "max") return maxOf(values);
  return values.reduce((t, v) => t + v, 0);
}

/** 明细表 —— 对齐 v1 DataTable 的展示能力。数据来自绑定的维度列 + 指标列。
 *
 *  外面包了 memo:透视表动辄十几行乘上百列,一千多个单元格。看板上随便改点什么都会让
 *  画布重渲染,不拦住的话 React 每次都要把这一千多个格子重新比一遍。 */
function DashboardTable({ columns, rows, options = NO_OPTIONS, onDrill, filename = "看板数据", truncated }: Props) {
  const dims = useMemo(() => columns.filter((c) => c.kind === "dim"), [columns]);
  const metrics = useMemo(() => columns.filter((c) => c.kind === "metric"), [columns]);
  const grouping = options.grouping === true;
  const density = options.density ?? "normal";
  const pageSize = Math.max(1, options.pageSize ?? 20);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);

  // 原始 records(列 key → 值)
  const records = useMemo<Rec[]>(
    () => rows.map((row) => Object.fromEntries(columns.map((c) => [c.key, row[c.colIndex]]))),
    [rows, columns],
  );

  // 1) 按 options 的维度排序(方向 / 组内 / 自定义顺序 / 时间序)
  const dimSorted = useMemo<Rec[]>(() => {
    const list = [...records];
    const timeRe = /date|day|month|time|日期|时间|月|年/i;
    /* 有任何一层要求「组内」排序,那它上面所有层都必须先参与比较 —— 不然上层会被
       打散,所谓的「组内」就无从谈起(大区都混在一起了,还排什么大区内部)。 */
    const anyGrouped = dims.some((d) => String(options.dimensionSorts?.[d.key] ?? "").startsWith("group_"));
    list.sort((a, b) => {
      for (const dim of dims) {
        const configured = options.dimensionSorts?.[dim.key];
        const isTime = timeRe.test(dim.key);
        if (!configured && !isTime && !anyGrouped) continue;
        const raw = configured ?? options.timeOrder ?? "asc";
        const dir = raw === "group_asc" ? "asc" : raw === "group_desc" ? "desc" : raw;
        const lv = String(a[dim.key] ?? "");
        const rv = String(b[dim.key] ?? "");
        if (dir === "custom") {
          const order = options.dimensionCustomOrders?.[dim.key] ?? [];
          const li = order.indexOf(lv);
          const ri = order.indexOf(rv);
          const sl = li < 0 ? Number.MAX_SAFE_INTEGER : li;
          const sr = ri < 0 ? Number.MAX_SAFE_INTEGER : ri;
          if (sl !== sr) return sl - sr;
        }
        const cmp = compareText(lv, rv);
        if (cmp) return dir === "desc" ? -cmp : cmp;
      }
      return 0;
    });
    return list;
  }, [records, dims, options.dimensionSorts, options.dimensionCustomOrders, options.timeOrder]);

  const pivot = options.layout === "pivot" && dims.length > 0;
  /* 点表头排的(临时)优先于配置里存的(持久)。 */
  /* 包成 useMemo:这是个 ?? 出来的新对象,每次渲染都是新引用 —— 下面几个 useMemo
     把它列进依赖,不包等于每次渲染全部重算。 */
  const activeSort = useMemo(
    () => sort ?? (options.metricSort ? { key: options.metricSort.key, dir: options.metricSort.dir } : null),
    [sort, options.metricSort],
  );
  // 扁平表里按指标排会打散维度分组,此时不做合并/小计(纯扁平视图)。
  // 透视表不一样:列是展开的,按某一列排只是换行的先后,分组结构不受影响,所以照排。
  const flatInteractive = !!activeSort && !pivot;

  // 2) 组装展示用的 { columns, rows }
  const display = useMemo(() => {
    /* 按某一列排。within(组内)时先比上层维度,把顺序守住,再在组内比这一列 ——
       「每个大区里 GMV 最高的网点」要的是这个,而不是把全国网点打成一片再排。 */
    const byColumn = (list: Rec[], key: string, dir: "asc" | "desc", within: boolean, keepDims: TableColumnSpec[]) =>
      [...list].sort((a, b) => {
        if (within) {
          for (const dim of keepDims) {
            const cmp = compareText(String(a[dim.key] ?? ""), String(b[dim.key] ?? ""));
            if (cmp) return cmp;
          }
        }
        const av = a[key];
        const bv = b[key];
        const bothNum = typeof av === "number" || typeof bv === "number";
        const cmp = bothNum ? num(av) - num(bv) : compareText(String(av ?? ""), String(bv ?? ""));
        return dir === "desc" ? -cmp : cmp;
      });

    // 交互排序:对任意列扁平排序,忽略合并/小计,保留行/列总计
    if (flatInteractive) {
      const within = !sort && options.metricSort?.within === true;
      const sorted = byColumn(dimSorted, activeSort!.key, activeSort!.dir, within, within ? dims.slice(0, -1) : []);
      return withRowTotal(sorted, [...columns]);
    }

    if (pivot) {
      const built = buildPivot(dimSorted, dims, metrics, options);
      if (!activeSort || !built.columns.some((c) => c.key === activeSort.key)) return built;
      // 透视表里按某一列排:行维度列留在最前面,只是行的先后变了。
      const within = !sort && options.metricSort?.within === true;
      const rowDims = built.columns.filter((c) => c.kind === "dim");
      return { ...built, rows: byColumn(built.rows, activeSort.key, activeSort.dir, within, within ? rowDims.slice(0, -1) : []) };
    }

    // 扁平 + 可选小计
    let out = dimSorted.map((r) => ({ ...r }));
    const cols = [...columns];
    const subKey = options.subtotalDimension;
    if (subKey && dims.some((d) => d.key === subKey)) {
      const grouped = new Map<string, Rec[]>();
      for (const r of out) {
        const k = String(r[subKey] ?? "");
        // push,别 set(k, [...已有的, r]) —— 那是每加一行把该组已有的行整体抄一遍。
        const bucket = grouped.get(k);
        if (bucket) bucket.push(r);
        else grouped.set(k, [r]);
      }
      const merged: Rec[] = [];
      grouped.forEach((group, label) => {
        merged.push(...group);
        const sub: Rec = { [dims[0].key]: `${label} 小计`, [SUBTOTAL]: 1 };
        metrics.forEach((m) => (sub[m.key] = rollup(group.map((r) => num(r[m.key])), m.aggregation) ?? NOT_ROLLABLE));
        merged.push(sub);
      });
      out = merged;
    }
    return withRowTotal(out, cols);

    function withRowTotal(list: Rec[], baseCols: TableColumnSpec[]): { columns: TableColumnSpec[]; rows: Rec[]; cappedColumns?: number } {
      if (!options.rowTotal || metrics.length === 0) return { columns: baseCols, rows: list };
      const totalCol: TableColumnSpec = { key: "\u0001rowtotal", label: "行总计", kind: "metric", colIndex: -1, decimals: metrics[0]?.decimals };
      const rowsWith = list.map((r) => ({ ...r, [totalCol.key]: metrics.reduce((t, m) => t + num(r[m.key]), 0) }));
      return { columns: [...baseCols, totalCol], rows: rowsWith };
    }
  }, [dimSorted, columns, dims, metrics, options, pivot, flatInteractive, sort, activeSort]);

  const displayCols = display.columns;
  const totalRows = display.rows.length;
  const pageCount = Math.max(1, Math.ceil(totalRows / pageSize));
  const curPage = Math.min(page, pageCount);
  const pageRows = display.rows.slice((curPage - 1) * pageSize, curPage * pageSize);

  // 列宽 + 冻结列左偏移
  /* 包成 useCallback:下面两个 useMemo 都要用它,不包的话每次渲染都是新函数,
     依赖数组只能改列它的那几个输入 —— 那就成了"依赖写的不是真依赖",
     以后给 widthOf 加个输入很容易忘了同步。 */
  const widthOf = useCallback(
    (c: TableColumnSpec) =>
      options.columnWidths?.[c.key] ?? (c.kind === "dim" ? options.dimensionWidth ?? 150 : options.metricWidth ?? 130),
    [options.columnWidths, options.dimensionWidth, options.metricWidth],
  );
  const freeze = options.freezeDimensions !== false; // 默认冻结维度列
  const frozenCount = freeze && !pivot ? dims.length : 0;
  const leftOffsets = useMemo(() => {
    const offs: number[] = [];
    let acc = 0;
    displayCols.forEach((c, i) => {
      offs[i] = acc;
      if (i < frozenCount) acc += widthOf(c);
    });
    return offs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayCols, frozenCount, options.columnWidths, options.dimensionWidth, options.metricWidth]);

  /* 横向虚拟化:只画视口里那几列。一千多列全塞进 DOM 的话,十几行就是上万个单元格 ——
     首屏要好几秒,之后在看板上改任何东西都得跟着它重来一遍。列照旧全算出来(那是人家的
     数据,少一列都是错的),只是不全画。 */
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ left: 0, width: 0 });
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      setViewport((current) =>
        (current.left === node.scrollLeft && current.width === node.clientWidth)
          ? current // 没变就别 setState,否则滚动时每帧都重渲染
          : { left: node.scrollLeft, width: node.clientWidth });
    };
    // 滚动事件一秒能来几十次,合并到下一帧再量。
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    node.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(onScroll);
    observer.observe(node);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      node.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, []);

  const colWidths = useMemo(() => displayCols.map(widthOf), [displayCols, widthOf]);
  const win = useMemo(
    () => columnWindow(colWidths, frozenCount, viewport.left, viewport.width),
    [colWidths, frozenCount, viewport.left, viewport.width],
  );
  /** 这一行要画的列:冻结的永远画,其余只画窗口内的。 */
  const windowed = useMemo(
    () => displayCols.slice(0, frozenCount).concat(displayCols.slice(win.from, win.to)),
    [displayCols, frozenCount, win.from, win.to],
  );
  /** 表头有几层(= 列维度个数)。上千列的时候别在渲染里反复扫一遍。 */
  const depth = useMemo(() => Math.max(0, ...displayCols.map((c) => c.groups?.length ?? 0)), [displayCols]);
  /* 每一组列的第一列。透视表里一组(比如 2026-08-01 的十一个指标)紧挨着下一组,
     中间不画条线就看不出哪儿到头 —— 一眼扫过去分不清这个「总GMV」是哪天的。
     按完整列表算,不按窗口内的:虚拟化之后窗口第一列往往在组中间,照窗口算会凭空多出线来。 */
  const groupStart = useMemo(() => {
    const set = new Set<number>();
    displayCols.forEach((column, index) => {
      if (!column.groups?.length) return;
      const key = column.groups.join("\u0001");
      if (displayCols[index - 1]?.groups?.join("\u0001") !== key) set.add(index);
    });
    return set;
  }, [displayCols]);
  /** windowed 里的下标 → displayCols 里的原始下标。冻结判断和左偏移都要用原始的。 */
  const originalIndex = (idx: number) => (idx < frozenCount ? idx : win.from + idx - frozenCount);

  const padCell = (side: "l" | "r", width: number, tag: "td" | "th") => {
    if (width <= 0) return null;
    const Tag = tag;
    // 占位单元格:把没画出来的那些列的宽度顶上,滚动条长度和位置才跟全量渲染一致。
    return <Tag key={`pad-${side}`} className="dash-dt-pad" aria-hidden style={{ minWidth: width, width, padding: 0 }} />;
  };

  // 列总计(全量,排除小计行)
  const columnTotals = useMemo(() => {
    if (!options.columnTotal) return null;
    const src = display.rows.filter((r) => !r[SUBTOTAL]);
    return displayCols.map((c) => (c.kind === "metric" ? rollup(src.map((r) => num(r[c.key])), c.aggregation) : null));
  }, [display.rows, displayCols, options.columnTotal]);

  const isMetric = (c: TableColumnSpec) => c.kind === "metric";
  const fmt = (v: Cell, c: TableColumnSpec) => {
    if (v === NOT_ROLLABLE) return NOT_ROLLABLE;
    if (v == null || v === "") return "";
    if (isMetric(c)) return num(v).toLocaleString(undefined, { maximumFractionDigits: c.decimals ?? 2, useGrouping: grouping });
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  };

  // rowspan 合并(仅维度列,连续同值;非交互、非 pivot、开启合并时)
  const merge = options.mergeDimensions && !flatInteractive && !pivot;
  const spanAt = (colKey: string, rowInPage: number): number => {
    if (!merge) return 1;
    const abs = (curPage - 1) * pageSize + rowInPage;
    const rowsArr = display.rows;
    if (abs > 0 && String(rowsArr[abs - 1]?.[colKey] ?? "") === String(rowsArr[abs]?.[colKey] ?? "") && !rowsArr[abs]?.[SUBTOTAL] && !rowsArr[abs - 1]?.[SUBTOTAL]) return 0;
    let span = 1;
    while (rowsArr[abs + span] && !rowsArr[abs + span]?.[SUBTOTAL] && String(rowsArr[abs + span]?.[colKey] ?? "") === String(rowsArr[abs]?.[colKey] ?? "")) span += 1;
    return span;
  };

  const toggleSort = (c: TableColumnSpec) =>
    setSort((s) => (s?.key === c.key ? (s.dir === "asc" ? { key: c.key, dir: "desc" } : null) : { key: c.key, dir: "asc" }));

  /* 导出 Excel。原来只给 CSV,而且指标列写的是格式化过的字符串(「1,234.56」)——
     那在 Excel 里是一列文本,求和、排序、透视全都用不了。这儿指标列按原始数字写,
     小数位交给单元格格式,顺带把表头冻结、自动筛选、列宽都带上。
     只有数据量超出 Excel 单表装得下的量(104 万行 / 16384 列)才退回 CSV,并说明原因。 */
  const [exportHint, setExportHint] = useState("");
  const exportTable = async () => {
    const cols = displayCols.map((c) => ({
      // 透视列的表头是两级,导出是一行,拼回「列维度值 · 指标」。
      label: c.groups?.length ? `${c.groups.join(" · ")} · ${c.label}` : c.label,
      ...(isMetric(c) ? { decimals: c.decimals ?? 2 } : {}),
    }));
    const rows = display.rows.map((r) => displayCols.map((c) => r[c.key] ?? null));
    const result = await exportSheet(filename, cols, rows);
    setExportHint(result.format === "csv" ? "超出 Excel 单表上限,已导出 CSV" : "");
  };

  const headerStyle = {
    "--dt-head-bg": options.headerBg || "var(--surface-2)",
    "--dt-head-text": options.headerText || "var(--text-2)",
    "--dt-head-align": options.headerAlign || "left",
    "--dt-head-fs": `${options.headerFontSize ?? 12}px`,
    "--dt-head-fw": `${options.headerFontWeight ?? 600}`,
    "--dt-head-h": `${options.headerHeight ?? 38}px`,
    "--dt-row-h": `${options.rowHeight ?? 34}px`,
  } as React.CSSProperties;

  return (
    <div className={`dash-dt density-${density}`} style={headerStyle}>
      <div className="dash-dt-tools">
        <span>{totalRows} 行 · {displayCols.length} 列</span>
        {truncated && (
          <em className="dash-dt-truncated" title="把日期范围收窄一点,或者少放几个维度">
            数据没取全:撞到行数上限了,下面这些是其中一段
          </em>
        )}
        <button className="dash-dt-csv" onClick={() => void exportTable()} title="导出 Excel"><Download size={12} /> Excel</button>
        {exportHint && <em className="dash-dt-export-hint">{exportHint}</em>}
      </div>
      <div className="dash-dt-scroll" ref={scrollRef}>
        <table className={options.stripe !== false ? "striped" : ""}>
          <thead>
            {/* 透视表头:列维度有几个就有几行,每行把连着相同的取值跨列合并,最后一行是指标。
                大区在上、主管在下、指标在最下面 —— 而不是把「北京大区 / 刘海涛」挤进一格。
                只画窗口内的列,跨列合并也只在窗口内算 —— 露在窗口外的那一截本来就没画。 */}
            {displayCols.some((c) => c.groups?.length) ? (
              <>
                {Array.from({ length: depth }, (_, level) => (
                  <tr key={`lvl-${level}`}>
                    {(() => {
                      const cells: React.ReactNode[] = [];
                      for (let k = 0; k < windowed.length;) {
                        const c = windowed[k];
                        const i = originalIndex(k);
                        if (!c.groups?.length) {
                          // 行维度列:只在第一行出一次,纵向跨满所有表头行。
                          if (level > 0) { k += 1; continue; }
                          cells.push(
                            <th
                              key={c.key}
                              rowSpan={depth + 1}
                              className={`${isMetric(c) ? "num" : ""} ${i < frozenCount ? "frozen" : ""}`}
                              style={{ minWidth: widthOf(c), left: i < frozenCount ? leftOffsets[i] : undefined }}
                              onClick={() => toggleSort(c)}
                            >
                              <span className="dash-dt-th">{c.label}{activeSort?.key === c.key && (activeSort.dir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}</span>
                            </th>,
                          );
                          k += 1;
                          if (k === frozenCount) cells.push(padCell("l", win.padLeft, "th"));
                          continue;
                        }
                        /* 合并到「这一层以及它上面所有层」都相同为止 —— 只看本层的话,
                           两个不同大区下同名的主管会被并成一格。 */
                        const path = c.groups.slice(0, level + 1).join("\u0001");
                        let j = k;
                        while (j < windowed.length && windowed[j].groups?.slice(0, level + 1).join("\u0001") === path) j += 1;
                        cells.push(<th key={`grp-${level}-${path}-${k}`} colSpan={j - k}
                          className={`grouphead${groupStart.has(originalIndex(k)) ? " group-start" : ""}`}>{c.groups[level]}</th>);
                        k = j;
                      }
                      if (frozenCount === 0) cells.unshift(padCell("l", win.padLeft, "th"));
                      cells.push(padCell("r", win.padRight, "th"));
                      return cells;
                    })()}
                  </tr>
                ))}
                <tr>
                  {padCell("l", win.padLeft, "th")}
                  {windowed.map((c, idx) => c.groups?.length ? (
                    <th
                      key={c.key}
                      className={`${isMetric(c) ? "num" : ""} subhead${groupStart.has(originalIndex(idx)) ? " group-start" : ""}`}
                      style={{ minWidth: widthOf(c) }}
                      onClick={() => toggleSort(c)}
                    >
                      <span className="dash-dt-th">{c.label}{activeSort?.key === c.key && (activeSort.dir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}</span>
                    </th>
                  ) : null)}
                  {padCell("r", win.padRight, "th")}
                </tr>
              </>
            ) : (
            <tr>
              {windowed.map((c, idx) => {
                const i = originalIndex(idx);
                return (
                  <Fragment key={c.key}>
                    <th
                      className={`${isMetric(c) ? "num" : ""} ${i < frozenCount ? "frozen" : ""}`}
                      style={{ minWidth: widthOf(c), left: i < frozenCount ? leftOffsets[i] : undefined }}
                      onClick={() => toggleSort(c)}
                    >
                      <span className="dash-dt-th">{c.label}{activeSort?.key === c.key && (activeSort.dir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}</span>
                    </th>
                    {idx === frozenCount - 1 && padCell("l", win.padLeft, "th")}
                  </Fragment>
                );
              })}
              {frozenCount === 0 && padCell("l", win.padLeft, "th")}
              {padCell("r", win.padRight, "th")}
            </tr>
            )}
          </thead>
          <tbody>
            {pageRows.map((r, ri) => {
              const isSub = !!r[SUBTOTAL];
              return (
                <tr key={ri} className={isSub ? "subtotal" : ""}>
                  {frozenCount === 0 && padCell("l", win.padLeft, "td")}
                  {windowed.map((c, idx) => {
                    const ci = originalIndex(idx);
                    const span = ci < frozenCount ? spanAt(c.key, ri) : 1;
                    if (span === 0) return idx === frozenCount - 1 ? padCell("l", win.padLeft, "td") : null;
                    const drillable = !isSub && !!onDrill && c.kind === "dim" && c === dims[0];
                    return (
                      <Fragment key={c.key}>
                        <td
                          rowSpan={span > 1 ? span : undefined}
                          className={`${isMetric(c) ? "num" : ""} ${ci < frozenCount ? "frozen" : ""} ${drillable ? "drillable" : ""} ${groupStart.has(ci) ? "group-start" : ""}`}
                          style={{ minWidth: widthOf(c), left: ci < frozenCount ? leftOffsets[ci] : undefined }}
                          onClick={drillable ? () => onDrill!(c.key, String(r[c.key] ?? "")) : undefined}
                        >
                          {fmt(r[c.key], c)}
                        </td>
                        {idx === frozenCount - 1 && padCell("l", win.padLeft, "td")}
                      </Fragment>
                    );
                  })}
                  {padCell("r", win.padRight, "td")}
                </tr>
              );
            })}
          </tbody>
          {columnTotals && (
            <tfoot>
              <tr className="coltotal">
                {frozenCount === 0 && padCell("l", win.padLeft, "td")}
                {windowed.map((c, idx) => {
                  const i = originalIndex(idx);
                  return (
                    <Fragment key={c.key}>
                      <td className={`${isMetric(c) ? "num" : ""} ${i < frozenCount ? "frozen" : ""} ${groupStart.has(i) ? "group-start" : ""}`} style={{ left: i < frozenCount ? leftOffsets[i] : undefined }}>
                        {i === 0 ? "列总计" : columnTotals[i] == null ? (isMetric(c) ? NOT_ROLLABLE : "") : Number(columnTotals[i]).toLocaleString(undefined, { maximumFractionDigits: c.decimals ?? 2, useGrouping: grouping })}
                      </td>
                      {idx === frozenCount - 1 && padCell("l", win.padLeft, "td")}
                    </Fragment>
                  );
                })}
                {padCell("r", win.padRight, "td")}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {pageCount > 1 && (
        <div className="dash-dt-pager">
          <button disabled={curPage <= 1} onClick={() => setPage(curPage - 1)}>‹</button>
          <span>{curPage} / {pageCount}</span>
          <button disabled={curPage >= pageCount} onClick={() => setPage(curPage + 1)}>›</button>
        </div>
      )}
    </div>
  );
}

export default memo(DashboardTable);

