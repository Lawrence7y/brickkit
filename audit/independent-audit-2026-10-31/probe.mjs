// Independent Real Mesh Quality Audit Probe
// Created for rigorous, bug-free verification of real mesh geometry in BrickKit.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  refCandidates, safeJoin,
  STUD_PRIMITIVES, ANTISTUD_PRIMITIVES, PIN_HOLE_PRIMITIVES, AXLE_HOLE_PRIMITIVES,
  PIN_PRIMITIVES, BAR_PRIMITIVES, CLIP_PRIMITIVES, WPIN_PRIMITIVES, OFFICIAL_ALIASES
} from '../../src/ldraw/ldraw.js';

import {
  mergeCatalogParts, partConnectors, partBoxes, partsConnected,
  boxesCollide, connectorPairMatches, PLATE
} from '../../src/core/core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CUR = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts.json'), 'utf8')).parts;
const EXT = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts-ldraw.json'), 'utf8')).parts;
const MERGED = mergeCatalogParts(EXT, CUR);

const LDRAW_DIRS = [
  path.join(ROOT, 'catalog/ldraw'),
  path.join(ROOT, 'catalog/ldraw-full')
];

export function resolveDat(raw) {
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

export function parseLDrawTree(text, resolveFn, maxDepth = 12) {
  const vertices = [];
  const primitives = [];
  let bfcCertify = null;
  let inlineTriangles = 0;
  let inlineQuads = 0;
  let subfileCount = 0;

  function walk(txt, M, t, depth, stack) {
    if (depth > maxDepth) return;
    const lines = txt.split(/\r?\n/);
    for (const raw of lines) {
      const trim = raw.trim();
      if (!trim) continue;
      if (depth === 0 && trim.startsWith('0 BFC CERTIFY')) {
        bfcCertify = trim.includes('CCW') ? 'CCW' : (trim.includes('CW') ? 'CW' : 'UNKNOWN');
      }
      const tok = trim.split(/\s+/);
      const type = Number(tok[0]);
      if (type === 1 && tok.length >= 15) {
        subfileCount++;
        const sub = tok.slice(14).join(' ');
        const subRes = resolveFn(sub);
        const normKey = path.basename(sub).toLowerCase(); // KEEP .dat extension!
        const m = [+tok[5], +tok[6], +tok[7], +tok[8], +tok[9], +tok[10], +tok[11], +tok[12], +tok[13]];
        const pos = apply3(M, t, [+tok[2], +tok[3], +tok[4]]);
        const MM = mul3(M, m);

        primitives.push({
          file: sub,
          normKey,
          pos,
          yUp: MM[4],
          matrix: MM,
          depth
        });

        if (subRes && !stack.has(normKey)) {
          walk(subRes.text, MM, pos, depth + 1, new Set([...stack, normKey]));
        }
      } else if (type === 3) {
        inlineTriangles++;
        if (tok.length >= 11) {
          vertices.push(apply3(M, t, [+tok[2], +tok[3], +tok[4]]));
          vertices.push(apply3(M, t, [+tok[5], +tok[6], +tok[7]]));
          vertices.push(apply3(M, t, [+tok[8], +tok[9], +tok[10]]));
        }
      } else if (type === 4) {
        inlineQuads++;
        if (tok.length >= 14) {
          vertices.push(apply3(M, t, [+tok[2], +tok[3], +tok[4]]));
          vertices.push(apply3(M, t, [+tok[5], +tok[6], +tok[7]]));
          vertices.push(apply3(M, t, [+tok[8], +tok[9], +tok[10]]));
          vertices.push(apply3(M, t, [+tok[11], +tok[12], +tok[13]]));
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
    bfcCertify,
    inlineTriangles,
    inlineQuads,
    subfileCount,
    verticesCount: vertices.length,
    primitives,
    bbox: vertices.length ? {
      min, max,
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
    } : null
  };
}

export function inspectPart(partId) {
  const official = OFFICIAL_ALIASES[partId] || partId;
  const res = resolveDat(`${official}.dat`);
  if (!res) return { partId, official, found: false };

  const parsed = parseLDrawTree(res.text, resolveDat);
  const def = MERGED[partId] || CUR[partId] || EXT[partId] || {};
  const curDef = CUR[partId] || null;
  const extDef = EXT[partId] || null;

  // Filter primitives with PROPER .dat matching
  const studs = parsed.primitives.filter(p => STUD_PRIMITIVES.has(p.normKey));
  const antistuds = parsed.primitives.filter(p => ANTISTUD_PRIMITIVES.has(p.normKey));
  const clips = parsed.primitives.filter(p => CLIP_PRIMITIVES.has(p.normKey));
  const bars = parsed.primitives.filter(p => BAR_PRIMITIVES.has(p.normKey));
  const pins = parsed.primitives.filter(p => PIN_PRIMITIVES.has(p.normKey) || WPIN_PRIMITIVES.has(p.normKey));
  const pinHoles = parsed.primitives.filter(p => PIN_HOLE_PRIMITIVES.has(p.normKey));
  const axleHoles = parsed.primitives.filter(p => AXLE_HOLE_PRIMITIVES.has(p.normKey));

  // Also check ball and socket primitives
  const balls = parsed.primitives.filter(p => p.normKey.includes('joint8ball') || p.normKey.includes('ball'));
  const sockets = parsed.primitives.filter(p => p.normKey.includes('joint8socket') || p.normKey.includes('socket'));

  // Core connectors
  const fakePart = { id: '_p', part: partId, color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 };
  let coreConn = null, coreConnErr = null;
  try {
    coreConn = partConnectors(fakePart, def);
  } catch (e) {
    coreConnErr = e.message;
  }

  // Core boxes
  let coreBoxes = null, coreBoxesErr = null;
  try {
    coreBoxes = partBoxes(fakePart, def);
  } catch (e) {
    coreBoxesErr = e.message;
  }

  return {
    partId,
    official,
    found: true,
    file: path.relative(ROOT, res.file),
    curDef,
    extDef,
    mergedDef: def,
    geometry: {
      bfcCertify: parsed.bfcCertify,
      inlineTriangles: parsed.inlineTriangles,
      inlineQuads: parsed.inlineQuads,
      subfileCount: parsed.subfileCount,
      bboxLdu: parsed.bbox,
      primitives: {
        total: parsed.primitives.length,
        studs,
        antistuds,
        clips,
        bars,
        pins,
        pinHoles,
        axleHoles,
        balls,
        sockets
      }
    },
    core: {
      connectors: coreConn,
      connError: coreConnErr,
      boxes: coreBoxes,
      boxError: coreBoxesErr
    }
  };
}
