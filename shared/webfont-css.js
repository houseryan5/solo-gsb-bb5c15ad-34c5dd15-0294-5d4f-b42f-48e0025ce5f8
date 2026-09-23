/**
 * 网页字体 CSS 生成（前端浏览器与后端 Node 共用的纯 ESM 模块）。
 *
 * 输入字体搭配规划（shared/font-planner.js）的入选轮次结果，为每个入选字体
 * 输出一条「同一字体族」的 @font-face 规则：
 *   - src 指向本站既有的字体文件接口：/api/fonts/:id/file；
 *   - unicode-range 只包含该轮「首次新增覆盖」的码位区间（round.gainSegments）；
 *   - 各轮 gainSegments 由规划算法保证互不交叠，本模块在生成前再次校验，
 *     一旦发现交叠码位会被多条规则重复声明即抛错；
 *   - 规划未覆盖的区间（plan.remainingSegments）不在输入内，绝不会写入 CSS。
 *
 * 注意：unicode-range 仅依据字体 cmap 表的「声明」切分，不验证真实渲染；
 * src 地址依赖生成时所在站点，字体被删除 / 重新上传（ID 变化）后规则失效，
 * 必须重新规划才能生成新规则。
 *
 * @module shared/webfont-css
 */
import { intersectSegments } from './ranges.js';
import { countSegments } from './font-planner.js';

/** 容器格式 → CSS format() 提示；otf/ttc 轮廓类型不明，留空交由浏览器嗅探 */
const FORMAT_HINTS = {
  ttf: 'truetype',
  woff: 'woff',
  woff2: 'woff2',
};

/** 码位 → CSS unicode-range 用十六进制（BMP 至少 4 位，增补平面自然为 5-6 位） */
export function cssHex(cp) {
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
}

/** 单区间 → unicode-range 片段（单点只写一个码位） */
function rangeToken([lo, hi]) {
  return lo === hi ? cssHex(lo) : `${cssHex(lo)}-${cssHex(hi)}`;
}

/**
 * 区间集合 → CSS unicode-range 值（不含属性名与分号）。
 * 每行最多 perLine 段，续行缩进四格，便于在 <pre> 中阅读。
 */
export function formatUnicodeRanges(segments, perLine = 6) {
  const tokens = segments.map(rangeToken);
  const lines = [];
  for (let i = 0; i < tokens.length; i += perLine) {
    lines.push(tokens.slice(i, i + perLine).join(', '));
  }
  return lines.join(',\n    ');
}

/** 规范化区间：只接受合法 [lo, hi] 整数对 */
function normalizeSegments(raw, label) {
  if (!Array.isArray(raw)) throw new Error(`${label} 的区间数据不是数组`);
  const out = [];
  for (const seg of raw) {
    if (!Array.isArray(seg) || seg.length < 2) {
      throw new Error(`${label} 存在非法区间`);
    }
    const lo = Number(seg[0]);
    const hi = Number(seg[1]);
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi < lo) {
      throw new Error(`${label} 存在非法区间：${JSON.stringify(seg)}`);
    }
    out.push([lo, hi]);
  }
  return out;
}

/** 清理 CSS 块注释内容（避免注释嵌套提前闭合） */
function sanitizeComment(text) {
  return String(text ?? '')
    .replace(/\*\//g, '*／')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/** 字体族名规范化并用双引号包裹（转义反斜杠 / 双引号 / 换行） */
export function quoteFontFamily(family) {
  const name = String(family ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim() || 'FCB Pairing';
  const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * 依据规划轮次生成 @font-face CSS 文本。
 *
 * @param {Array<{order?:number, fontId:number, fontName?:string, format?:string|null,
 *                gainSegments:number[][]}>} rounds planFonts 返回的 rounds
 * @param {{family?:string, baseUrl?:string, generatedAt?:string}} [opts]
 *   family：所有规则共用的字体族名（默认 "FCB Pairing"）；
 *   baseUrl：站点源（如 location.origin），拼接 /api/fonts/:id/file；
 *            传空串则输出根相对地址；
 *   generatedAt：规划生成时间（ISO 字符串），写入头注释。
 * @returns {string} CSS 文本（无入选字体时只含说明注释）
 * @throws 任一轮区间非法，或不同轮次的区间出现交叠码位
 */
export function buildWebfontCss(rounds, opts = {}) {
  const list = Array.isArray(rounds) ? rounds : [];
  const family = quoteFontFamily(opts.family);
  const base = String(opts.baseUrl ?? '').replace(/\/+$/, '');
  const generatedAt = opts.generatedAt ? String(opts.generatedAt) : null;

  const lines = [
    '/*',
    ' * font-coverage-bench · 字体搭配规划生成的网页字体 CSS',
    ...(generatedAt ? [` * 生成时间：${generatedAt}`] : []),
    ` * 字体族名：${family}（所有 @font-face 共用同一字体族，浏览器按 unicode-range 自动分片）`,
    ' *',
    ' * 依赖与限制：',
    ' * 1. src 指向本站字体文件接口 <源>/api/fonts/:id/file；',
    ' *    站点不可访问 / 反向代理迁移 / 跨站引用时需自行改写地址。',
    ' * 2. unicode-range 仅依据各字体 cmap 表声明切分，未做真实渲染验证；',
    ' *    cmap 声明有码位不代表字形一定可正常显示（豆腐块 / 空白 / 回退）。',
    ' * 3. 每条规则只声明该轮「首次新增覆盖」的码位，跨规则互不交叠；',
    ' *    规划未覆盖的码位不会出现在本文件中。',
    ' * 4. 字体被删除或重新上传（ID 变化）后规则失效，请在站内重新规划后再生成。',
    ' */',
    '',
  ];

  const claimed = []; // 已被先前规则声明的区间
  list.forEach((round, idx) => {
    const order = Number.isInteger(round.order) ? round.order : idx + 1;
    const fontId = Number(round.fontId);
    if (!Number.isInteger(fontId) || fontId <= 0) {
      throw new Error(`第 ${order} 轮缺少合法字体 ID`);
    }
    const segs = normalizeSegments(round.gainSegments, `第 ${order} 轮（字体 #${fontId}）`);
    if (!segs.length) {
      throw new Error(`第 ${order} 轮（字体 #${fontId}）没有可声明的新增区间`);
    }

    // 交叠码位不可被多条规则重复声明：与先前每一轮做区间交集检查
    for (const prev of claimed) {
      const overlap = intersectSegments(prev.segs, segs);
      if (overlap.length) {
        throw new Error(
          `码位交叠：字体 #${prev.fontId} 与字体 #${fontId} 的 unicode-range 存在重复声明`,
        );
      }
    }
    claimed.push({ fontId, segs });

    const url = `${base}/api/fonts/${fontId}/file`;
    const hint = FORMAT_HINTS[round.format];
    const src = hint ? `url("${url}") format("${hint}")` : `url("${url}")`;
    const name = round.fontName ? sanitizeComment(round.fontName) : '';
    const gain = countSegments(segs);

    lines.push(
      `/* 第 ${order} 轮 · 字体 #${fontId}${name ? ` · ${name}` : ''} · ` +
        `新增 ${gain} 码位${hint ? '' : ' · 容器轮廓不明，未标注 format()'} */`,
      '@font-face {',
      `  font-family: ${family};`,
      `  src: ${src};`,
      '  font-display: swap;',
      `  unicode-range: ${formatUnicodeRanges(segs)};`,
      '}',
      '',
    );
  });

  return lines.join('\n');
}
