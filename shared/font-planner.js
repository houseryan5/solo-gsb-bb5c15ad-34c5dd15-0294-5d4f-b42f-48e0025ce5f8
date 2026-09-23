/**
 * 字体搭配规划（前端浏览器与后端 Node 共用的纯 ESM 模块）。
 *
 * 给定目标范围（已合并区间）与若干候选字体（各自携带 cmap 声明区间），
 * 以贪心策略逐轮挑选「当前缺口下新增覆盖码位数最多」的字体：
 *   1. 每轮对每个候选字体计算 其 cmap 区间 ∩ 当前剩余缺口 的码位数；
 *   2. 取得增益最大的字体；增益相同时按字体 ID 升序取先；
 *   3. 只有该字体「首次覆盖」的交集区间归到它名下（已被先前字体覆盖的
 *      部分不再重复计入），随后从剩余缺口中扣除这些区间；
 *   4. 最大增益为 0（无任何字体能再缩小缺口）时提前结束；
 *   5. 达到最多使用字体数（maxFonts）时结束。
 *
 * 全程仅做区间合并 / 交集 / 扣除运算，按区间长度计数，不逐码位展开
 * （可安全处理数万码位的 CJK / 全平面范围）。
 *
 * 注意：结论只基于字体 cmap 表的「声明」，不验证字形能否真实渲染
 * （.notdef 豆腐块 / 空白 / 回退需由覆盖检测页的 Canvas 引擎判定）。
 *
 * @module shared/font-planner
 */
import { mergeSegments, intersectSegments, subtractSegments } from './ranges.js';

/** 单区间码位计数（闭区间） */
export function segmentLength([lo, hi]) {
  return hi - lo + 1;
}

/** 合并区间总码位数 */
export function countSegments(segments) {
  return segments.reduce((n, seg) => n + segmentLength(seg), 0);
}

/**
 * 规范化字体 cmap 区间：仅接受合法的 [lo, hi] 数值对，合并并按升序排列。
 * 返回 null 表示该字体没有可用的 cmap 数据（解析失败 / 空 cmap）。
 */
function normalizeCmap(font) {
  const raw = font && Array.isArray(font.cmapRanges) ? font.cmapRanges : null;
  if (!raw) return null;
  const valid = [];
  for (const seg of raw) {
    if (!Array.isArray(seg) || seg.length < 2) continue;
    const lo = Number(seg[0]);
    const hi = Number(seg[1]);
    if (Number.isInteger(lo) && Number.isInteger(hi) && lo >= 0 && hi >= lo) {
      valid.push([lo, hi]);
    }
  }
  if (!valid.length) return null;
  return mergeSegments(valid);
}

/**
 * 执行贪心字体搭配规划。
 *
 * @param {number[][]} targetSegments 目标范围（parseRangeSpec 输出的 segments）
 * @param {Array<{id:number, fullName?:string, familyName?:string,
 *                subfamilyName?:string, format?:string,
 *                cmapRanges?:number[][], cmapTotal?:number}>} fonts
 *   候选字体（复用 GET /api/fonts 的列表项即可；顺序无所谓）
 * @param {number} maxFonts 最多使用的字体数（>=1 的整数）
 * @returns {{
 *   total:number, covered:number, remaining:number, rate:number,
 *   remainingSegments:number[][],
 *   rounds:Array<{order:number, fontId:number, fontName:string, format:string|null,
 *     gain:number, gainSegments:number[][], cumulative:number}>,
 *   eligible:number,
 *   stopReason:'full'|'no-gain'|'max-fonts'|'no-fonts'
 * }}
 * @throws maxFonts 不是 >=1 的整数
 */
export function planFonts(targetSegments, fonts, maxFonts) {
  if (!Number.isInteger(maxFonts) || maxFonts < 1) {
    throw new Error('最多使用字体数必须是不小于 1 的整数');
  }

  const total = countSegments(targetSegments);
  const initial = mergeSegments((targetSegments || []).map(([lo, hi]) => [lo, hi]));

  // 跳过没有可用 cmap 数据的字体；按 ID 升序，保证并列时取 ID 最小者
  const candidates = (Array.isArray(fonts) ? fonts : [])
    .map((f) => ({ font: f, cmap: normalizeCmap(f) }))
    .filter((e) => e.cmap)
    .sort((a, b) => a.font.id - b.font.id);

  const rounds = [];
  let remaining = initial;
  let covered = 0;

  if (!candidates.length) {
    return {
      total,
      covered: 0,
      remaining: total,
      rate: 0,
      remainingSegments: initial,
      rounds,
      eligible: 0,
      stopReason: 'no-fonts',
    };
  }

  let stopReason;
  while (rounds.length < maxFonts && remaining.length > 0) {
    let best = null;
    // candidates 已按字体 ID 升序，且仅在增益「严格更大」时替换，
    // 因此并列时自然保留 ID 最小的字体
    for (const entry of candidates) {
      const gainSegments = intersectSegments(entry.cmap, remaining);
      const gain = countSegments(gainSegments);
      if (best === null || gain > best.gain) {
        best = { entry, gain, gainSegments };
      }
    }

    if (!best || best.gain === 0) {
      stopReason = 'no-gain';
      break;
    }

    const f = best.entry.font;
    remaining = subtractSegments(remaining, best.gainSegments);
    covered += best.gain;
    rounds.push({
      order: rounds.length + 1,
      fontId: f.id,
      fontName: f.fullName || f.familyName || `字体 #${f.id}`,
      format: f.format ?? null,
      gain: best.gain,
      gainSegments: best.gainSegments,
      cumulative: covered,
    });

    if (remaining.length === 0) stopReason = 'full';
  }

  if (stopReason === undefined) {
    stopReason = remaining.length === 0 ? 'full' : 'max-fonts';
  }

  return {
    total,
    covered,
    remaining: total - covered,
    rate: total ? Number(((covered / total) * 100).toFixed(2)) : 0,
    remainingSegments: remaining,
    rounds,
    eligible: candidates.length,
    stopReason,
  };
}
