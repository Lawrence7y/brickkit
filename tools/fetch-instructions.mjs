// 下载官方代表性乐高组装说明书（本地参考素材）。
// 渠道：Brickset 索引接口解析出 LEGO 官方 CDN 的 PDF 直链（product.bi.core.pdf）。
// 版权：说明书版权归 The LEGO Group；官网免费提供个人下载，本目录已 .gitignore，不得随仓库再分发。
// 用法：node tools/fetch-instructions.mjs [--dir assets/instructions-lego] [--set 31058-1]
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// 代表性套装：覆盖 Creator 3-in-1 / 机甲 / City / Technic / Star Wars / Classic，
// 中小体量为主（每册 3-10MB），供拼装图纸风格与结构参考。
const SETS = [
  { set: '31058-1', zh: 'Creator 三合一：威猛恐龙（含霸王龙）', why: '3-in-1 多分册结构' },
  { set: '31062-1', zh: 'Creator 机械探险者（机器人）', why: '机甲类参考' },
  { set: '70615-1', zh: 'Ninjago 火焰机甲', why: '官方机甲参考' },
  { set: '60239-1', zh: 'City 警察巡逻车', why: '基础砖拼装' },
  { set: '42065-1', zh: 'Technic 履带赛车', why: '科技件结构' },
  { set: '75211-1', zh: 'Star Wars 帝国 TIE 战斗机', why: '中型混合结构' },
  { set: '10715-1', zh: 'Classic 积木滚滚乐', why: '入门套装' },
];

// 安全约束：仅 https + 主机白名单，拒绝环回/私有/保留地址
function assertAllowed(url) {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const privateRe = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/;
  if (u.protocol !== 'https:' || privateRe.test(host) || !(host === 'brickset.com' || host.endsWith('.lego.com'))) {
    throw new Error(`拒绝非白名单 URL：${url}`);
  }
  return u.href;
}

// 本机网络环境需要 IPv4 + HTTP/1.1 才能访问 brickset（已实测），统一走 curl
function curlText(url, extra = []) {
  const href = assertAllowed(url);
  return execFileSync('curl', ['-s', '--http1.1', '-4', '-A', UA, '--max-time', '120', ...extra, href], { maxBuffer: 32 * 1024 * 1024 }).toString('utf8');
}

function curlToFile(url, file) {
  const href = assertAllowed(url);
  execFileSync('curl', ['-s', '--http1.1', '-4', '-A', UA, '--max-time', '600', '-L', '-o', file, href], { maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'ignore', 'inherit'] });
}

const stripTags = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// 解析 Brickset 指令表格：每行取官方 CDN PDF 直链 + 行标签（含分册号与版本）
function parseBooks(html, setNo) {
  const books = [];
  for (const row of html.split(/<tr/i).slice(1)) {
    const m = row.match(/https:\/\/www\.lego\.com\/cdn\/product-assets\/product\.bi\.core\.pdf\/(\d+)\.pdf/i);
    if (!m) continue;
    const label = stripTags(row.slice(0, Math.max(row.indexOf(m[0]), 0) + 400));
    books.push({ url: m[0], id: m[1], label, sizeMb: Number((label.match(/([\d.]+)\s*Mb/i) || [])[1] || 0) });
  }
  // 去重：同一分册多语言版本，优先 V29（国际版），其次 V39（美版），再次第一个
  const byBook = new Map();
  for (const b of books) {
    const bm = b.label.match(new RegExp(`${setNo.replace('-', '\\-')}\\s+(\\d+)\\/(\\d+)`)) || [];
    const book = bm[1] ? `book${bm[1]}of${bm[2]}` : 'book1';
    const prev = byBook.get(book);
    const rank = (l) => (/V29/.test(l) ? 0 : /V39/.test(l) ? 1 : 2);
    if (!prev || rank(b.label) < rank(prev.label)) byBook.set(book, { ...b, book });
  }
  return [...byBook.entries()].map(([book, b]) => ({ book, ...b })).sort((a, b) => a.book.localeCompare(b.book));
}

async function main() {
  const outDir = path.resolve(ROOT, process.argv.includes('--dir') ? process.argv[process.argv.indexOf('--dir') + 1] : 'assets/instructions-lego');
  fs.mkdirSync(outDir, { recursive: true });
  const only = process.argv.includes('--set') ? process.argv[process.argv.indexOf('--set') + 1] : null;
  const manifest = {
    note: '官方乐高组装说明书，版权归 The LEGO Group。经 brickset.com 索引解析出 lego.com 官方 CDN 直链下载；仅作本地参考，不得再分发。',
    source: 'https://www.lego.com/service/buildinginstructions (索引经 brickset.com)',
    fetchedAt: new Date().toISOString(), sets: [],
  };
  for (const { set, zh, why } of SETS) {
    if (only && set !== only) continue;
    process.stdout.write(`${set} ${zh} … `);
    let html;
    try {
      html = curlText(`https://brickset.com/ajax/sets/instructions?set=${encodeURIComponent(set)}`, ['-H', 'X-Requested-With: XMLHttpRequest', '-H', `Referer: https://brickset.com/sets/${set}`]);
    } catch (e) { console.log(`索引获取失败：${e.message}`); continue; }
    const setNo = set.split('-')[0];
    const books = parseBooks(html, setNo);
    if (!books.length) { console.log('未找到说明书'); continue; }
    const entry = { set, zh, why, books: [] };
    for (const b of books) {
      const file = path.join(outDir, `${setNo}_${b.book}.pdf`);
      const sha = crypto.createHash('sha256');
      try {
        if (!fs.existsSync(file)) curlToFile(b.url, file);
        const head = fs.readFileSync(file).subarray(0, 5).toString('latin1');
        if (head !== '%PDF-') { console.log(`\n  ${b.book} 非法 PDF，已删除`); fs.unlinkSync(file); continue; }
        const bytes = fs.statSync(file).size;
        sha.update(fs.readFileSync(file));
        entry.books.push({ book: b.book, label: b.label, url: b.url, file: path.relative(ROOT, file), bytes, sha256: sha.digest('hex') });
      } catch (e) { console.log(`\n  ${b.book} 下载失败：${e.message}`); }
    }
    manifest.sets.push(entry);
    console.log(`${entry.books.length}/${books.length} 册，共 ${(entry.books.reduce((s, b) => s + b.bytes, 0) / 1048576).toFixed(1)} MB`);
  }
  const mf = path.join(outDir, 'manifest.json');
  fs.writeFileSync(mf, JSON.stringify(manifest, null, 2));
  console.log(`manifest → ${mf}`);
}

main();
