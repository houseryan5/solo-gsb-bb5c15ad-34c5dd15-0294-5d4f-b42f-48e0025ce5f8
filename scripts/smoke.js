/**
 * 冒烟测试：范围解析、脚本分类、字体 cmap 解析。
 * 用法：node scripts/smoke.js
 */
import assert from 'node:assert/strict';
import { parseRangeSpec, formatSegments, subtractSegments, intersectSegments, mergeSegments, PRESETS } from '../shared/ranges.js';
import { scriptOf } from '../shared/scripts.js';
import { compressCodepoints, sniffFormat } from '../server/font-parser.js';
import { planFonts, countSegments } from '../shared/font-planner.js';
import {
  planToWebfont, fontFileUrl, cssFamilyName, unicodeRangeValue, formatHint,
} from '../shared/webfont-css.js';

// 范围解析
assert.deepEqual(parseRangeSpec('U+41').segments, [[0x41, 0x41]]);
assert.deepEqual(parseRangeSpec('U+41-U+43').segments, [[0x41, 0x43]]);
assert.equal(parseRangeSpec('basic-latin').count, 96);
assert.deepEqual(parseRangeSpec('4E2D').segments, [[0x4e2d, 0x4e2d]]);
// 裸字母按字面量（相邻码位会被合并）
assert.deepEqual(parseRangeSpec('ABC').segments, [[0x41, 0x43]]);
assert.deepEqual(parseRangeSpec('A C').segments, [[0x20, 0x20], [0x41, 0x41], [0x43, 0x43]]);
// 区间合并
assert.deepEqual(parseRangeSpec('U+41-U+43, U+42-U+45').segments, [[0x41, 0x45]]);
// 引号字面量
assert.equal(parseRangeSpec('"AB"').count, 2);
// 排除项：码位区间从预设中扣除（basic-latin 0x20-0x7F 扣掉 A-Z 0x41-0x5A）
assert.deepEqual(
  parseRangeSpec('basic-latin,!U+0041-U+005A').segments,
  [[0x20, 0x40], [0x5b, 0x7f]],
);
assert.equal(parseRangeSpec('basic-latin,!U+0041-U+005A').count, 96 - 26);
// 排除项可与预设、区间、字面量混用
assert.deepEqual(parseRangeSpec('U+41-U+5A, !ABC').segments, [[0x44, 0x5a]]);
assert.deepEqual(parseRangeSpec('basic-latin,!ascii-printable').segments, [[0x7f, 0x7f]]);
assert.deepEqual(parseRangeSpec('U+41-U+45,!"B"').segments, [[0x41, 0x41], [0x43, 0x45]]);
// 全角分隔符与全角 ！ 排除标记
assert.deepEqual(parseRangeSpec('U+41-U+43，！U+42').segments, [[0x41, 0x41], [0x43, 0x43]]);
// 排除后合并去重、保持升序（0x4F 与 0x50 相邻，正向片段会先合并）
{
  const { segments, exclusions } = parseRangeSpec('U+50-U+5F, U+41-U+4F, !U+45');
  assert.deepEqual(exclusions, [[0x45, 0x45]]);
  assert.deepEqual(segments, [[0x41, 0x44], [0x46, 0x5f]]);
  assert.equal(parseRangeSpec('U+50-U+5F, U+41-U+4F, !U+45').count, 30);
}
// 排除命中数以 warning 形式反馈
assert.ok(parseRangeSpec('U+41-U+43,!U+42').warnings.some((w) => w.includes('扣除 1')));
assert.ok(parseRangeSpec('U+41-U+43,!U+60').warnings.some((w) => w.includes('未命中')));
// subtractSegments 直接验证：部分相交 / 完全包含 / 多区间
assert.deepEqual(
  subtractSegments([[0x41, 0x50], [0x60, 0x70]], [[0x45, 0x65]]),
  [[0x41, 0x44], [0x66, 0x70]],
);
assert.deepEqual(subtractSegments([[0x41, 0x41]], [[0x40, 0x42]]), []);
// 只有排除项 / 空排除 / 排除清空全部 → 明确报错
assert.throws(() => parseRangeSpec('!U+41'), /没有要检测的正向范围/);
assert.throws(() => parseRangeSpec('basic-latin, !'), /缺少要扣除的范围/);
assert.throws(() => parseRangeSpec('U+41, !U+41'), /没有剩余可检测的码位/);
// 越界与空输入
assert.throws(() => parseRangeSpec('U+110000'));
assert.throws(() => parseRangeSpec(''));
// 所有预设名可解析且非空（除占位空预设）
for (const [name, segs] of Object.entries(PRESETS)) {
  if (segs.length) assert.ok(parseRangeSpec(name).count > 0, name);
}

// 脚本分类
assert.equal(scriptOf(0x41).id, 'Latn');
assert.equal(scriptOf(0x4e2d).id, 'Hani');
assert.equal(scriptOf(0x3042).id, 'Hira');
assert.equal(scriptOf(0x0627).id, 'Arab');
assert.equal(scriptOf(0xffff).id, 'Zzzz');

// cmap 压缩与魔数
assert.deepEqual(compressCodepoints([1, 2, 3, 5, 6, 8]), [[1, 3], [5, 6], [8, 8]]);
assert.equal(sniffFormat(Buffer.from([0x00, 0x01, 0x00, 0x00])), 'ttf');
assert.equal(sniffFormat(Buffer.from('wOFFxxxx')), 'woff');
assert.equal(sniffFormat(Buffer.from('wOF2xxxx')), 'woff2');
assert.equal(sniffFormat(Buffer.from('ttcfxxxx')), 'otf/ttc');

// intersectSegments：区间交集（不逐码位展开）
assert.deepEqual(
  intersectSegments([[0x41, 0x50], [0x60, 0x70]], [[0x45, 0x65]]),
  [[0x45, 0x50], [0x60, 0x65]],
);
assert.deepEqual(intersectSegments([[0x41, 0x45]], [[0x50, 0x55]]), []);
assert.deepEqual(
  intersectSegments([[0x10, 0x100]], [[0x20, 0x30], [0x80, 0x90]]),
  [[0x20, 0x30], [0x80, 0x90]],
);
// 端点相接
assert.deepEqual(intersectSegments([[0x41, 0x45]], [[0x45, 0x50]]), [[0x45, 0x45]]);
assert.deepEqual(
  intersectSegments([[0x41, 0x44]], [[0x45, 0x50]]),
  [],
);

// 字体搭配规划：贪心选字
{
  const target = [[0x41, 0x50]]; // 16 码位
  // F1 覆盖前半 8，F2 覆盖中段 8（与 F1 重叠 4），F3 覆盖尾部 4
  const F1 = { id: 1, fullName: 'F1', format: 'ttf', cmapRanges: [[0x41, 0x48]] };
  const F2 = { id: 2, fullName: 'F2', format: 'ttf', cmapRanges: [[0x45, 0x4c]] };
  const F3 = { id: 3, fullName: 'F3', format: 'ttf', cmapRanges: [[0x4d, 0x50]] };

  const plan = planFonts(target, [F3, F2, F1], 5);
  // 第 1 轮：F1、F2 均增益 8，按 ID 升序取 F1
  assert.equal(plan.rounds.length, 3);
  assert.deepEqual(plan.rounds.map((r) => r.fontId), [1, 2, 3]);
  assert.equal(plan.rounds[0].gain, 8);
  assert.deepEqual(plan.rounds[0].gainSegments, [[0x41, 0x48]]);
  // 第 2 轮：F1 已占 0x41-48，F2 只新增 0x49-4C（4 个，首次覆盖才计入）
  assert.equal(plan.rounds[1].gain, 4);
  assert.deepEqual(plan.rounds[1].gainSegments, [[0x49, 0x4c]]);
  // 第 3 轮：F3 补齐 0x4D-50
  assert.equal(plan.rounds[2].gain, 4);
  assert.deepEqual(plan.rounds[2].gainSegments, [[0x4d, 0x50]]);
  assert.equal(plan.covered, 16);
  assert.equal(plan.remaining, 0);
  assert.equal(plan.rate, 100);
  assert.deepEqual(plan.remainingSegments, []);
  assert.equal(plan.stopReason, 'full');
  // cumulative 单调递增
  assert.deepEqual(plan.rounds.map((r) => r.cumulative), [8, 12, 16]);

  // maxFonts 上限：只允许 1 个字体 → 停止原因为 max-fonts 且有剩余
  const capped = planFonts(target, [F1, F2, F3], 1);
  assert.equal(capped.rounds.length, 1);
  assert.equal(capped.rounds[0].fontId, 1);
  assert.equal(capped.stopReason, 'max-fonts');
  assert.equal(capped.remaining, 8);
  assert.deepEqual(capped.remainingSegments, [[0x49, 0x50]]);

  // 无增益提前结束：所有字体都只覆盖同一区段，第二轮无人能新增
  const noGain = planFonts(target, [F1, { id: 9, cmapRanges: [[0x41, 0x48]] }], 5);
  assert.equal(noGain.rounds.length, 1);
  assert.equal(noGain.rounds[0].fontId, 1);
  assert.equal(noGain.stopReason, 'no-gain');
  assert.equal(noGain.remaining, 8);

  // 并列时严格按字体 ID 升序：传入顺序乱序也不影响
  const tieA = { id: 7, cmapRanges: [[0x41, 0x48]] };
  const tieB = { id: 3, cmapRanges: [[0x41, 0x48]] };
  const tie = planFonts(target, [tieA, tieB], 2);
  assert.equal(tie.rounds[0].fontId, 3);
  assert.equal(tie.rounds.length, 1);
  assert.equal(tie.stopReason, 'no-gain');

  // 无 cmap / 空 cmap 的字体被跳过；没有任何合格字体 → no-fonts
  const broken = { id: 5, cmapRanges: null };
  const empty = { id: 6, cmapRanges: [] };
  assert.equal(planFonts(target, [broken, empty], 3).stopReason, 'no-fonts');
  assert.equal(planFonts(target, [F1, broken, empty], 3).eligible, 1);

  // 区间计数工具
  assert.equal(countSegments([[0x41, 0x45], [0x100, 0x100]]), 6);

  // maxFonts 非法值报错
  assert.throws(() => planFonts(target, [F1], 0), /不小于 1/);
  assert.throws(() => planFonts(target, [F1], 1.5), /不小于 1/);
}

// 网页字体 CSS（@font-face）生成
{
  /** 从 CSS 中解析全部 unicode-range 声明区间 */
  function declaredSegments(css) {
    return [...css.matchAll(/unicode-range:\s*([^;]+);/g)].flatMap((m) =>
      m[1].split(',').map((tok) => {
        const mm = tok.trim().match(/^U\+([0-9A-F]+)(?:-([0-9A-F]+))?$/i);
        assert.ok(mm, `无法解析 unicode-range 片段：${tok}`);
        return [parseInt(mm[1], 16), parseInt(mm[2] ?? mm[1], 16)];
      }));
  }
  /** 交叠码位不可被多条规则重复声明：合并后总数须等于各段之和 */
  function assertDisjoint(css) {
    const segs = declaredSegments(css);
    const sum = segs.reduce((n, [lo, hi]) => n + hi - lo + 1, 0);
    assert.equal(countSegments(mergeSegments(segs)), sum, 'unicode-range 存在交叠');
    return segs;
  }

  // 小工具
  assert.equal(fontFileUrl(7), '/api/fonts/7/file');
  assert.equal(unicodeRangeValue([[0x41, 0x41]]), 'U+0041');
  assert.equal(unicodeRangeValue([[0x41, 0x48], [0x50, 0x50]]), 'U+0041-0048, U+0050');
  assert.equal(cssFamilyName(3, 'A "B" \\ {C}'), 'FCB Plan #3 A B C');
  assert.equal(formatHint('ttf'), 'truetype');
  assert.equal(formatHint('woff2'), 'woff2');
  assert.equal(formatHint('otf/ttc'), null);

  // 基于规划结果生成：src 指向本站字体文件接口，unicode-range 仅含各轮分配码位
  const target = [[0x41, 0x50]]; // 16 码位
  const F1 = { id: 1, fullName: 'F1', format: 'ttf', cmapRanges: [[0x41, 0x48]] };
  const F2 = { id: 2, fullName: 'F2', format: 'woff2', cmapRanges: [[0x45, 0x4c]] };
  const F3 = { id: 3, fullName: 'F3', format: 'otf/ttc', cmapRanges: [[0x4d, 0x50]] };
  const plan = planFonts(target, [F1, F2, F3], 5);
  const wf = planToWebfont({
    rounds: plan.rounds,
    generatedAt: '2026-09-26T00:00:00.000Z',
    request: { rangesText: 'U+0041-0050', count: 16 },
  });
  assert.equal(wf.ruleCount, 3);
  assert.equal(wf.families.length, 3);
  // src 指向本站字体文件接口；format() 按容器映射，otf/ttc 不带 format()
  assert.ok(wf.css.includes('src: url("/api/fonts/1/file") format("truetype");'));
  assert.ok(wf.css.includes('src: url("/api/fonts/2/file") format("woff2");'));
  assert.ok(wf.css.includes('src: url("/api/fonts/3/file");'));
  // 每个入选字体使用同一字体族名
  assert.ok(wf.css.includes('font-family: "FCB Plan #1 F1";'));
  assert.ok(wf.css.includes('font-family: "FCB Plan #2 F2";'));
  // unicode-range 仅含该轮分配码位（F2 与 F1 交叠部分只归 F1）
  assert.ok(wf.css.includes('unicode-range: U+0041-0048;'));
  assert.ok(wf.css.includes('unicode-range: U+0049-004C;'));
  assert.ok(wf.css.includes('unicode-range: U+004D-0050;'));
  // 声明区间互不交叠，且恰好覆盖整个目标范围
  assert.deepEqual(mergeSegments(assertDisjoint(wf.css)), [[0x41, 0x50]]);

  // 未覆盖区间不得写入 CSS：限制 1 个字体时剩余 0x49-0x50 不得出现
  const capped = planToWebfont({ rounds: planFonts(target, [F1, F2, F3], 1).rounds });
  assert.deepEqual(mergeSegments(assertDisjoint(capped.css)), [[0x41, 0x48]]);
  assert.ok(!capped.css.includes('U+0049'));
  assert.ok(!capped.css.includes('U+0050'));

  // 同一字体多个新增区间 → 多条规则共用同一 font-family
  const multi = planFonts([[0x41, 0x43], [0x50, 0x52]], [
    { id: 4, fullName: 'Multi', format: 'ttf', cmapRanges: [[0x41, 0x43], [0x50, 0x52]] },
  ], 3);
  const wfMulti = planToWebfont({ rounds: multi.rounds });
  assert.equal(wfMulti.ruleCount, 2);
  assert.equal(wfMulti.css.split('font-family: "FCB Plan #4 Multi";').length - 1, 2);
  assert.ok(wfMulti.css.includes('unicode-range: U+0041-0043;'));
  assert.ok(wfMulti.css.includes('unicode-range: U+0050-0052;'));
  assertDisjoint(wfMulti.css);

  // 防御：即使输入的轮次区间交叠，输出也不会重复声明同一码位
  const overlap = planToWebfont({
    rounds: [
      { order: 1, fontId: 1, fontName: 'A', format: 'ttf', gainSegments: [[0x41, 0x48]] },
      { order: 2, fontId: 2, fontName: 'B', format: 'ttf', gainSegments: [[0x45, 0x4c]] },
    ],
  });
  assert.ok(overlap.css.includes('unicode-range: U+0049-004C;'));
  assert.ok(!overlap.css.includes('U+0045'));
  assertDisjoint(overlap.css);

  // 字体名中的引号被清洗、注释定界符被拆开（不破坏 CSS 结构）
  const evil = planToWebfont({
    rounds: [
      { order: 1, fontId: 9, fontName: 'X */ inject /* "Y"', format: 'ttf', gainSegments: [[0x41, 0x41]] },
    ],
  });
  assert.ok(evil.css.includes('X * / inject / * "Y"')); // 注释中的 */ 被拆开
  assert.ok(evil.css.includes('font-family: "FCB Plan #9 X */ inject /* Y";')); // 引号已清洗
  assertDisjoint(evil.css);

  // 无入选字体：不生成规则
  const none = planToWebfont({ rounds: [] });
  assert.equal(none.ruleCount, 0);
  assert.equal(none.families.length, 0);
  assert.ok(none.css.includes('未生成'));
  assert.equal(declaredSegments(none.css).length, 0);
}

console.log('smoke tests passed ✓');
void formatSegments;
