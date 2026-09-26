/**
 * 网页字体 CSS（@font-face）生成（前端浏览器与后端 Node 共用的纯 ESM 模块）。
 *
 * 输入字体搭配规划（shared/font-planner.js 的 rounds：每轮一个入选字体及其
 * 「首次新增覆盖」区间），为每个入选字体输出同一字体族（font-family 相同）
 * 的若干条 @font-face 规则：
 *   - 该轮每个新增区间一条规则，同一字体的规则共用同一 font-family，
 *     浏览器按 unicode-range 自动命中对应规则；
 *   - src 指向本站字体文件接口 /api/fonts/<id>/file；
 *   - unicode-range 仅含该轮分配给该字体的码位；
 *   - 各规则的 unicode-range 互不交叠（同一码位不会被多条规则重复声明）：
 *     规划结果本身已保证不交叠，这里仍按轮次顺序扣除已声明区间作为防御；
 *   - 未覆盖区间（remainingSegments）不会写入 CSS。
 *
 * 注意：规则仅依据各字体 cmap 表「声明」的码位区间划分，
 *       不代表字形一定能真实渲染（豆腐块 / 空白 / 回退需真实渲染检测复核）。
 *
 * @module shared/webfont-css
 */
import { mergeSegments, subtractSegments } from './ranges.js';

/** 本站字体文件接口（对应 server/routes/fonts.js 的 GET /api/fonts/:id/file） */
export function fontFileUrl(fontId) {
  return `/api/fonts/${fontId}/file`;
}

/** 字体容器格式 → CSS format() 提示；无法确定时返回 null（交给浏览器嗅探） */
const FORMAT_HINTS = {
  ttf: 'truetype',
  otf: 'opentype',
  woff: 'woff',
  woff2: 'woff2',
};

export function formatHint(format) {
  return FORMAT_HINTS[String(format ?? '').toLowerCase()] ?? null;
}

function hex(cp) {
  return cp.toString(16).toUpperCase().padStart(4, '0');
}

/** 单段闭区间 → CSS unicode-range 片段（U+0041 或 U+0041-0048） */
export function unicodeRangeSegment([lo, hi]) {
  return lo === hi ? `U+${hex(lo)}` : `U+${hex(lo)}-${hex(hi)}`;
}

/** 区间数组 → CSS unicode-range 描述符值（逗号分隔） */
export function unicodeRangeValue(segments) {
  return segments.map(unicodeRangeSegment).join(', ');
}

/** 清洗字体名为可安全放入引号的 CSS font-family 名（同一字体的各条规则共用） */
export function cssFamilyName(fontId, fontName) {
  const clean = String(fontName ?? '')
    .replace(/["'\\\r\n{}<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
  return `FCB Plan #${fontId}${clean ? ` ${clean}` : ''}`;
}

/** 清洗要写入 CSS 注释的文本，拆开注释定界符防止提前闭合注释 */
function cssComment(text) {
  return String(text ?? '').replace(/\*\//g, '* /').replace(/\/\*/g, '/ *');
}

/**
 * 由搭配规划生成 @font-face CSS。
 *
 * @param {{rounds?:Array<{order:number, fontId:number, fontName:string,
 *          format:string|null, gain:number, gainSegments:number[][]}>,
 *          generatedAt?:string,
 *          request?:{rangesText?:string, count?:number}}} plan
 *        规划结果或规划报告文档（只需含 rounds）
 * @returns {{css:string, ruleCount:number,
 *            families:Array<{order:number, fontId:number, fontName:string,
 *                            family:string, src:string, segments:number[][],
 *                            ruleCount:number}>}}
 */
export function planToWebfont(plan) {
  const rounds = Array.isArray(plan?.rounds) ? plan.rounds : [];
  const families = [];
  const blocks = [];
  let claimed = [];
  let ruleCount = 0;

  for (const round of rounds) {
    const fontId = Number(round?.fontId);
    if (!Number.isInteger(fontId)) continue;

    // 仅取该轮首次新增覆盖区间；再扣除已被先前规则声明的码位，
    // 保证任何码位都不会被多条规则重复声明
    const raw = Array.isArray(round.gainSegments) ? round.gainSegments : [];
    const own = subtractSegments(mergeSegments(raw.map(([lo, hi]) => [lo, hi])), claimed);
    if (!own.length) continue;
    claimed = mergeSegments([...claimed, ...own]);

    const fontName = round.fontName || `字体 #${fontId}`;
    const family = cssFamilyName(fontId, fontName);
    const url = fontFileUrl(fontId);
    const hint = formatHint(round.format);
    const src = hint ? `url("${url}") format("${hint}")` : `url("${url}")`;
    const gain = own.reduce((n, [lo, hi]) => n + hi - lo + 1, 0);

    const rules = own.map(
      (seg) =>
        `@font-face {\n` +
        `  font-family: "${family}";\n` +
        `  src: ${src};\n` +
        `  unicode-range: ${unicodeRangeSegment(seg)};\n` +
        `}`,
    );
    ruleCount += rules.length;
    families.push({
      order: round.order ?? families.length + 1,
      fontId,
      fontName,
      family,
      src: url,
      segments: own,
      ruleCount: rules.length,
    });
    blocks.push(
      `/* 第 ${round.order ?? families.length} 轮 · 字体 #${fontId} ${cssComment(fontName)}` +
      ` · 该轮新增 ${gain} 码位 */\n${rules.join('\n\n')}`,
    );
  }

  const header = [
    '/* ==========================================================================',
    ' * 字体搭配规划 · 网页字体 @font-face 规则（字体覆盖率实验台生成）',
  ];
  if (plan?.generatedAt) header.push(` * 生成时间：${cssComment(plan.generatedAt)}`);
  if (plan?.request?.rangesText) {
    const count = Number.isInteger(plan.request.count) ? `（共 ${plan.request.count} 码位）` : '';
    header.push(` * 目标范围：${cssComment(plan.request.rangesText)}${count}`);
  }
  header.push(
    ' *',
    ' * 注意：',
    ' *   1. src 指向本站字体文件接口 /api/fonts/<id>/file，仅在能通过该地址',
    ' *      访问字体文件的环境（如同源部署本站）中可用；',
    ' *   2. unicode-range 仅依据各字体 cmap 表声明的码位区间划分，',
    ' *      不代表字形一定能真实渲染；',
    ' *   3. 各规则的 unicode-range 互不交叠，未覆盖区间未写入本文件。',
    ' * ========================================================================== */',
  );

  const body = blocks.length
    ? blocks.join('\n\n')
    : '/* 没有字体入选：未生成任何 @font-face 规则。 */';
  return { css: `${header.join('\n')}\n\n${body}\n`, ruleCount, families };
}
