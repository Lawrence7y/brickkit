// 「缺陷登记」与「运动豁免」两处判据的负例回归。
//
// 这两处的共同风险是**看起来严格、实际宽松**：
//   ① 缺陷比对若只判「这个 key 在登记表里吗」，同一条错误重复出现也能通过；
//   ② 运动豁免若用「双方都属于轴类 + 宽松距离」，没真正扣上的零件对也会被豁免，
//      那里发生的真实碰撞就被整个放过。
// 本文件把两种松动都钉成失败用例。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compareDefects, defectKeys, KNOWN_DEFECTS } from './known-defects.mjs';
import { connectorPairMatches } from '../src/core/core.js';

// ---------------------------------------------------------------- ① 多重集计数

test('缺陷比对：同一条已登记错误重复出现一次，必须判失败', () => {
  // 构造一份与机甲登记完全一致的 errors，然后把其中一条复制一份
  const registered = [
    { code: 'mount-disconnected', parts: ['p56', 'p30'] },
    { code: 'mech-clearance', parts: ['p56', 'p57', 'p58', 'p59'] },
  ];
  const base = { errors: registered, warnings: [] };
  // 用真实登记集做基准：先确认这两条 key 的格式与真实登记一致
  const keys = defectKeys(base.errors);
  assert.equal(keys.length, 2);

  // 直接验证多重集逻辑：把同一个 key 计两次应当被识别为「多一条」
  const dup = { errors: [...registered, { ...registered[0] }], warnings: [] };
  const c = compareDefects('__multiplicity_probe__', dup);
  // 未登记模型 → 全部算 added；重复的那条应以 ×2 形式暴露
  const joined = c.added.join(' ');
  assert.ok(/×2/.test(joined) || c.added.length === 3,
    `重复条目应体现为计数超标，实际 added=${JSON.stringify(c.added)}`);
});

test('缺陷比对：登记集与实际集完全一致时通过（多重集口径不误报）', () => {
  // 从真实登记表派生实际集：登记成什么样，实际就报什么样，必须判通过。
  // 这里刻意不写死条目清单——机甲修复后背书集合会变（当前 errors 已清零），
  // 写死就等于把「已经修好的东西」又当成期望值固化回来。
  const registered = KNOWN_DEFECTS.mecha;
  const toEntries = (keys) => keys.map((k) => {
    const i = k.indexOf(':');
    return { code: k.slice(0, i), parts: k.slice(i + 1).split('+') };
  });
  const c = compareDefects('mecha', { errors: toEntries(registered.errors), warnings: toEntries(registered.warnings) });
  assert.deepEqual(c.added, []);
  assert.deepEqual(c.missing, []);
  assert.equal(c.ok, true);
});

test('缺陷比对：同一条已登记错误重复时，多重集口径必须报 added', () => {
  // 在完整登记基础上复制一条 mount-disconnected
  const errors = [
    { code: 'mount-disconnected', parts: ['p10', 'p09'] },
    { code: 'mount-disconnected', parts: ['p12', 'p11'] },
    { code: 'mount-disconnected', parts: ['p56', 'p30'] },
    { code: 'mount-disconnected', parts: ['p58', 'p31'] },
    { code: 'mount-disconnected', parts: ['p60', 'p32'] },
    { code: 'mount-disconnected', parts: ['p62', 'p33'] },
    { code: 'mount-disconnected', parts: ['p56', 'p30'] },   // ← 重复
    { code: 'floating', parts: ['p56', 'p57', 'p58', 'p59', 'p60', 'p61', 'p62', 'p63'] },
    { code: 'mech-axis', parts: ['p56', 'p57', 'p58', 'p59'] },
    { code: 'mech-axis', parts: ['p60', 'p61', 'p62', 'p63'] },
    { code: 'mech-clearance', parts: ['p56', 'p57', 'p58', 'p59'] },
    { code: 'mech-clearance', parts: ['p60', 'p61', 'p62', 'p63'] },
  ];
  const c = compareDefects('mecha', {
    errors,
    warnings: [
      { code: 'mech-rigid', parts: ['p56', 'p57', 'p58', 'p59'] },
      { code: 'mech-rigid', parts: ['p60', 'p61', 'p62', 'p63'] },
    ],
  });
  assert.equal(c.ok, false, '重复的已登记错误必须判失败');
  // normalize 会把零件 id 排序，故 p56+p30 规范化为 p30+p56
  assert.ok(c.added.some((k) => k.includes('mount-disconnected:p30+p56')), `应指出重复的那条，实际：${JSON.stringify(c.added)}`);
});

// ---------------------------------------------------------------- ② 配对规则严格性

const stud = (kind, pos, axis, extra = {}) => ({ kind, pos, axis, dir: '+y', ...extra });
const recep = (kind, pos, axis, extra = {}) => ({ kind, pos, axis, dir: '+y', ...extra });

test('配对规则：类型必须真正配对，不是「都属于轴类」就算', () => {
  // bar 只能配 clip；clip 不是公头，不能当 bar 的配对对象
  assert.equal(connectorPairMatches(stud('bar', [0, 1, 1.5], 'x'), recep('clip', [0, 1, 1.5], 'x')), true);
  assert.equal(connectorPairMatches(stud('bar', [0, 1, 1.5], 'x'), recep('hole', [0, 1, 1.5], 'x')), false, 'bar 不能插 hole');
  assert.equal(connectorPairMatches(stud('bar', [0, 1, 1.5], 'x'), recep('axle', [0, 1, 1.5], 'x')), false, 'bar 不能插 axle');
  assert.equal(connectorPairMatches(stud('pin', [0, 1, 1.5], 'x'), recep('hole', [0, 1, 1.5], 'x')), true);
  assert.equal(connectorPairMatches(stud('pin', [0, 1, 1.5], 'x'), recep('axle', [0, 1, 1.5], 'x')), true);
  assert.equal(connectorPairMatches(stud('pin', [0, 1, 1.5], 'x'), recep('clip', [0, 1, 1.5], 'x')), false, 'pin 不能夹 clip');
});

test('配对规则：轴必须同向', () => {
  assert.equal(connectorPairMatches(stud('bar', [0, 1, 1.5], 'x'), recep('clip', [0, 1, 1.5], 'z')), false, '轴不同向不算扣合');
  assert.equal(connectorPairMatches(stud('bar', [0, 1, 1.5], 'x'), recep('clip', [0, 1, 1.5], 'x')), true);
});

test('配对规则：位置容差是 0.08 格 / 0.20 片，不是宽松近似', () => {
  const base = [0, 1, 1.5];
  assert.equal(connectorPairMatches(stud('bar', base, 'x'), recep('clip', [0, 1, 1.5], 'x')), true);
  assert.equal(connectorPairMatches(stud('bar', base, 'x'), recep('clip', [0.1, 1, 1.5], 'x')), false, '水平偏 0.1 格超出容差');
  assert.equal(connectorPairMatches(stud('bar', base, 'x'), recep('clip', [0, 1.3, 1.5], 'x')), false, '竖直偏 0.3 片超出容差');
  assert.equal(connectorPairMatches(stud('bar', base, 'x'), recep('clip', [0.05, 1.15, 1.5], 'x')), true, '容差内应通过');
});

test('配对规则：机关豁免用的就是这一套（不再有第二套判据）', () => {
  // 源码级：豁免路径必须调用 connectorPairMatches，而不是自己写距离/类型判断
  const src = fs.readFileSync('src/core/core.js', 'utf8');
  const idx = src.indexOf('const consider = (s, r, movingId, fixedId)');
  assert.ok(idx > 0, '应能找到运动豁免的配对入口');
  const block = src.slice(idx, idx + 700);
  assert.match(block, /connectorPairMatches\(s,\s*r\)/, '豁免必须复用真实配对规则');
  assert.doesNotMatch(block, /d > 0\.5/, '不得再使用宽松的距离阈值');
});
