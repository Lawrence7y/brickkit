// 计算「官方 ~Moved to 重定向件」中，目标件已在目录里、原编号却缺席的清单（下一批增补候选中零成本的一类）。
// 只读 catalog/parts-ldraw.json 与 catalog/ldraw-full；不写目录文件。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.join(ROOT, 'catalog/ldraw-full/parts');
const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts-ldraw.json'), 'utf8')).parts;
const curated = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts.json'), 'utf8')).parts;
const present = new Set([...Object.keys(shipped), ...Object.keys(curated)]);

const rows = [];
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.dat')) continue;
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  const first = (text.split(/\r?\n/).find((l) => /^0\s/.test(l)) || '').replace(/^0\s+/, '');
  const m = first.match(/^~Moved to\s+(\S+)/i);
  if (!m) continue;
  const id = f.replace(/\.dat$/i, '').toLowerCase();
  const target = m[1].replace(/\.dat$/i, '').toLowerCase();
  if (!fs.existsSync(path.join(dir, `${target}.dat`))) { rows.push({ id, target, state: 'target-missing' }); continue; }
  const t2raw = fs.readFileSync(path.join(dir, `${target}.dat`), 'utf8');
  const t2 = (t2raw.split(/\r?\n/).find((l) => /^0\s/.test(l)) || '').replace(/^0\s+/, '');
  if (/^~Moved to/i.test(t2)) { rows.push({ id, target, state: 'two-level-redirect' }); continue; }
  if (present.has(id)) { rows.push({ id, target, state: 'already-present' }); continue; }
  if (!present.has(target)) { rows.push({ id, target, state: 'target-filtered-out', targetDesc: t2 }); continue; }
  rows.push({ id, target, state: 'RECOVERABLE', targetDesc: t2, targetKind: shipped[target]?.kind || null });
}

const byState = {};
for (const r of rows) byState[r.state] = (byState[r.state] || 0) + 1;
const recoverable = rows.filter((r) => r.state === 'RECOVERABLE');

// —— 第二类：官方 `=` 别名件（0 Name 行以 `=` 开头，等价件写在同一描述下）——
// 这些件号也不在目录里，但目标件多数已在目录。与 ~Moved to 的区别：官方同时保留两个文件
// （`=` 的是"同一件的另一描述"），因此不该像 movedTo 那样重定向，而应作为 alias 收敛。
const eqRows = [];
const descToPlain = new Map();
const allFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.dat'));
const firstLine = (f) => (fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).find((l) => /^0\s/.test(l)) || '').replace(/^0\s+/, '').trim();
for (const f of allFiles) {
  const d = firstLine(f);
  if (/^[=~_]/.test(d)) continue;
  const k = d.replace(/\s+/g, ' ');
  if (!descToPlain.has(k)) descToPlain.set(k, []);
  descToPlain.get(k).push(f.replace(/\.dat$/i, '').toLowerCase());
}
for (const f of allFiles) {
  const d = firstLine(f);
  const m = d.match(/^=\s*(\S.*)$/);
  if (!m) continue;
  const id = f.replace(/\.dat$/i, '').toLowerCase();
  const k = m[1].trim().replace(/\s+/g, ' ');
  const cands = descToPlain.get(k) || [];
  const shipped = cands.filter((c) => present.has(c));
  eqRows.push({
    id, description: k, candidates: cands,
    state: present.has(id) ? 'already-present' : shipped.length ? 'ALIAS-RECOVERABLE' : 'target-filtered-out',
    target: shipped[0] || null,
  });
}
const eqByState = {};
for (const r of eqRows) eqByState[r.state] = (eqByState[r.state] || 0) + 1;

const out = {
  generatedAt: new Date().toISOString(),
  scope: '只读：未修改 parts-ldraw.json / 生成器 / 别名映射',
  totals: { redirectFiles: rows.length, byState, recoverable: recoverable.length, equalAliasFiles: eqRows.length, equalAliasByState: eqByState },
  note: 'RECOVERABLE = 官方重定向件目标已在目录内，原编号却缺席；生成器已支持跟随一层重定向（tools/gen-parts-catalog.mjs 未提交改动），但当前 parts-ldraw.json 尚未重生成，故这些编号查不到。ALIAS-RECOVERABLE = 官方 `=` 别名件，同描述素模已在目录，可作为 alias 收敛（不需重定向）。',
  recoverable,
  equalAliasRecoverable: eqRows.filter((r) => r.state === 'ALIAS-RECOVERABLE'),
  all: rows,
  allEqualAlias: eqRows,
};
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'redirect-candidates.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ byState, recoverable: recoverable.length }, null, 1));
console.log(recoverable.slice(0, 25).map((r) => `${r.id} -> ${r.target} (${r.targetDesc})`).join('\n'));
