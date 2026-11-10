import { BANDS as BAND_SET, layoutHeight, type Band, type LayoutItem, type PlacedItem } from "./layout";

/**
 * 看板验收 —— **先跑代码规则,剩下的才交给模型**。
 *
 * 设计报告第 12.3 节:能用代码判定的一律用代码。这十条都是确定性的,
 * 不需要判断力,交给 LLM 只会又慢又不稳。模型该管的是「标题说不说人话」
 * 「信息层级顺不顺」这类真需要判断的事。
 *
 * 每条 finding 带 suggestedFix —— 修正时是**打补丁**,不是让设计节点重来一遍。
 * 重设计既慢又会把上一轮对的地方也改掉。
 */

export interface ReviewFinding {
  layer: "data" | "chart" | "dashboard";
  severity: "must_fix" | "should_fix" | "nit";
  /** 哪个组件(按 items 下标)。整体性问题为 undefined。 */
  index?: number;
  code: string;
  reason: string;
  /** 直接可应用的修法。 */
  fix?: Partial<LayoutItem>;
}

export interface ReviewContext {
  /** 每个组件的数据点数,用来判断数据标签会不会糊。 */
  pointCounts: Record<number, number>;
  /** 通过验证的指标 id —— 绑了别的就是严重错误。 */
  validatedMetricIds: string[];
  /** 每个组件上**最大**的指标量级(绝对值)。换不换算要看真实数字,不能一刀切。 */
  magnitudes?: Record<number, number>;
  /** 同一张卡上**最小**的指标量级 —— 一张卡放好几个指标时,定死一档会让小的那个读不出来。 */
  smallest?: Record<number, number>;
}

// Distinct scopes, series and pivot settings can answer different questions.
const key = (item: LayoutItem) => JSON.stringify({ type: item.type, metricIds: item.metricIds,
  dimensions: item.dimensions, secondary: item.secondaryMetricIds, series: item.seriesDimension,
  scope: item.lockedScope, table: item.table, chart: item.chart, kpi: item.kpi, topN: item.topN });

/** 十条确定性规则。返回空数组 = 代码层面没问题。 */
export function reviewLayout(placed: PlacedItem[], context: ReviewContext): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  placed.forEach((item) => {
    const index = item.sourceIndex;
    // R10 绑了没验过的指标 —— 最严重,说明前面的闸门被绕过了
    const unknown = item.metricIds.filter((id) => !context.validatedMetricIds.includes(id));
    if (unknown.length) {
      findings.push({
        layer: "data", severity: "must_fix", index, code: "UNVALIDATED_METRIC",
        reason: `组件「${item.title}」绑了没通过验证的指标 ${unknown.join("、")}。只能用 validate_metrics 返回的 metricId。`,
        fix: { metricIds: item.metricIds.filter((id) => context.validatedMetricIds.includes(id)) },
      });
    }

    /* 以前这里有两条「必须改」:比率指标不能画饼图、时间维度不能用饼图 / 非时间不能用折线,
       并且直接把类型换掉。用哪种图交给设计 AI 自己判断(它看得到每个指标是怎么汇总的),
       这里只管画不画得出来。 */

    // 全部排名是有效表达，不强制截取前 N。

    /* 原来这里有一条「数据点多于 30 个,开数据标签会糊成一团」的提醒。
       删掉了:数据标签默认根本不开,这条**警告的是不存在的事** ——
       真机上一次就刷出 4 条,全是噪音。
       该做的不是提醒,而是在建组件时按点数决定要不要开标签(见 DashboardExecutor)。 */

    // KPI 不该带分析维度 —— 带了就不是一个数,是一堆数
    if (item.type === "kpi" && item.dimensions.length) {
      findings.push({
        layer: "chart", severity: "must_fix", index, code: "KPI_WITH_DIMENSION",
        reason: `KPI 卡「${item.title}」带了维度 ${item.dimensions.join("、")},那样出来的不是一个数。`,
        fix: { dimensions: [] },
      });
    }

    /* 单位换算要看**真实量级**,不能一刀切。
       第一版对所有 KPI 一律建议「万」,于是笔均金额 32.60 元被换成了「0万」、
       日店均 4180 元变成「0.4万」—— 自动修正把能看的数改成了看不懂的数。
       现在两个方向都判:该换的没换要提,不该换的换了也要撤。 */
    if (item.type === "kpi") {
      const magnitude = context.magnitudes?.[index];
      /* 模型**显式给了** scale 就按它的来 —— 那是它的显示决定,不是错误。
         只在它没表态(undefined)时代劳。原来不管三七二十一都改,
         于是每块看板都被"修"两三处换算,用户看到的是一长串自动修正,
         实际只是我的代码和模型在同一件审美事上打架。 */
      if (magnitude != null) {
        const current = item.scale ?? "none";
        const div = current === "yi" ? 1e8 : current === "wan" ? 1e4 : 1;
        const min = context.smallest?.[index] ?? magnitude;
        /* 一张卡上量级跨了档(销售额 5682 万 + 笔均金额 26 元):定死任何一档都有一半
           读不出来。auto 让每个数按自己的量级选,这是唯一对的答案。 */
        const mixed = min > 0 && magnitude / min >= 1e4;
        if (mixed && current !== "auto") {
          findings.push({
            layer: "chart", severity: "nit", index, code: "MIXED_SCALE",
            reason: `「${item.title}」上几个指标的量级差得远(最大 ${magnitude.toLocaleString(undefined, { maximumFractionDigits: 0 })}、` +
              `最小 ${min.toLocaleString(undefined, { maximumFractionDigits: 2 })}),定死一档会让小的那个显示成 0 点几。`,
            fix: { scale: "auto" },
          });
        } else if (current !== "none" && current !== "auto" && min / div < 1) {
          /* 换算把数变成了「0万」「0.4万」—— 这不是审美问题,是**读不出数**,必须撤。
             模型自己挑的也照撤:它看不到真实量级,而我们看得到。 */
          findings.push({
            layer: "chart", severity: "nit", index, code: "WRONG_SCALE",
            reason: `「${item.title}」的值是 ${min.toLocaleString(undefined, { maximumFractionDigits: 2 })},` +
              `换算成${current === "yi" ? "亿" : "万"}会变成 0 点几,反而看不懂。`,
            fix: { scale: "none" },
          });
        } else if (item.scale === undefined && !mixed && magnitude >= 1e4) {
          /* 模型**没表态**时才代劳。原来不管它给没给都按自己的标准改一遍,
             于是每块看板都被"修"两三处换算 —— 那只是我的代码和模型在同一件事上打架。 */
          const want: LayoutItem["scale"] = magnitude >= 1e8 ? "yi" : "wan";
          findings.push({
            layer: "chart", severity: "nit", index, code: "NO_SCALE",
            reason: `「${item.title}」的值是 ${magnitude.toLocaleString(undefined, { maximumFractionDigits: 0 })},` +
              `摊开读不出量级,按${want === "yi" ? "亿" : "万"}显示。`,
            fix: { scale: want },
          });
        }
      }
    }
  });

  // R4 重复表达:同类型 + 同指标 + 同维度 = 两张一模一样的图
  const seen = new Map<string, PlacedItem>();
  for (const item of placed) {
    if (item.type === "text" || item.type === "container") continue;
    const k = key(item);
    const first = seen.get(k);
    if (first) {
      findings.push({
        layer: "dashboard", severity: "must_fix", index: item.sourceIndex, code: "DUPLICATE_WIDGET",
        reason: `「${item.title}」和「${first.title}」使用相同的数据范围、绑定和展示配置,删掉一个。`,
      });
    } else seen.set(k, item);
  }

  // Hierarchy is judged against the question and rendered page, not a fixed KPI position.

  // R6 越界 / 重叠 —— resolveLayout 应该已经修干净了。这里兜底:
  //    真报出来说明修的那段坏了,是代码 bug,不是模型的锅。
  for (const item of placed) {
    if (item.x < 0 || item.x + item.w > 12) {
      findings.push({ layer: "dashboard", severity: "must_fix", code: "OUT_OF_GRID", reason: `「${item.title}」超出 12 栏网格。` });
    }
  }
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i], b = placed[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        findings.push({ layer: "dashboard", severity: "must_fix", code: "OVERLAP", reason: `「${a.title}」和「${b.title}」重叠了。` });
      }
    }
  }

  /* R7 页面太长。
     阈值从 40 提到 64:40 行大概就是八九个组件,而设计提示现在是"组件数量由问题的
     分析深度决定"—— 两边会打架,模型刚按深度铺开就被这条推回去精简。
     长本身不是错,滚半天却没新东西才是。所以只在**明显**过长时提醒,
     而且建议改成拆分页(container.tabs),不是砍内容。 */
  const height = layoutHeight(placed);
  if (height > 64) {
    findings.push({
      layer: "dashboard", severity: "should_fix", code: "TOO_LONG",
      reason: `看板有 ${height} 行高,要滚很久才看得到底。考虑用 container.tabs 分成几页,` +
        `按阅读层次组织;内容本身不必删。`,
    });
  }

  // 一个组件都没有 / 只有明细表没有概览
  if (placed.length === 0) {
    findings.push({ layer: "dashboard", severity: "must_fix", code: "EMPTY", reason: "看板一个组件都没有。" });
  }

  return findings;
}

/** 把可自动修的 finding 应用到布局上 —— 打补丁,不重新设计。 */
function applyOnce(items: LayoutItem[], findings: ReviewFinding[]): { items: LayoutItem[]; applied: string[]; remaining: ReviewFinding[] } {
  const next = [...items];
  const applied: string[] = [];
  const remaining: ReviewFinding[] = [];
  const toDelete = new Set(findings.filter((f) => f.code === "DUPLICATE_WIDGET" && f.index != null).map((f) => f.index!));

  for (const finding of findings) {
    if (finding.code === "DUPLICATE_WIDGET") { applied.push(finding.code); continue; }
    if (finding.fix && finding.index != null && next[finding.index]) {
      next[finding.index] = { ...next[finding.index], ...finding.fix };
      applied.push(finding.code);
    } else {
      remaining.push(finding);
    }
  }
  /* 指标被剔光的组件直接删掉 —— 留一个什么都没绑的空卡片,比没有它更糟。 */
  for (const [i, item] of next.entries()) {
    if (item.type !== "text" && item.metricIds.length === 0) { toDelete.add(i); applied.push("DROP_EMPTY"); }
  }
  return { items: next.filter((_, i) => !toDelete.has(i)), applied, remaining };
}

/**
 * 反复打补丁直到稳定。
 *
 * 一轮修完会产生新问题:三张图分别因为"折线用在非时间维度""分类太多不能用饼图"
 * 被改成柱图之后,它们就变成同一张图了。这种连锁是确定性的,应该在这里用代码收敛,
 * 不值得为它烧一轮 LLM 重设计。
 */
export function applyFixes(
  items: LayoutItem[],
  findings: ReviewFinding[],
  recheck?: (items: LayoutItem[]) => ReviewFinding[],
  maxPasses = 4,
): { items: LayoutItem[]; applied: string[]; remaining: ReviewFinding[] } {
  let current = items;
  let pending = findings;
  const applied: string[] = [];
  let remaining: ReviewFinding[] = [];

  for (let pass = 0; pass < maxPasses; pass++) {
    const round = applyOnce(current, pending);
    applied.push(...round.applied);
    remaining = round.remaining;
    const changed = round.applied.length > 0;
    current = round.items;
    if (!changed || !recheck) break;
    pending = recheck(current);
    if (pending.length === 0) { remaining = []; break; }
    // 只剩改不动的(nit / 没有 fix 的)就停,别空转
    if (!pending.some((f) => f.fix || f.code === "DUPLICATE_WIDGET")) { remaining = pending; break; }
  }
  return { items: current, applied, remaining };
}

export function reviewVerdict(findings: ReviewFinding[]): { verdict: "pass" | "needs_revision"; summary: string } {
  const must = findings.filter((f) => f.severity === "must_fix");
  const should = findings.filter((f) => f.severity === "should_fix");
  if (must.length) return { verdict: "needs_revision", summary: `${must.length} 个必须修的问题:${must.map((f) => f.code).join("、")}` };
  if (should.length) return { verdict: "needs_revision", summary: `${should.length} 个建议修的问题:${should.map((f) => f.code).join("、")}` };
  return { verdict: "pass", summary: "版面检查通过。" };
}


// ── 需要判断力的那一半 ────────────────────────────────────────

/**
 * LLM 评审只管代码判不了的事。
 *
 * 分工必须写死,否则它会把代码已经判过的又说一遍(饼图分类太多、KPI 带维度…),
 * 既浪费又会和代码规则的结论打架。
 *
 * 更要紧的是**限制它能改什么**:只能改标题、副标题、层级,或者删掉一个多余的组件。
 * 绝不允许它动 metricIds —— 那会绕过指标验证这道闸门,让没验过的指标混进看板。
 */
export interface JudgementFix {
  title?: string;
  subtitle?: string;
  band?: Band;
  /** 这个组件是多余的,删掉。 */
  drop?: boolean;
}

export interface Judgement {
  verdict: "pass" | "needs_revision";
  findings: { index: number; issue: string; severity: ReviewFinding["severity"]; fix?: JudgementFix }[];
}

/** 把模型的判断落到布局上。只认白名单里的字段。 */
export function applyJudgement(
  items: LayoutItem[],
  judgement: Judgement,
): { items: LayoutItem[]; applied: string[]; remaining: ReviewFinding[] } {
  const next = [...items];
  const drop = new Set<number>();
  const applied: string[] = [];
  const remaining: ReviewFinding[] = [];

  for (const finding of judgement.findings) {
    const target = next[finding.index];
    const fix = finding.fix;
    if (!target || !fix) {
      remaining.push({ layer: "dashboard", severity: finding.severity, index: finding.index >= 0 ? finding.index : undefined,
        code: "JUDGEMENT", reason: finding.issue });
      continue;
    }
    /* 审查层**只报不动手**。
       原来它能改标题、改副标题、删组件 —— 真机上一块 8 组件的看板被自动修了 9 处,
       其中一多半是标题重写和"这个组件多余"。用户的原话是「版式主题感觉没变化,
       像是被你框死了」:设计是模型做的,可最后端上来的是被我改过一遍的版本。
       会让人**读错数**的硬伤(图表类型、KPI 带维度、重复图、空卡)由代码规则管,
       那些有客观标准;标题好不好、哪个组件多余,没有客观标准,交回给设计者。
       判断仍然如实报给用户看,只是不再替他拍板。 */
    const patch: Partial<LayoutItem> = {};
    if (fix.band && (BAND_SET as readonly string[]).includes(fix.band)) patch.band = fix.band;
    if (Object.keys(patch).length === 0) {
      remaining.push({ layer: "dashboard", severity: finding.severity, index: finding.index,
        code: "JUDGEMENT", reason: finding.issue });
      continue;
    }
    next[finding.index] = { ...target, ...patch };
    applied.push(Object.keys(patch).join("+"));
  }
  return { items: next.filter((_, i) => !drop.has(i)), applied, remaining };
}
