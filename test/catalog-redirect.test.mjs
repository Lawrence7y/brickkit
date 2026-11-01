// 用最小 LDraw 夹具实际运行生成器，验证「重定向件按原编号收录」这个能力。
//
// 为什么不能只做源码字符串匹配：源码里有 `~Moved to` 字样，不代表产物正确——
// 可能跟随失败、可能收录成空壳、可能没继承连接器。只有真跑一遍并检查输出才算证明。
//
// 夹具只含 60470 → 60470a 这条重定向链及其直接/间接引用的图元，
// 因此不需要重建整库（全量重建会牵动 5000+ 件的分解盒，风险与本能力无关）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SRC = 'catalog/ldraw-full';

/** 递归收集一个 .dat 及其全部引用（parts/、p/、p/8/、p/48/ 都收），返回 Map<相对路径, 内容> */
function collect(libRoot, startRel) {
  const out = new Map();
  const queue = [startRel];
  const resolve = (ref) => {
    const r = ref.trim().toLowerCase().replace(/\\/g, '/');
    for (const c of [`parts/${r}`, `p/${r}`, `p/8/${r}`, `p/48/${r}`, `parts/s/${r}`]) {
      if (fs.existsSync(path.join(libRoot, c))) return c;
    }
    return null;
  };
  while (queue.length) {
    const rel = queue.pop();
    if (out.has(rel)) continue;
    const f = path.join(libRoot, rel);
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    out.set(rel, text);
    for (const line of text.split(/\r?\n/)) {
      // LDraw 行：`1 <color> <x> <y> <z> <a> <b> <c> <d> <e> <f> <g> <h> <i> <ref>`
      const t = line.trim().split(/\s+/);
      if (t[0] === '1' && t.length >= 15) {
        const r = resolve(t[14]);
        if (r) queue.push(r);
      }
    }
  }
  return out;
}

test('生成器实际运行：重定向件按原编号收录，并继承目标件几何与接口', () => {
  // 前置：目标件与重定向件在官方库里都存在，且 60470 确实是 `~Moved to` 重定向
  const targetRel = 'parts/60470a.dat';
  const movedRel = 'parts/60470.dat';
  assert.ok(fs.existsSync(path.join(SRC, targetRel)), '夹具前置：需要 60470a.dat');
  assert.ok(fs.existsSync(path.join(SRC, movedRel)), '夹具前置：需要 60470.dat');
  const movedHead = fs.readFileSync(path.join(SRC, movedRel), 'utf8');
  assert.match(movedHead, /~\s*Moved to\s+60470a/i, '夹具前置：60470 应为重定向件');

  // 搭临时 LDraw 库：只放这条重定向链所需的文件
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brickkit-redirect-'));
  const files = new Map([...collect(SRC, targetRel), ...collect(SRC, movedRel)]);
  for (const [rel, text] of files) {
    const dst = path.join(tmp, 'ldraw', rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, text);
  }
  const outFile = path.join(tmp, 'parts.json');

  // 真跑生成器（--dir 指向夹具库，避免重建整库）
  execFileSync(process.execPath, [
    'tools/gen-parts-catalog.mjs', '--dir', path.join(tmp, 'ldraw'), '-o', outFile,
  ], { stdio: 'pipe', timeout: 120000 });

  const out = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  const parts = out.parts;

  // ① 目标件被收录
  assert.ok(parts['60470a'], '目标件 60470a 应被收录');
  // ② 重定向件也按**原编号**收录（这是本能力的核心）
  assert.ok(parts['60470'], '重定向件应按原编号 60470 收录，而不是被跳过');
  assert.equal(parts['60470'].movedTo, '60470a', '应收录 movedTo 说明来源');
  // ③ 继承的是真实几何与接口，不是空壳
  assert.deepEqual(parts['60470'].size, parts['60470a'].size, 'size 应与目标件一致');
  assert.equal(typeof parts['60470'].h, 'number', 'h 应为数字');
  assert.ok(parts['60470'].kind, 'kind 不应为空');
  assert.deepEqual(parts['60470'].clips, parts['60470a'].clips, 'clips 应与目标件一致');
  assert.deepEqual(parts['60470'].studs, parts['60470a'].studs, 'studs 应与目标件一致');

  // ④ 60470 是「双水平夹板」，夹具里应能提取到夹口（证明接口确实被解析，不是空数组）
  assert.ok(Array.isArray(parts['60470a'].clips) && parts['60470a'].clips.length >= 2,
    `60470a 应解析出 ≥2 个夹口，实际：${JSON.stringify(parts['60470a'].clips)}`);

  fs.rmSync(tmp, { recursive: true, force: true });
});
