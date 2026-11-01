// 目录合并与「实测优先」的回归测试。
//
// 这一组用例守护的是**根因**，不是某个模型：
//   ① 合并按字段进行，精选目录不得整条吞掉扩展目录的实测接口；
//   ② 同一条目的实测接口不与 kind 合成接口叠加；
//   ③ 同名异义字段（holes: 数字 vs 坐标数组）不互相覆盖；
//   ④ size 换轴时实测坐标要换轴，外形有分歧时不生成连接器；
//   ⑤ 两套来源的同名接口冲突必须能报出来，不能静默覆盖。
//
// 背景：`{...ext, ...curated}` 曾被复制到 10 处（CLI / 查看器 / tools / 测试）。它是条目级替换，
// 精选目录定义过的件就丢掉官方 .dat 实测出来的 bars/clips/holes —— 于是接口退回猜测位置，
// 表现为「看图能装、实装不上」。这类错误此前没有任何测试能发现。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  mergeCatalogParts, catalogInterfaceConflicts, partConnectors,
  MEASURED_CONNECTOR_FIELDS, INHERITED_FIELDS,
} from '../src/core/core.js';

const ex = JSON.parse(fs.readFileSync('catalog/parts-ldraw.json', 'utf8')).parts;
const cu = JSON.parse(fs.readFileSync('catalog/parts.json', 'utf8')).parts;
const merged = mergeCatalogParts(ex, cu);

const connOf = (id) => partConnectors({ id: 'x', part: id, at: [0, 0, 0], rot: 0, up: '+y' }, merged[id]);

test('合并按字段：精选目录没有写连接器数组时，继承扩展目录的实测接口', () => {
  // 63868：精选目录只有 kind:'clip'（合成语义），扩展目录有官方 clip6 图元实测的 clips
  assert.equal(cu['63868'].clips, undefined, '前提：精选目录确实没写 clips');
  assert.ok(Array.isArray(merged['63868'].clips) && merged['63868'].clips.length, '合并后必须继承实测 clips');

  // 48336：精选目录只有 kind:'barplate'，扩展目录有官方几何实测的 bars。
  // 2026-11 修正：把柄是**杆段**（4-4cylo，轴 x，跨度 ±0.7 格）而非两端支撑环两个点，
  // 因此实测条目是 1 条带半长的杆（第 5 位 = 0.7），不是 2 个点。
  assert.ok(Array.isArray(merged['48336'].bars) && merged['48336'].bars.length === 1, '48336 应继承 1 根实测杆段');
  assert.equal(merged['48336'].bars[0][4], 0.7, '杆段半长应为 0.7 格（官方 ±14 LDU）');
});

test('精选目录显式给出的接口优先于扩展目录（人手核对 > 自动提取）', () => {
  // 构造一个精选目录显式写 clips 的件，确认不被扩展目录覆盖
  const e = { p: { size: [1, 1], h: 1, clips: [[0, 0, 1, '+z']] } };
  const c = { p: { size: [1, 1], h: 1, kind: 'clip', clips: [[0, 0, 0.5, '+z']] } };
  assert.deepEqual(mergeCatalogParts(e, c).p.clips, [[0, 0, 0.5, '+z']], '精选目录的显式坐标应胜出');
});

test('实测优先：已有实测 bars 时不再按 kind 合成（避免接口叠加）', () => {
  const d = merged['48336'];
  assert.equal(d.kind, 'barplate', '前提：该件仍走 barplate 的合成路径');
  assert.ok(Array.isArray(d.bars) && d.bars.length, '前提：已继承实测 bars');

  const bars = connOf('48336').studs.filter((s) => s.kind === 'bar');
  assert.equal(bars.length, 1, '48336 只能有实测的 1 根杆段，不得再叠加合成的把柄');
  assert.ok(bars.every((b) => b.label.startsWith('extbar@')), '剩下的必须全部来自实测提取，不含合成把柄');
  assert.equal(bars[0].span, 0.7, '连接器必须带沿轴半长（杆段语义）');
});

test('同名异义字段：holes 的「数量」与「坐标」不互相覆盖', () => {
  // 3700 精选目录写 holes: 1（表示 1 个销孔），扩展目录写的是 2 个孔口坐标
  assert.equal(typeof cu['3700'].holes, 'number', '前提：精选目录用数字表示孔数');
  const m = merged['3700'];
  assert.equal(m.holes, 1, '数字语义保留为数量');
  assert.ok(Array.isArray(m.holesMeasured) && m.holesMeasured.length === 2, '坐标另存为 holesMeasured');
  // 连接器按坐标生成（2 个孔），不是按「数量 1」编造 1 个孔
  const holes = connOf('3700').receptors.filter((r) => r.kind === 'hole');
  assert.equal(holes.length, 2, '销孔应由实测坐标生成 2 个，而不是按数量声明生成 1 个');
});

test('size 换轴：实测坐标绕竖直轴对齐后再使用', () => {
  // 63868 实测 size [2,1] → 精选记 [1,2]；实测夹口在端头外侧，换轴后仍须落在端头
  assert.equal(merged['63868'].clipsFrame, 'rotated', '前提：该件 size 的 x/z 互换');
  const d = merged['63868'];
  // 局部坐标换轴：原 (1.5, ·, 0) → (0, ·, 1.5)；端头方向的绝对值必须保持 1.5
  const clip = partConnectors({ id: 'x', part: '63868', at: [0, 0, 0], rot: 0, up: '+y' }, d).receptors.filter((r) => r.kind === 'clip');
  assert.equal(clip.length, 1);
  assert.ok(Math.abs(clip[0].pos[2] - d.size[1] / 2) > 1.4, `夹口应落在 size[1] 方向的端头外侧，实际 z=${clip[0].pos[2]}`);
});

test('外形有分歧（mismatch）时不生成实测连接器，宁可报装不上', () => {
  // 4081b：精选 [1,1] vs 实测 [1,2]，两套目录对零件外形本身有分歧
  const e = { q: { size: [1, 2], h: 1, bars: [[0, 0.4, 0.5, 'z']] } };
  const c = { q: { size: [1, 1], h: 1, kind: 'barplate' } };
  const m = mergeCatalogParts(e, c);
  assert.equal(m.q.barsFrame, 'mismatch');
  const bars = partConnectors({ id: 'x', part: 'q', at: [0, 0, 0], rot: 0 }, m.q).studs.filter((s) => s.kind === 'bar');
  assert.equal(bars.length, 0, '坐标没有可信基准时不得生成连接器');
});

test('近似几何（boxes）不从扩展目录继承，避免把推断当实测', () => {
  // 3039 的 boxes/studCells 是生成器按品类推断的近似值，精选目录刻意不采用
  assert.equal(cu['3039'].boxes, undefined);
  assert.equal(merged['3039'].boxes, undefined, 'boxes 属推断字段，不得继承');
  // 但实测几何字段（studCells）应继承
  assert.ok(INHERITED_FIELDS.includes('studCells'));
});

test('合并覆盖全部件，且不丢件', () => {
  for (const id of new Set([...Object.keys(ex), ...Object.keys(cu)])) {
    assert.ok(merged[id], `合并结果缺件 ${id}`);
  }
  // 精选件的身份字段以精选目录为准
  for (const id of Object.keys(cu)) {
    assert.equal(merged[id].kind, cu[id].kind, `${id} 的 kind 应取自精选目录`);
    assert.deepEqual(merged[id].size, cu[id].size, `${id} 的 size 应取自精选目录`);
  }
});

test('接口冲突可被报出，不静默覆盖', () => {
  const rows = catalogInterfaceConflicts(ex, cu);
  assert.ok(Array.isArray(rows), '应返回冲突列表');
  // 存在的冲突类型必须是已知的两类之一
  for (const r of rows) assert.ok(['type-collision', 'value-conflict'].includes(r.kind), `未知冲突类型 ${r.kind}`);
  // holes 数字 vs 数组这类同名异义必须被识别出来
  assert.ok(rows.some((r) => r.kind === 'type-collision' && r.field === 'holes'), 'holes 的类型冲突应被列出');
});

test('字段清单自洽：可继承字段与实测连接器字段不重叠', () => {
  for (const f of MEASURED_CONNECTOR_FIELDS) {
    assert.ok(!INHERITED_FIELDS.includes(f), `${f} 不应同时出现在两张清单里`);
  }
});

test('唯一入口：源码里不得再有手写的条目级目录合并', () => {
  // 这是防止「修复只改了一处」的硬约束。历史上 { ...ext, ...curated } 被散布到 10 处，
  // 每漏一处，那个入口就退回合成的接口位置——CLI、查看器、GT 抽取、几何对账互相打架。
  // 现在只允许在 mergeCatalogParts 内部出现，其它地方一律调用它。
  const roots = ['src', 'cli', 'tools', 'test'];
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (!['node_modules', 'dist', 'out'].includes(e.name)) walk(full); continue; }
      if (!/\.(mjs|js)$/.test(e.name)) continue;
      const src = fs.readFileSync(full, 'utf8');
      src.split('\n').forEach((line, i) => {
        const t = line.trim();
        // 跳过注释与文档行：只校验真正会执行的代码
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
        const code = line.replace(/\/\/.*$/, '');
        if (!code.trim()) return;
        // 双侧对象展开，且至少一侧是目录变量（ext/curated/ex/cu）——只抓目录合并，
        // 避免误报 `{...p, ...pend}`、`{...uniform, ...diag}` 这类无关合并
        const m = code.match(/\{\s*\.\.\.(\w+(?:\.parts)?)\s*,\s*\.\.\.(\w+(?:\.parts)?)\s*\}/);
        if (m) {
          const names = [m[1], m[2]].map((s) => s.split('.')[0]);
          if (names.some((n) => /^(ext|curated|ex|cu)$/.test(n))) {
            offenders.push(`${full}:${i + 1}  ${line.trim().slice(0, 90)}`);
          }
        }
      });
      // 同时拦直接对 parts-ldraw.json + parts.json 做对象展开（含跨行写法）
      if (/\.\.\.[^\n;{}]*parts-ldraw\.json[\s\S]{0,200}?\.\.\.[^\n;{}]*parts\.json/.test(src)) {
        offenders.push(`${full}  直接展开 parts-ldraw.json + parts.json`);
      }
    }
  };
  for (const r of roots) walk(r);
  // core.js 的 mergeCatalogParts 内部是 `{ ...c }` 单侧展开，不匹配上面的双侧模式，无需豁免
  assert.deepEqual(offenders, [], `这些位置仍在手写目录合并，应改用 mergeCatalogParts：\n${offenders.join('\n')}`);
});

test('assets-v1 索引编译器 readRawCatalog 与 mergeCatalogParts 连接器口径一致', async () => {
  const { readRawCatalog } = await import('../src/core/assets-v1/index.js');
  const raw = readRawCatalog(process.cwd());
  for (const id of ['48336', '63868', '60478', '3700']) {
    const a = raw.merged[id]?.def, b = merged[id];
    for (const f of MEASURED_CONNECTOR_FIELDS) {
      assert.deepEqual(a[f], b[f], `assets-v1 readRawCatalog 中 ${id}.${f} 必须与 mergeCatalogParts 一致`);
    }
  }
});

test('GT 抽取工具读到的是同一个合并目录（训练数据与校验口径同源）', async () => {
  // tools/lib/snap-gt.mjs 的 loadCatalog 曾被漏在统一之外（仍用条目级替换），
  // 于是合成数据里的「正确扣合」与 CLI 的扣合判定是两套物理。
  const { loadCatalog } = await import('../tools/lib/snap-gt.mjs');
  const viaTool = loadCatalog(process.cwd());
  for (const id of ['48336', '63868', '60478', '3700']) {
    const a = viaTool.parts[id], b = merged[id];
    assert.deepEqual(a.bars, b.bars, `${id} 的 bars 两处必须一致`);
    assert.deepEqual(a.clips, b.clips, `${id} 的 clips 两处必须一致`);
    assert.deepEqual(a.size, b.size, `${id} 的 size 两处必须一致`);
  }
});
