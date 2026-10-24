// 打包成单个自包含 HTML：dist/viewer.html
import * as esbuild from 'esbuild';
import fs from 'fs';
const r = await esbuild.build({ entryPoints: ['src/viewer/main.js'], bundle: true, minify: true, format: 'iife', write: false, target: 'es2020', loader: { '.json': 'json' }, legalComments: 'none' });
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync('src/viewer/style.css', 'utf8');
const html = fs.readFileSync('src/viewer/template.html', 'utf8').replace('/*CSS*/', () => css).replace('//JS', () => js);
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/viewer.html', html);
console.log('dist/viewer.html', (html.length / 1024).toFixed(0) + ' KB');
