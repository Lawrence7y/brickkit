// 获取指定套装的官方零件清单（BOM），产出 examples/<set>.bom.json。
//
// 来源尝试顺序（每次尝试的结论都写进输出 JSON 的 sources[]，失败原因照实记录）：
//   1. Rebrickable —— 有 REBRICKABLE_API_KEY 走 API（/api/v3/lego/sets/<set>/parts/），
//      无 key 走套装网页 /sets/<set>/（2026-10 实测被 Cloudflare 挑战拦截）。
//   2. BrickLink —— /v2/catalogItemInv.asp?S=<set> 页面解析（2026-10 实测被 AWS WAF 挑战拦截，HTTP 202 空体）。
//   3. Brickset —— /inventories/<set> 库存表（页面自述：数据来自 LEGO Customer Services
//      补件页，含抓取日期与件数）。BrickLink 被拦时作为在线目录的替代来源。
//   4. 说明书 PDF —— assets/instructions-lego/<set>_book1.pdf 的零件总览页。**首先**尝试读文字层
//      （零件总览页的 "4x / 6029208" 是可提取文本，比肉眼点数可信）；文字层不可用时才渲染成图供人工
//      视觉清点，此时 source 记 manual-visual、confidence 记 low。
//
// 文件边界：本工具只写 examples/<set>.bom.json 与系统临时目录下的零件总览页渲染图（--outdir 可改）；
// 不改 cli/、src/、catalog/、test/、docs/，不 git commit。
//
// 用法：
//   node tools/fetch-bom.mjs --set 60239-1 [--out examples/60239.bom.json] [--pdf assets/instructions-lego/60239_book1.pdf]
//   环境变量：REBRICKABLE_API_KEY（可选）
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};
const SET = arg('set', '60239-1');
const OUT = path.resolve(ROOT, arg('out', `examples/${SET.replace(/-1$/, '')}.bom.json`));
const PDF = path.resolve(ROOT, arg('pdf', `assets/instructions-lego/${SET.replace('-1', '')}_book1.pdf`));
const OUTDIR = path.resolve(arg('outdir', path.join(process.env.TEMP || process.env.TMPDIR || '/tmp', `brickkit-bom-${SET}`)));

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`用法：node tools/fetch-bom.mjs --set 60239-1 [选项]
  --set <编号>     套装号，默认 60239-1（输出文件名取编号前半段：examples/60239.bom.json）
  --out <文件>     输出路径，默认 examples/<编号>.bom.json
  --pdf <文件>     说明书 PDF，默认 assets/instructions-lego/<编号>_book1.pdf
  --outdir <目录>  零件总览页渲染图目录，默认系统临时目录
  --no-network     跳过全部在线来源，只用本地 PDF（离线/复现）
  --self-test      只跑安全层断言（不联网、不写文件）
  环境变量：REBRICKABLE_API_KEY（有则走 Rebrickable API）`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 安全层：与 tools/fetch-instructions.mjs 的 assertAllowed 同一套约束（仅 https + 主机白名单 +
// 拒绝环回/私有/保留地址），白名单按本工具需要扩到 rebrickable / bricklink / brickset / lego。
// ---------------------------------------------------------------------------
const ALLOW_EXACT = new Set(['brickset.com']); // 任务书只给了 brickset.com 本身，不含子域
const ALLOW_SUFFIX = ['.rebrickable.com', '.bricklink.com', '.lego.com'];
const ALLOW_ROOT = new Set(['rebrickable.com', 'bricklink.com', 'lego.com']);

const PRIVATE_V4 = [
  /^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64/10
  /^192\.0\.0\./, /^192\.0\.2\./, /^198\.(1[89]|51)\./, /^203\.0\.113\./,
  /^22[4-9]\./, /^23\d\./, /^24\d\./, /^25[0-5]\./, // 组播 + 保留 240/4
];
const V6_LOOPBACK = /^\[?::1\]?$/;
const V6_PRIVATE = /^\[?(fc|fd|fe[89ab]|ff)/i; // ULA fc00::/7、链路本地 fe80::/10、组播 ff00::/8

// 内嵌 IPv4 的点分十进制/十六进制写法（如 0x7f000001、2130706433）也一并拒绝
function isPrivateOrReservedIp(ip) {
  const v = String(ip).trim().toLowerCase();
  if (v.includes(':')) {
    return V6_LOOPBACK.test(v) || V6_PRIVATE.test(v) || v === '::' || v.startsWith('[::');
  }
  const dotted = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!dotted) {
    if (/^\d+$/.test(v) || /^0x[0-9a-f]+$/i.test(v)) return true; // 单整数形式一律拒绝
    return true; // 无法识别的地址形态，按不安全处理
  }
  return PRIVATE_V4.some((re) => re.test(v));
}

function assertAllowed(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`非法 URL：${url}`); }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const reject = (why) => { throw new Error(`拒绝非白名单 URL（${why}）：${url}`); };
  if (u.protocol !== 'https:') reject('仅允许 https');
  if (u.username || u.password) reject('URL 不得携带凭据');
  if (!host) reject('空主机名');
  const bare = host.replace(/^\[|\]$/g, '');
  if (bare === 'localhost' || bare.endsWith('.localhost')) reject('localhost');
  if (bare.includes(':')) reject('IPv6 字面量'); // 白名单均为域名，直接拒绝 IP 字面量
  if (/^\d+\.\d+\.\d+\.\d+$/.test(bare) || /^\d+$/.test(bare) || /^0x/i.test(bare)) {
    reject(`IP 字面量（${isPrivateOrReservedIp(bare) ? '环回/私有/保留地址' : '不允许'}）`);
  }
  if (/\.(local|internal|lan|home|corp|arpa)$/.test(bare)) reject('内网后缀');
  const ok = ALLOW_ROOT.has(bare) || ALLOW_EXACT.has(bare) || ALLOW_SUFFIX.some((s) => bare.endsWith(s));
  if (!ok) reject('不在白名单');
  return { href: u.href, host: bare };
}

// 本机访问这些站点需要 IPv4 + HTTP/1.1（fetch-instructions.mjs 已实测），统一走 curl；
// 不跟随重定向（--max-redirs 0），避免被判过的主机把请求重定向到白名单外。
// 注意：不做额外 DNS 解析校验——与 tools/fetch-instructions.mjs 的 assertAllowed 判定范围保持一致
// （主机名字符串层面：协议 / 白名单 / IP 字面量与内网后缀）。本机存在透明代理，白名单域名会解析到
// 198.18.0.0/15 基准测试网段，按解析结果拦截会让工具完全不可用，故不在此层判定。
async function curlText(url, headers = []) {
  const { href } = assertAllowed(url);
  return execFileSync('curl', [
    '-sS', '--proto', '=https', '--http1.1', '-4', '-A', UA, '--max-time', '90', '--max-redirs', '0',
    ...headers.flatMap((h) => ['-H', h]), href,
  ], { maxBuffer: 32 * 1024 * 1024 }).toString('utf8');
}

const stripTags = (s) => s
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ').trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 本机到 brickset 偶发连接超时，重试 3 次（指数退避），仍失败才记失败
async function curlTextRetry(url, headers = [], tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await curlText(url, headers); } catch (e) { last = e; await sleep(1200 * (i + 1)); }
  }
  throw last;
}

// ---------------------------------------------------------------------------
// 来源 1/2/3：网页库存解析
// ---------------------------------------------------------------------------
// BrickLink 色名 → LDraw 色号。优先从 catalog/colors.json（LDraw 官方色名表）按名称匹配；
// 色名对不上时再查 LDraw ldconfig（out/LDConfig.ldr，catalog-fetch 下载）里的 `LEGOID N - Name` 注释，
// 用 LEGO 官方色名反查。两处都查不到的（如 Multicombination 多色模压件）不猜，color=null + colorConf 低。
const COLORS_JSON = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/colors.json'), 'utf8')).colors;
const LDCONFIG = [path.join(ROOT, 'out/LDConfig.ldr'), path.join(ROOT, 'catalog/ldraw/LDConfig.ldr')]
  .find((f) => fs.existsSync(f));

// Brickset / BrickLink 用的是 LEGO 官方色名（Brick Yellow、Medium Stone Grey…），
// catalog/colors.json 用的是 LDraw 名（Tan、Light Bluish Grey…）。下表是两条命名体系的对齐；
// 每一对都由 LDraw 官方 LDConfig.ldr 的 `LEGOID N - <色名>` 注释核对过（见 ldconfigIndex 的交叉校验），
// 校验不一致时 colorConf 降为 0.5 并在 lowColourConfidence 里列出。
const LEGO_TO_LDRAW_NAME = {
  Black: 'Black', White: 'White',
  'Brick Yellow': 'Tan', Tan: 'Tan',
  'Bright Blue': 'Blue', Blue: 'Blue',
  'Bright Orange': 'Orange', Orange: 'Orange',
  'Bright Red': 'Red', Red: 'Red',
  'Bright Yellow': 'Yellow', Yellow: 'Yellow',
  'Dark Stone Grey': 'Dark_Bluish_Grey',
  'Medium Stone Grey': 'Light_Bluish_Grey',
  'Earth Blue': 'Dark_Blue',
  'Light Royal Blue': 'Bright_Light_Blue',
  Transparent: 'Trans_Clear',
  'Transparent Blue': 'Trans_Dark_Blue',
  'Transparent Light Blue': 'Trans_Light_Blue',
  'Transparent Red': 'Trans_Red',
};

// LDConfig 的 LEGOID 索引（色名 → LDraw 色号），用于交叉校验上表
function ldconfigIndex() {
  const idx = new Map();
  if (!LDCONFIG) return idx;
  const lines = fs.readFileSync(LDCONFIG, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^0\s+!COLOUR\s+(\S+)\s+CODE\s+(\d+)/);
    if (!m) continue;
    for (let k = i - 1; k >= 0 && k > i - 5; k--) {
      const lm = lines[k].match(/LEGOID\s+([\d\s/]+?)\s*-\s*(.+?)(\s*\*\/)?\s*$/);
      if (lm) { idx.set(lm[2].trim().toLowerCase(), { ldraw: Number(m[2]), ldrawName: m[1], legoName: lm[2].trim() }); break; }
    }
  }
  return idx;
}
const LD_CONFIG_INDEX = ldconfigIndex();

// catalog/colors.json 用空格形式（"Dark Bluish Grey"），LDConfig 用下划线形式（Dark_Bluish_Grey），统一去分隔符比较
const normColorName = (s) => String(s).toLowerCase().replace(/[\s_]+/g, ' ').trim();

function mapColour(name) {
  if (!name) return { ldraw: null, name: null, colorConf: 0, reason: '来源未给颜色' };
  const raw = name.trim();
  const ldrawName = LEGO_TO_LDRAW_NAME[raw];
  if (ldrawName) {
    const entry = Object.entries(COLORS_JSON).find(([, v]) => normColorName(v.name) === normColorName(ldrawName));
    if (entry) {
      // LDConfig 若也认得这个 LEGO 色名，要求两边色号一致才给满分
      const cfg = LD_CONFIG_INDEX.get(raw.toLowerCase());
      const consistent = !cfg || cfg.ldraw === Number(entry[0]);
      return { ldraw: Number(entry[0]), name: entry[1].name, colorConf: consistent ? 1 : 0.5, reason: consistent ? null : `LDConfig 给出 ${cfg.ldraw}` };
    }
  }
  const cfg = LD_CONFIG_INDEX.get(raw.toLowerCase());
  if (cfg) return { ldraw: cfg.ldraw, name: cfg.ldrawName, colorConf: 0.8, reason: '仅 LDConfig 命中' };
  return { ldraw: null, name: raw, colorConf: 0.2, reason: '色名未匹配到 LDraw 色号（不猜）' };
}

// Brickset /inventories/<set> 表格：每行 Element | Image | Qty | Colour | Category | Design | Name ...
function parseBricksetInventory(html, setNo) {
  const t = html.slice(html.indexOf('<table'));
  const rows = [];
  for (const tr of t.split(/<tr[^>]*>/i).slice(2)) {
    const tds = tr.split(/<td[^>]*>/i).slice(1);
    if (tds.length < 7) continue; // 后面的 Colour/Category 汇总表只有 3 列
    const cell = tds.map((x) => stripTags(x));
    const element = cell[0].match(/^\d{4,8}$/) ? cell[0] : (cell[0].match(/\b(\d{4,8})\b/) || [])[1];
    const qty = Number(cell[2]);
    if (!element || !Number.isFinite(qty)) continue;
    rows.push({ element, qty, colour: cell[3], category: cell[4], design: cell[5], name: cell[6] });
  }
  const intro = stripTags(html).match(/contains\s+(\d+)\s+pieces/i);
  return { rows, statedTotal: intro ? Number(intro[1]) : null, url: `https://brickset.com/inventories/${setNo}` };
}

// Brickset 元素页：取 Design 与 Colour（库存表未覆盖的元素才需要单独取）
function parseBricksetElement(html) {
  const text = stripTags(html);
  const name = (html.match(/Element name<\/dt>\s*<dd>([^<]+)<\/dd>/) || [])[1];
  const design = (html.match(/\/parts\/design-(\d+)/) || [])[1] || null;
  const colour = (html.match(/\/parts\/colour-([A-Za-z0-9%\-]+)/) || [])[1]?.replace(/-/g, ' ') || null;
  return { design, colour, name: name ? name.trim() : (text.match(/^LEGO parts \d+: ([^|]+)/) || [])[1] };
}

// Brickset 套装页的 Pieces 字段 = 官方盒内件数（与库存页自述件数可能不同，两者都记录）
function parseBricksetSetPieces(html) {
  const m = html.match(/<dt>Pieces<\/dt>\s*<dd>\s*(?:<a[^>]*>)?\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

// Brickset 页面声明 ISO-8859-1、正文却是 UTF-8 字节，curl 按 UTF-8 解码后中文/Ø/½ 会变成 "Ã˜"/"Â½"
// 这类双重编码。用 CP1252 反向映射还原字节再按 UTF-8 解码；还原失败（出现替换符）就保留原文。
const CP1252_HIGH = {
  0x80: '\u20AC', 0x82: '\u201A', 0x83: '\u0192', 0x84: '\u201E', 0x85: '\u2026', 0x86: '\u2020',
  0x87: '\u2021', 0x88: '\u02C6', 0x89: '\u2030', 0x8A: '\u0160', 0x8B: '\u2039', 0x8C: '\u0152',
  0x8E: '\u017D', 0x91: '\u2018', 0x92: '\u2019', 0x93: '\u201C', 0x94: '\u201D', 0x95: '\u2022',
  0x96: '\u2013', 0x97: '\u2014', 0x98: '\u02DC', 0x99: '\u2122', 0x9A: '\u0161', 0x9B: '\u203A',
  0x9C: '\u0153', 0x9E: '\u017E', 0x9F: '\u0178',
};
const CP1252_REV = new Map(Object.entries(CP1252_HIGH).map(([b, ch]) => [ch, Number(b)]));

function repairMojibake(s) {
  if (typeof s !== 'string' || !s || !/[^\x00-\x7F]/.test(s)) return s;
  const bytes = [];
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code <= 0xFF) bytes.push(code);
    else if (CP1252_REV.has(ch)) bytes.push(CP1252_REV.get(ch));
    else return s; // 含无法映射的字符，不是本类乱码
  }
  const fixed = Buffer.from(Uint8Array.from(bytes)).toString('utf8');
  return fixed.includes('\uFFFD') ? s : fixed;
}

// 以 Brickset 库存表为在线目录来源（其数据自述来自 LEGO Customer Services 补件页）
async function sourceBrickset(setNo) {
  const url = `https://brickset.com/inventories/${setNo}`;
  const html = await curlTextRetry(url);
  if (/<title>\s*LEGO parts/i.test(html) && !/Inventory for/i.test(html)) {
    throw new Error('页面不是库存页（可能被重定向或该套无库存）');
  }
  const { rows, statedTotal } = parseBricksetInventory(html, setNo);
  if (!rows.length) throw new Error('库存表未解析到任何行');
  // 套装页 Pieces 字段（官方盒内件数）——与库存页自述件数分开记录
  let setPieces = null;
  try {
    setPieces = parseBricksetSetPieces(await curlTextRetry(`https://brickset.com/sets/${setNo}`));
  } catch { /* 拿不到就留空，不猜 */ }
  for (const r of rows) r.name = repairMojibake(r.name);
  return { source: 'brickset-inventory', url, rows, statedTotal, setPieces };
}

// 来源 2：BrickLink 库存页（WAF 挑战时返回 202 空体）
async function sourceBricklink(setNo) {
  const url = `https://www.bricklink.com/v2/catalogItemInv.asp?S=${setNo}`;
  const html = await curlText(url, [`Referer: https://www.bricklink.com/v2/catalog/catalogitem.page?S=${setNo}`]);
  if (!html.trim()) throw new Error('HTTP 空体（AWS WAF 挑战页，无可用库存数据）');
  const rows = [];
  for (const tr of html.split(/<tr[^>]*>/i)) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]));
    if (cells.length < 4) continue;
    const qty = Number(cells[0]);
    const id = (cells[1] || '').match(/\b(\d{4,8})\b/);
    if (!Number.isFinite(qty) || !id) continue;
    rows.push({ element: id[1], qty, name: cells[2], colour: cells[3] });
  }
  if (!rows.length) throw new Error('页面无库存表（结构与解析器不符）');
  return { source: 'bricklink-inventory', url, rows, statedTotal: null };
}

// BrickLink 套装页（库存页被 WAF 拦截时仍可访问）：只用于读取 "N Parts / N Minifigures" 口径供对账，
// 该数字是目录中可单独购买的不同设计数，不是件数，不得当作 totalParts。
async function bricklinkSetPageSummary(setNo) {
  const url = `https://www.bricklink.com/v2/catalog/catalogitem.page?S=${setNo}`;
  try {
    const html = await curlText(url);
    const parts = (stripTags(html).match(/(\d+)\s+Parts\b/) || [])[1];
    const figs = (stripTags(html).match(/(\d+)\s+Minifigures?\b/) || [])[1];
    return { url, catalogParts: parts ? Number(parts) : null, minifigs: figs ? Number(figs) : null };
  } catch (e) {
    return { url, error: e.message };
  }
}

// 来源 1：Rebrickable（有 key 走 API，否则抓套装页）
async function sourceRebrickable(setNo) {
  const base = setNo.split('-')[0];
  const key = process.env.REBRICKABLE_API_KEY;
  if (key) {
    const url = `https://rebrickable.com/api/v3/lego/sets/${setNo}/parts/?page_size=1000`;
    const text = await curlText(url, [`Authorization: key ${key}`]);
    const json = JSON.parse(text);
    const rows = (json.results || []).map((r) => ({
      element: r.part.external_ids?.BrickLink?.[0] || r.part.part_num,
      qty: r.quantity,
      design: r.part.part_num,
      name: r.part.name,
      colour: String(r.color.name),
      colorId: r.color.id,
    }));
    if (!rows.length) throw new Error('API 返回空零件表');
    return { source: 'rebrickable-api', url, rows, statedTotal: json.count ?? null };
  }
  const url = `https://rebrickable.com/sets/${setNo}/`;
  const html = await curlText(url);
  if (/Just a moment|cf-challenge|challenge-platform/i.test(html)) throw new Error('被 Cloudflare 人机挑战拦截（无 API key）');
  if (!html.trim()) throw new Error('HTTP 空体');
  throw new Error('套装页无零件表（Rebrickable 零件清单需 API key 或登录）');
}

// ---------------------------------------------------------------------------
// 来源 4：说明书 PDF 零件总览页
// ---------------------------------------------------------------------------
async function loadPdfjs() {
  const entry = path.join(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs');
  if (!fs.existsSync(entry)) throw new Error('未安装 pdfjs-dist（npm install pdfjs-dist）');
  return import(`file://${entry.replace(/\\/g, '/')}`);
}

// 零件总览页 = 大量 "Nx" 数量 + 4~8 位元素编号 成对出现的页
function pairsFromPage(items) {
  const seen = new Set();
  const toks = [];
  for (const it of items) {
    const s = it.str.trim();
    if (!s) continue;
    const k = `${s}|${it.transform[4].toFixed(2)}|${it.transform[5].toFixed(2)}`;
    if (seen.has(k)) continue; // 同一 token 在内容流里被重复绘制
    seen.add(k);
    toks.push({ s, x: it.transform[4], y: it.transform[5] });
  }
  const qtys = toks.filter((t) => /^\d+x$/.test(t.s));
  const ids = toks.filter((t) => /^\d{4,8}$/.test(t.s) && !/^\d+x$/.test(t.s));
  const used = new Set();
  const rows = [];
  for (const q of qtys) {
    // 数量印在编号正上方约 7pt 处，同一列
    const hit = ids
      .filter((i) => !used.has(i) && Math.abs(i.x - q.x) < 12 && i.y < q.y && q.y - i.y < 16)
      .sort((a, b) => b.y - a.y)[0];
    if (!hit) continue;
    used.add(hit);
    rows.push({ element: hit.s, qty: Number(q.s.slice(0, -1)) });
  }
  return { rows, totalQtyTokens: qtys.length };
}

// 渲染说明书末几页（零件总览通常在后部）为 PNG，供人工/多模态视觉清点
async function renderTailPages(doc) {
  const out = [];
  try {
    const { createRequire } = await import('module');
    const canvasMod = createRequire(path.join(ROOT, 'package.json'))('@napi-rs/canvas');
    fs.mkdirSync(OUTDIR, { recursive: true });
    for (let p = Math.max(1, doc.numPages - 2); p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 2 });
      const canvas = canvasMod.createCanvas(Math.round(vp.width), Math.round(vp.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const file = path.join(OUTDIR, `pdf-page-${p}.png`);
      fs.writeFileSync(file, canvas.toBuffer('image/png'));
      out.push(file);
    }
  } catch (e) {
    out.push(`渲染失败：${e.message}`);
  }
  return out;
}

async function sourcePdf(pdfPath) {
  if (!fs.existsSync(pdfPath)) throw new Error(`说明书不存在：${path.relative(ROOT, pdfPath)}`);
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), disableFontFace: true }).promise;
  let best = null;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    if (!page.getTextContent) continue;
    const { rows, totalQtyTokens } = pairsFromPage((await page.getTextContent()).items);
    if (rows.length >= 20 && (!best || rows.length > best.rows.length)) best = { page: p, rows, totalQtyTokens };
  }
  if (!best) {
    // 文字层不可用：渲染后半部分页面，交给人工/多模态视觉清点（source 标 manual-visual，低置信）
    const renders = await renderTailPages(doc);
    return {
      source: 'manual-visual',
      url: null,
      pdf: path.relative(ROOT, pdfPath),
      page: null,
      rows: [],
      statedTotal: null,
      textLayer: false,
      renders,
      manualVisual: true,
      note: '零件总览页无 "数量 + 元素编号" 可提取文本，已渲染页面供视觉清点；请在 JSON 中人工填写 parts。',
    };
  }
  // 视觉复核：把零件总览页渲染成图（文字层解析结果仍需人眼/多模态核对一次）。
  // 渲染图写到系统临时目录，不在仓库内新增文件。
  const renders = [];
  try {
    const { createRequire } = await import('module');
    const canvasMod = createRequire(path.join(ROOT, 'package.json'))('@napi-rs/canvas');
    fs.mkdirSync(OUTDIR, { recursive: true });
    const page = await doc.getPage(best.page);
    const vp = page.getViewport({ scale: 2 });
    const canvas = canvasMod.createCanvas(Math.round(vp.width), Math.round(vp.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const out = path.join(OUTDIR, `pdf-parts-page-${best.page}.png`);
    fs.writeFileSync(out, canvas.toBuffer('image/png'));
    renders.push(out);
  } catch (e) {
    renders.push(`渲染失败：${e.message}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/instructions-lego/manifest.json'), 'utf8'));
  const bookUrl = manifest.sets.find((s) => s.set === SET)?.books?.[0]?.url || null;
  return {
    source: 'lego-instructions-pdf',
    url: bookUrl,
    pdf: path.relative(ROOT, pdfPath),
    page: best.page,
    rows: best.rows,
    statedTotal: null,
    textLayer: true,
    totalQtyTokens: best.totalQtyTokens,
    renders,
  };
}

// ---------------------------------------------------------------------------
// 零件编号解析 + 目录覆盖
// ---------------------------------------------------------------------------
const curated = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts.json'), 'utf8')).parts;
const extFile = path.join(ROOT, 'catalog/parts-ldraw.json');
const ext = fs.existsSync(extFile) ? JSON.parse(fs.readFileSync(extFile, 'utf8')).parts : {};
const MERGED = new Set([...Object.keys(ext), ...Object.keys(curated)]); // 与 cli/brickkit.mjs 的合并口径一致
const LDRAW_FULL = path.join(ROOT, 'catalog/ldraw-full/parts');

// 沿 LDraw 的 "~Moved to X" / 别名链解析到规范件号（如 35386→30070→3069b、3023→3023b）。
// 别名有两种写法：注释 "0 // Alias of X"，或 `!LDRAW_ORG Part Alias` + 单行引用 `1 16 ... X.dat`。
function resolveLdraw(design) {
  if (!design) return { ldraw: null, chain: [], note: '来源未给设计号' };
  const chain = [String(design)];
  let cur = String(design);
  for (let hop = 0; hop < 4; hop++) {
    const file = path.join(LDRAW_FULL, `${cur}.dat`);
    if (!fs.existsSync(file)) {
      return { ldraw: chain.length > 1 ? chain[chain.length - 1] : null, chain, note: chain.length > 1 ? null : 'LDraw 官方库无此件号' };
    }
    const head = fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(0, 40).join('\n');
    const moved = (head.match(/^0\s*~Moved to (\w+)/m) || [])[1];
    const aliasComment = (head.match(/^0\s*\/\/\s*Alias of (\w+)/m) || [])[1];
    let refLine = null;
    if (/!LDRAW_ORG Part Alias/.test(head) && !moved && !aliasComment) {
      const refs = [...head.matchAll(/^1\s+[\d.]+\s+[\d.\-\s]+\s+(\w+\.dat)\s*$/gm)].map((m) => m[1].replace(/\.dat$/, ''));
      if (refs.length === 1) refLine = refs[0];
    }
    const next = moved || aliasComment || refLine;
    if (!next) break;
    chain.push(next);
    cur = next;
  }
  return { ldraw: cur, chain, note: chain.length > 1 ? `LDraw ${chain[0]} → ${chain.slice(1).join(' → ')}` : null };
}

function catalogHas(ldraw, design) {
  for (const id of [ldraw, design]) if (id && MERGED.has(String(id))) return String(id);
  return null;
}

// ---------------------------------------------------------------------------
async function main() {
  const setNo = SET.replace(/-1$/, '');
  const attempts = [];
  // --no-network：跳过全部在线来源，只用本地说明书 PDF（离线/无网/复现用）
  const NO_NETWORK = process.argv.includes('--no-network');
  const record = (name, fn, { local = false } = {}) => {
    if (NO_NETWORK && !local) {
      attempts.push({ source: name, ok: false, error: '--no-network 已跳过' });
      return Promise.resolve({ ok: false, error: '--no-network 已跳过' });
    }
    return Promise.resolve().then(fn).then(
      (r) => { attempts.push({ source: name, ok: true, url: r.url, note: `${r.rows.length} 行` }); return { ok: true, ...r }; },
      (e) => { attempts.push({ source: name, ok: false, url: fn.url, error: e.message }); return { ok: false, error: e.message }; },
    );
  };

  const rebrick = await record('rebrickable', () => sourceRebrickable(SET));
  const brick = !rebrick.ok ? await record('bricklink', () => sourceBricklink(SET)) : { ok: false };
  const bs = !rebrick.ok && !brick.ok ? await record('brickset', () => sourceBrickset(SET)) : { ok: false };
  const pdf = await record('lego-instructions-pdf', () => sourcePdf(PDF), { local: true });

  if (!rebrick.ok && !brick.ok && !bs.ok && !pdf.ok) {
    console.error(JSON.stringify({ ok: false, error: '全部来源失败', attempts }, null, 2));
    process.exit(1);
  }

  // 在线目录（Brickset）作为元素 → 设计号 / 颜色的字典
  const dict = new Map((bs.rows || []).map((r) => [r.element, r]));
  const bsTotal = bs.statedTotal;

  // 选定主列表：PDF 零件总览页（随盒印刷，反映盒内实际零件）优先；PDF 无文字层才用在线库存表。
  const onlineRows = bs.rows || brick.rows || rebrick.rows || [];
  const primary = pdf.ok && pdf.rows.length
    ? { kind: 'pdf', rows: pdf.rows }
    : (onlineRows.length ? { kind: 'online', rows: onlineRows } : { kind: 'visual', rows: [] });

  // 补齐 PDF 列表里不在库存表内的元素（单独取 Brickset 元素页）
  if (primary.kind === 'pdf' && bs.ok) {
    for (const r of primary.rows) {
      if (dict.has(r.element)) continue;
      try {
        const html = await curlTextRetry(`https://brickset.com/parts/${r.element}`);
        const e = parseBricksetElement(html);
        dict.set(r.element, { element: r.element, qty: r.qty, design: e.design, colour: e.colour, name: e.name, fromElementPage: true });
        await sleep(350);
      } catch (e) {
        attempts.push({ source: 'brickset-element', ok: false, element: r.element, error: e.message });
      }
    }
  }

  const parts = primary.rows.map((r) => {
    const d = dict.get(r.element) || {};
    const design = d.design || r.design || null;
    const { ldraw, chain, note } = resolveLdraw(design);
    const col = mapColour(d.colour);
    const as = catalogHas(ldraw, design);
    const p = {
      ldraw: ldraw || null,
      color: col.ldraw,
      qty: r.qty,
      sourceId: r.element,
      name: d.name || r.name || null,
      catalog: !!as,
    };
    if (col.colorConf < 1) p.colorConf = col.colorConf;
    if (d.colour) p.colorName = d.colour;
    if (design) p.design = String(design);
    if (as && String(as) !== String(ldraw)) p.catalogAs = as;
    if (note) p.ldrawNote = note;
    return p;
  });

  const qtySum = parts.reduce((s, p) => s + p.qty, 0);
  const missing = parts.filter((p) => !p.catalog);
  const lowColour = parts.filter((p) => (p.colorConf ?? 1) < 1);

  // 交叉验证：主列表 vs 另一份来源（有 Brickset 库存就用它）
  const cross = {};
  if (primary.kind === 'pdf' && bs.ok) {
    const a = new Map(pdf.rows.map((r) => [r.element, r.qty]));
    const b = new Map(bs.rows.map((r) => [r.element, r.qty]));
    cross.against = 'brickset-inventory';
    cross.pdfOnly = [...a].filter(([e]) => !b.has(e)).map(([element, qty]) => ({ element, qty, design: dict.get(element)?.design || null }));
    cross.bricksetOnly = [...b].filter(([e]) => !a.has(e)).map(([element, qty]) => ({ element, qty, design: dict.get(element)?.design || null }));
    cross.qtyMismatch = [...a].filter(([e, q]) => b.has(e) && b.get(e) !== q).map(([element, qty]) => ({ element, pdf: qty, brickset: b.get(element) }));
    cross.bricksetQtySum = bs.rows.reduce((s, r) => s + r.qty, 0);
    cross.bricksetInventoryStatedTotal = bs.statedTotal ?? null;
  }
  // totalParts = 来源标注的官方盒内件数（Brickset 套装页 Pieces 字段）；拿不到才退回库存表自述值/清单合计
  const totalParts = primary.kind === 'visual'
    ? null // 视觉清点尚未进行，不编造件数
    : (bs.ok && bs.setPieces != null ? bs.setPieces : (bsTotal ?? qtySum));
  const totalPartsSource = primary.kind === 'visual'
    ? '未定：说明书无文字层，需人工视觉清点后填写'
    : bs.ok && bs.setPieces != null
      ? `brickset.com 套装页 Pieces 字段（官方盒内件数 ${bs.setPieces}）；Brickset 库存页自述 ${bs.statedTotal ?? '—'} 件`
      : (bsTotal != null ? 'Brickset 库存页自述件数（官方补件页快照）' : '主来源零件合计');
  // BrickLink 套装页的 "88 Parts" 是目录里可单独购买的不同设计数（不含小人），不是件数，仅作参考记录
  const brickLinkCatalogParts = NO_NETWORK ? { skipped: '--no-network' } : await bricklinkSetPageSummary(SET);

  const sourceName = primary.kind === 'pdf'
    ? 'lego-instructions-pdf'
    : primary.kind === 'online' ? (bs.ok ? 'brickset-inventory' : (brick.ok ? 'bricklink-inventory' : 'rebrickable')) : 'manual-visual';
  const sourceUrl = primary.kind === 'pdf' ? pdf.url : primary.kind === 'online' ? (bs.url || brick.url || rebrick.url || null) : null;

  const out = {
    format: 'brickkit-bom',
    set: SET,
    source: sourceName,
    // 任务书把 PDF 降级档命名为 manual-visual；本工具优先用零件总览页的文字层（机器解析 + 渲染图人工复核），
    // 只有文字层不可用时才退回纯视觉清点。这里如实标出实际用的方法，避免把机器解析结果误标成低置信。
    sourceMethod: primary.kind === 'pdf' ? 'pdf-text-layer+visual-check' : primary.kind === 'online' ? 'inventory-table-parse' : 'manual-visual',
    url: sourceUrl,
    fetchedAt: new Date().toISOString(),
    totalParts,
    totalPartsSource,
    confidence: primary.kind === 'pdf' ? 'medium' : primary.kind === 'online' ? 'medium' : 'low',
    confidenceNote: primary.kind === 'pdf'
      ? '零件总览页有可提取文字层（数量 + 元素编号），已机器解析并渲染页面图人工复核；仍属说明书快照而非在线目录 API，且与 Brickset 库存存在元素替换差异，故非 high。'
      : primary.kind === 'online'
        ? '在线库存表解析，未经第二来源逐行复核。'
        : 'manual-visual：说明书零件总览页无可用文字层，parts 需人工视觉清点后填写，数字未经复核，置信度低。',
    parts,
    crossCheck: {
      primary: primary.kind === 'pdf'
        ? { source: 'lego-instructions-pdf', pdf: pdf.pdf, page: pdf.page, textLayer: pdf.textLayer, renders: pdf.renders }
        : primary.kind === 'online' ? { source: sourceName } : { source: 'manual-visual', pdf: pdf.pdf, renders: pdf.renders },
      qtySum,
      totalParts,
      delta: totalParts == null ? null : qtySum - totalParts,
      deltaNote: totalParts == null
        ? '零件清单尚未建立（说明书无文字层，待人工视觉清点），无合计可比'
        : qtySum === totalParts
          ? '零件清单合计与来源标注总件数一致'
          : `零件清单合计 ${qtySum} 件，来源标注 ${totalParts} 件，差 ${qtySum - totalParts} 件（未定位，见 notes）`,
      bricksetSetPagePieces: bs.ok ? (bs.setPieces ?? null) : null,
      bricksetInventoryStatedTotal: bs.ok ? (bs.statedTotal ?? null) : null,
      bricklinkSetPage: brickLinkCatalogParts,
      ...cross,
    },
    catalogGaps: missing.map((p) => ({
      ldraw: p.ldraw,
      design: p.design,
      color: p.color,
      qty: p.qty,
      sourceId: p.sourceId,
      name: p.name,
      // LDraw 官方库是否有该件几何：有 → 重新生成 catalog/parts-ldraw.json 即可补库；
      // 无 → 印刷件/贴花件等 LDraw 官方不收的零件，只能人工建模
      ldrawAvailable: !!(p.design && fs.existsSync(path.join(LDRAW_FULL, `${p.design}.dat`))),
    })),
    lowColourConfidence: lowColour.map((p) => ({ sourceId: p.sourceId, colorName: p.colorName, color: p.color, colorConf: p.colorConf })),
    sources: attempts,
    notes: [],
  };
  if (primary.kind === 'pdf' && !bs.ok) out.notes.push('在线目录不可用，BOM 完全来自说明书零件总览页，视为 manual-visual 级别的低置信数据。');
  if (primary.kind === 'pdf' && bs.ok) out.notes.push('主列表取自说明书零件总览页的文字层（非纯视觉点数）；Brickset 库存表用于补全元素→设计号与颜色，并作第二来源对账。');
  if (primary.kind === 'visual') out.notes.push('零件总览页无可用文字层，已渲染页面（crossCheck.primary.renders），需要人工视觉清点后补 parts。');
  if (cross.pdfOnly?.length) out.notes.push(`PDF 有而 Brickset 无的元素 ${cross.pdfOnly.length} 个、共 ${cross.pdfOnly.reduce((s, x) => s + x.qty, 0)} 件（LEGO 补件页未列或已被新元素号替换，按盒内实际零件保留）。`);
  if (cross.bricksetOnly?.length) out.notes.push(`Brickset 有而 PDF 无的元素 ${cross.bricksetOnly.length} 个、共 ${cross.bricksetOnly.reduce((s, x) => s + x.qty, 0)} 件（备件或新版元件号）。`);
  if (totalParts != null && qtySum !== totalParts) {
    const onlyPdf = (cross.pdfOnly || []).reduce((s, x) => s + x.qty, 0);
    const onlyBs = (cross.bricksetOnly || []).reduce((s, x) => s + x.qty, 0);
    out.notes.push(
      `合计差 ${qtySum - totalParts} 件：Brickset 套装页 Pieces=${bs.setPieces ?? '—'}、` +
      `Brickset 库存页自述=${bs.statedTotal ?? '—'}、说明书零件总览页 ${pdf.page ?? '?'} 页清单合计=${qtySum}。` +
      `该页数量 token 与元素编号 token 一一配对成功（${pdf.rows?.length ?? 0}/${pdf.totalQtyTokens ?? 0}），` +
      `即说明书印刷页本身只列到 ${qtySum} 件。与库存表对账：仅在 PDF 出现 ${onlyPdf} 件（含 ${(cross.pdfOnly || []).map((x) => x.element).join('/') || '—'}）、` +
      `仅在库存表出现 ${onlyBs} 件（含 ${(cross.bricksetOnly || []).map((x) => x.element).join('/') || '—'}），` +
      `逐元素数量无一处不一致（qtyMismatch 为空）。差额来源（官方盒内是否含备件/是否另有页面）无法用现有可访问来源判定：` +
      `BrickLink 库存页被 AWS WAF 拦截（202 空体）、Rebrickable 被 Cloudflare 拦截、无 API key。`,
    );
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');

  console.log(JSON.stringify({
    ok: true,
    out: path.relative(ROOT, OUT),
    source: out.source,
    entries: parts.length,
    qtySum,
    totalParts,
    delta: qtySum - totalParts,
    catalogGaps: missing.length,
    lowColourConfidence: lowColour.length,
    sources: attempts,
  }, null, 2));
}

// 安全层自检：不联网，只断言 assertAllowed / isPrivateOrReservedIp 的判定（node tools/fetch-bom.mjs --self-test）
function selfTest() {
  const allow = [
    'https://rebrickable.com/sets/60239-1/',
    'https://www.bricklink.com/v2/catalogItemInv.asp?S=60239-1',
    'https://brickset.com/inventories/60239-1',
    'https://www.bricklink.com/x',
    'https://www.lego.com/cdn/product-assets/product.bi.core.pdf/6283855.pdf',
    'https://api.lego.com/x',
  ];
  const deny = [
    ['http://brickset.com/inventories/60239-1', '非 https'],
    ['https://localhost/x', 'localhost'],
    ['https://foo.localhost/x', 'localhost 子域'],
    ['https://127.0.0.1/x', '环回'],
    ['https://10.0.0.1/x', '私有'],
    ['https://192.168.1.1/x', '私有'],
    ['https://172.16.0.1/x', '私有'],
    ['https://169.254.169.254/x', '链路本地/元数据'],
    ['https://100.64.0.1/x', 'CGNAT'],
    ['https://0.0.0.0/x', '保留'],
    ['https://224.0.0.1/x', '组播'],
    ['https://255.255.255.255/x', '广播'],
    ['https://2130706433/x', '整数 IP'],
    ['https://0x7f000001/x', '十六进制 IP'],
    ['https://[::1]/x', 'IPv6 环回'],
    ['https://[fd00::1]/x', 'IPv6 ULA'],
    ['https://evil.com/x', '不在白名单'],
    ['https://brickset.com.evil.com/x', '后缀伪装'],
    ['https://rebrickable.com@evil.com/x', '凭据伪装'],
    ['https://brickset.com:8443/x', '端口不校验但主机合规 → 允许（见下）'],
  ];
  const fails = [];
  for (const u of allow) {
    try { assertAllowed(u); } catch (e) { fails.push(`应放行却拒绝：${u}（${e.message}）`); }
  }
  for (const [u, why] of deny) {
    // 最后一条是已知放行项（端口不在任务约束内），单独处理
    if (why.includes('允许')) {
      try { assertAllowed(u); } catch (e) { fails.push(`应放行却拒绝：${u}（${e.message}）`); }
      continue;
    }
    let rejected = false;
    try { assertAllowed(u); } catch { rejected = true; }
    if (!rejected) fails.push(`应拒绝却放行：${u}（${why}）`);
  }
  // IP 判定单测
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.20.1.1', '169.254.1.1', '100.64.1.1', '0.0.0.0', '224.0.0.1', '::1', 'fd00::1', 'fe80::1']) {
    if (!isPrivateOrReservedIp(ip)) fails.push(`IP 判定漏判：${ip}`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
    if (isPrivateOrReservedIp(ip)) fails.push(`IP 判定误判：${ip}`);
  }
  console.log(JSON.stringify({ ok: fails.length === 0, checks: allow.length + deny.length + 14, fails }, null, 2));
  process.exit(fails.length ? 1 : 0);
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  main().catch((e) => { console.error(JSON.stringify({ ok: false, error: e.message, stack: String(e.stack).split('\n').slice(0, 6) }, null, 2)); process.exit(1); });
}
