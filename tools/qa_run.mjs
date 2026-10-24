import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QA = path.join(ROOT, 'qa'); fs.mkdirSync(QA, { recursive: true });
const EXE = process.env.CHROMIUM_PATH || ['/usr/local/bin/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: EXE, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const url = 'file://' + path.join(ROOT, 'dist/viewer.html');
const only = process.argv[2];
async function shot(name, { w = 1440, h = 900, act, el, hash = '' } = {}) {
  if (only && !name.startsWith(only)) return;
  const page = await browser.newPage({ viewport: { width: w, height: h }, reducedMotion: 'reduce' });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errs.push(m.text()));
  await page.goto(url + hash); await page.waitForTimeout(1200);
  if (act) await act(page);
  await page.waitForTimeout(700);
  if (el) { await page.addStyleTag({ content: '#book-bar{position:static!important}' }); await page.locator(el).scrollIntoViewIfNeeded(); await page.locator(el).screenshot({ path: `${QA}/${name}.png` }); }
  else await page.screenshot({ path: `${QA}/${name}.png` });
  if (errs.length) console.log(name, 'ERR', errs.slice(0, 5));
  await page.close();
}
const book = async (p) => { await p.click('[data-mode="book"]'); await p.waitForFunction(() => window.__bookReady === true, null, { timeout: 240000 }); };
await shot('d1_default');
await shot('d2_layer', { act: async (p) => { await p.click('[data-emode="layer"]'); await p.fill('#explode', '100'); await p.dispatchEvent('#explode', 'input'); } });
await shot('d3_module', { act: async (p) => { await p.click('[data-emode="module"]'); await p.fill('#explode', '100'); await p.dispatchEvent('#explode', 'input'); await p.click('[data-mod="door"]'); } });
await shot('d4_sub', { act: async (p) => { await p.click('#first'); for (let i = 0; i < 11; i++) await p.click('#next'); } });
await shot('d5_attach', { act: async (p) => { await p.click('#first'); for (let i = 0; i < 14; i++) await p.click('#next'); } });
await shot('d6_mech', { act: async (p) => { await p.click('[data-mech="0"]'); await p.click('[data-mech="1"]'); await p.click('#data-sec summary'); } });
await shot('m1_mobile', { w: 390, h: 844 });
await shot('b0_bar', { act: book });
for (const [n, i] of [['b1_cover', 1], ['b2_step', 5], ['b3_step', 9], ['b4_sub', 12], ['b5_attach', 16], ['b6_mech', 17], ['b7_inv', 18]]) await shot(n, { act: book, el: `#pages .page:nth-child(${i})` });
await shot('m2_book', { w: 390, h: 844, act: book });
await shot('m3_bookstep', { w: 390, h: 844, act: book, el: '#pages .page:nth-child(13)' });
await shot('m4_inv', { w: 390, h: 844, act: book, el: '#pages .page:nth-child(18)' });
await browser.close();
