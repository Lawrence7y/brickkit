// Deep investigation probe for real mesh quality audit
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Import from project
import {
  refCandidates, safeJoin, connectorInstancesFromText, bboxFromText,
  STUD_PRIMITIVES, ANTISTUD_PRIMITIVES, PIN_HOLE_PRIMITIVES, AXLE_HOLE_PRIMITIVES,
  PIN_PRIMITIVES, BAR_PRIMITIVES, CLIP_PRIMITIVES, WPIN_PRIMITIVES, OFFICIAL_ALIASES
} from '../../src/ldraw/ldraw.js';
import { mergeCatalogParts, partConnectors, partBoxes, partCenter, boxesCollide, partsConnected } from '../../src/core/core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CUR = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts.json'), 'utf8')).parts;
const EXT = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts-ldraw.json'), 'utf8')).parts;
const MERGED = mergeCatalogParts(EXT, CUR);

const LDRAW_DIRS = [
  path.join(ROOT, 'catalog/ldraw'),
  path.join(ROOT, 'catalog/ldraw-full')
];

function resolveDat(raw) {
  const norm = String(raw).trim().toLowerCase().replace(/\\/g, '/').replace(/^\.\//, '');
  for (const cand of refCandidates(norm)) {
    for (const dir of LDRAW_DIRS) {
      const f = safeJoin(dir, cand);
      if (f && fs.existsSync(f)) {
        return { file: f, text: fs.readFileSync(f, 'utf8') };
      }
    }
  }
  return null;
}

// Parse top lines and subfiles of a dat file
export function inspectDat(partId) {
  const official = OFFICIAL_ALIASES[partId] || partId;
  const res = resolveDat(`${official}.dat`);
  if (!res) return { partId, official, found: false };

  const lines = res.text.split(/\r?\n/);
  const title = lines[0] ? lines[0].replace(/^0\s*/, '').trim() : '';
  const subfiles = [];
  let inlineTriangles = 0;
  let inlineQuads = 0;
  let linesCount = 0;

  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith('1 ')) {
      const tok = t.split(/\s+/);
      if (tok.length >= 15) {
        subfiles.push({
          color: tok[1],
          pos: [+tok[2], +tok[3], +tok[4]],
          matrix: tok.slice(5, 14).map(Number),
          file: tok.slice(14).join(' ')
        });
      }
    } else if (t.startsWith('3 ')) {
      inlineTriangles++;
    } else if (t.startsWith('4 ')) {
      inlineQuads++;
    } else if (t.startsWith('2 ')) {
      linesCount++;
    }
  }

  return {
    partId,
    official,
    found: true,
    file: path.relative(ROOT, res.file),
    title,
    subfilesCount: subfiles.length,
    subfiles: subfiles.slice(0, 20),
    inlineTriangles,
    inlineQuads,
    linesCount,
    text: res.text
  };
}

// Independent leaf collector
export function collectAllGeometry(text, resolveFn, maxDepth = 12) {
  const vertices = [];
  const primitives = [];

  function mul3(A, B) {
    return [0, 1, 2].flatMap(r => [0, 1, 2].map(c => A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]));
  }
  function apply3(M, t, p) {
    return [
      M[0] * p[0] + M[1] * p[1] + M[2] * p[2] + t[0],
      M[3] * p[0] + M[4] * p[1] + M[5] * p[2] + t[1],
      M[6] * p[0] + M[7] * p[1] + M[8] * p[2] + t[2]
    ];
  }

  function walk(txt, M, t, depth, stack) {
    if (depth > maxDepth) return;
    for (const raw of txt.split(/\r?\n/)) {
      const tok = raw.trim().split(/\s+/);
      const type = Number(tok[0]);
      if (type === 1 && tok.length >= 15) {
        const sub = tok.slice(14).join(' ');
        const subRes = resolveFn(sub);
        if (!subRes) continue;
        const key = sub.toLowerCase().replace(/\\/g, '/');
        if (stack.has(key)) continue;

        const m = [+tok[5], +tok[6], +tok[7], +tok[8], +tok[9], +tok[10], +tok[11], +tok[12], +tok[13]];
        const pos = apply3(M, t, [+tok[2], +tok[3], +tok[4]]);
        const MM = mul3(M, m);

        const base = path.basename(key, '.dat');
        primitives.push({
          file: sub,
          base,
          pos,
          yUp: MM[4],
          matrix: MM
        });

        walk(subRes.text, MM, pos, depth + 1, new Set([...stack, key]));
      } else if (type === 3 || type === 4) {
        const n = type === 3 ? 3 : 4;
        if (tok.length < 2 + n * 3) continue;
        for (let k = 0; k < n; k++) {
          const p = [+tok[2 + k * 3], +tok[3 + k * 3], +tok[4 + k * 3]];
          if (p.every(Number.isFinite)) {
            vertices.push(apply3(M, t, p));
          }
        }
      }
    }
  }

  walk(text, [1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0], 0, new Set());

  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const v of vertices) {
    for (let i = 0; i < 3; i++) {
      if (v[i] < min[i]) min[i] = v[i];
      if (v[i] > max[i]) max[i] = v[i];
    }
  }

  return {
    vertexCount: vertices.length,
    primitives,
    bboxLdu: vertices.length ? { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] } : null
  };
}

// Deep audit of a single part
export function auditPart(partId) {
  const info = inspectDat(partId);
  if (!info.found) {
    return { partId, error: 'DAT_NOT_FOUND' };
  }

  const def = MERGED[partId] || {};
  const curDef = CUR[partId] || null;
  const extDef = EXT[partId] || null;

  const geom = collectAllGeometry(info.text, resolveDat);

  // Independent measurement of studs, clips, bars, pins, antistuds
  const studs = geom.primitives.filter(p => STUD_PRIMITIVES.has(p.base));
  const antistuds = geom.primitives.filter(p => ANTISTUD_PRIMITIVES.has(p.base));
  const clips = geom.primitives.filter(p => CLIP_PRIMITIVES.has(p.base));
  const bars = geom.primitives.filter(p => BAR_PRIMITIVES.has(p.base));
  const pins = geom.primitives.filter(p => PIN_PRIMITIVES.has(p.base) || WPIN_PRIMITIVES.has(p.base));
  const pinHoles = geom.primitives.filter(p => PIN_HOLE_PRIMITIVES.has(p.base));
  const axleHoles = geom.primitives.filter(p => AXLE_HOLE_PRIMITIVES.has(p.base));

  // Compute connectors from core
  const fakePart = { id: 'p', part: partId, color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 };
  let coreConn = null;
  let coreConnError = null;
  try {
    coreConn = partConnectors(fakePart, def);
  } catch (e) {
    coreConnError = e.message;
  }

  // Compute boxes from core
  let coreBoxes = null;
  let coreBoxesError = null;
  try {
    coreBoxes = partBoxes(fakePart, def);
  } catch (e) {
    coreBoxesError = e.message;
  }

  return {
    partId,
    official: info.official,
    title: info.title,
    curDef,
    extDef,
    mergedDef: def,
    bboxLdu: geom.bboxLdu,
    primitives: {
      total: geom.primitives.length,
      studs: studs.map(s => ({ pos: s.pos, yUp: s.yUp, base: s.base })),
      antistuds: antistuds.map(s => ({ pos: s.pos, yUp: s.yUp, base: s.base })),
      clips: clips.map(s => ({ pos: s.pos, yUp: s.yUp, base: s.base })),
      bars: bars.map(s => ({ pos: s.pos, yUp: s.yUp, base: s.base })),
      pins: pins.map(s => ({ pos: s.pos, yUp: s.yUp, base: s.base })),
      pinHoles: pinHoles.map(s => ({ pos: s.pos, yUp: s.yUp, base: s.base })),
      axleHoles: axleHoles.map(s => ({ pos: s.pos, yUp: s.yUp, base: s.base }))
    },
    coreConn: coreConn ? {
      studsCount: coreConn.studs.length,
      receptorsCount: coreConn.receptors.length,
      studs: coreConn.studs,
      receptors: coreConn.receptors
    } : { error: coreConnError },
    coreBoxes: coreBoxes ? {
      count: coreBoxes.length,
      boxes: coreBoxes
    } : { error: coreBoxesError }
  };
}

// Test runner for specific groups
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const parts = process.argv.slice(2);
  const targets = parts.length ? parts : ['15712', '30374', '4274', '584', '60623', '87994'];
  for (const id of targets) {
    console.log(`\n========== AUDITING PART: ${id} ==========`);
    const res = auditPart(id);
    console.log(JSON.stringify(res, null, 2));
  }
}
