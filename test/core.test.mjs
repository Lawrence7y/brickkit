import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FORMAT,
  VERSION,
  PLATE,
  rotXZ,
  rotatedSize,
  partCenter,
  localCells,
  footprint,
  topLayer,
  partBoxes,
  boxesCollide,
  partConnectors,
  partsConnected,
  snapPart,
  partModule,
  moduleMap,
  subOfModule,
  moduleChain,
  stepPlan,
  validate,
  bom,
  ldrawLine,
  ldrawExt,
  toLDraw,
  PHOTO_SLOTS,
  checkPhotos,
} from '../src/core/core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const cat = {
  parts: readJSON('catalog/parts.json').parts,
  colors: readJSON('catalog/colors.json').colors,
};

/** 构造一个最小合法模型（带 1 块 2×4 底砖在 0 层） */
function baseModel(overrides = {}) {
  return {
    format: FORMAT,
    version: VERSION,
    meta: { name: '测试模型', front: '+z' },
    steps: [{ n: 1, title: '底座' }],
    modules: [{ id: 'base', label: '底座', explode: [0, 0, 0] }],
    parts: [
      {
        id: 'p1',
        part: '3001',
        color: 4,
        at: [0, 0, 0],
        rot: 0,
        step: 1,
        module: 'base',
        status: 'confirmed',
        evidence: ['ext_a000_e30'],
      },
    ],
    mechanisms: [],
    ...overrides,
  };
}

/** 构造一个完整的合法照片集 */
function fullPhotoSet(overrides = {}) {
  const photos = [
    ...[0, 45, 90, 135, 180, 225, 270, 315].map((az) => ({
      id: `ext_a${String(az).padStart(3, '0')}_e30`,
      file: `ext_a${String(az).padStart(3, '0')}_e30.jpg`,
      kind: 'exterior',
      azimuth: az,
      elevation: 30,
      state: 'closed',
      width: 4032,
      height: 3024,
    })),
    ...[0, 90, 180, 270].map((az) => ({
      id: `ext_a${String(az).padStart(3, '0')}_e00`,
      file: `ext_a${String(az).padStart(3, '0')}_e00.jpg`,
      kind: 'exterior',
      azimuth: az,
      elevation: 0,
      state: 'closed',
      width: 4032,
      height: 3024,
    })),
    { id: 'ext_top_e90', file: 'ext_top_e90.jpg', kind: 'exterior', azimuth: 0, elevation: 85, state: 'closed', width: 4032, height: 3024 },
    { id: 'ext_bottom', file: 'ext_bottom.jpg', kind: 'bottom', elevation: -90, state: 'closed', width: 4032, height: 3024 },
    { id: 'detail_1', file: 'detail_1.jpg', kind: 'detail', width: 4032, height: 3024 },
  ];
  return {
    format: 'brickbuild-photos',
    version: VERSION,
    capture: { reference: '8mm 方格纸', frontMarker: '红色胶带' },
    mechanisms: [],
    skipped: [],
    photos,
    ...overrides,
  };
}

const codesOf = (list) => list.map((x) => x.code);

test('坐标换算与占地计算：rotXZ、rotatedSize、partCenter、localCells、footprint、topLayer', () => {
  assert.equal(PLATE, 0.4);
  assert.deepEqual(rotXZ(1, 0, 0), [1, 0]);
  assert.deepEqual(rotXZ(1, 0, 90), [0, -1]);
  assert.deepEqual(rotXZ(1, 0, 180), [-1, 0]);
  assert.deepEqual(rotXZ(1, 0, 270), [0, 1]);

  const brick2x4 = cat.parts['3001']; // size: [4, 2], h: 3
  assert.deepEqual(rotatedSize(brick2x4, 0), [4, 2]);
  assert.deepEqual(rotatedSize(brick2x4, 90), [2, 4]);
  assert.deepEqual(rotatedSize(brick2x4, 180), [4, 2]);
  assert.deepEqual(rotatedSize(brick2x4, 270), [2, 4]);

  const p0 = { id: 'p1', part: '3001', color: 4, at: [2, 3, 5], rot: 0, step: 1 };
  assert.deepEqual(partCenter(p0, brick2x4), [4, 3, 6]);
  assert.equal(topLayer(p0, brick2x4), 6);

  const p90 = { ...p0, rot: 90 };
  assert.deepEqual(partCenter(p90, brick2x4), [3, 3, 7]);

  const fp0 = footprint(p0, brick2x4);
  assert.equal(fp0.length, 8);
  assert.ok(fp0.every((c) => c.x >= 2 && c.x <= 5 && c.z >= 5 && c.z <= 6 && c.stud === true));

  const fp90 = footprint(p90, brick2x4);
  assert.equal(fp90.length, 8);
  assert.ok(fp90.every((c) => c.x >= 2 && c.x <= 3 && c.z >= 5 && c.z <= 8 && c.stud === true));

  // 斜面砖 3039（2×2 slope）：只有后排 k===0 有凸点
  const slopeCells = localCells(cat.parts['3039']);
  assert.equal(slopeCells.filter((c) => c.stud).length, 2);
  assert.equal(slopeCells.filter((c) => !c.stud).length, 2);

  // 平板 3068b（2×2 tile）：无凸点
  const tileCells = localCells(cat.parts['3068b']);
  assert.ok(tileCells.every((c) => c.stud === false));
});

test('模块链与 stepPlan：子组件、装配步、旧版 group 字段兼容', () => {
  assert.equal(partModule({ module: 'walls' }), 'walls');
  assert.equal(partModule({ group: 'legacy' }), 'legacy');
  assert.equal(partModule({}), null);

  const m = {
    format: FORMAT,
    version: VERSION,
    modules: [
      { id: 'walls', label: '墙体' },
      { id: 'door', label: '门', parent: 'walls' },
      { id: 'roof', label: '屋顶', subassembly: true },
      { id: 'chimney', label: '烟囱', parent: 'roof' },
    ],
    steps: [
      { n: 1, title: '砌墙' },
      { n: 2, title: '拼屋顶' },
      { n: 3, title: '装上屋顶', attach: 'roof' },
    ],
    parts: [
      { id: 'p1', part: '3001', color: 4, at: [0, 0, 0], step: 1, module: 'door' },
      { id: 'p2', part: '3001', color: 15, at: [0, 3, 0], step: 2, module: 'chimney' },
    ],
  };

  const mods = moduleMap(m);
  assert.deepEqual(moduleChain(mods, 'door'), ['door', 'walls']);
  assert.equal(subOfModule(mods, 'chimney'), 'roof');
  assert.equal(subOfModule(mods, 'door'), null);

  const plan = stepPlan(m);
  assert.equal(plan.steps.length, 3);
  assert.equal(plan.steps[0].sub, null);
  assert.equal(plan.steps[1].sub, 'roof');
  assert.equal(plan.steps[2].attach, 'roof');
  assert.deepEqual(plan.subs.get('roof').parts, ['p2']);
  assert.deepEqual(plan.subs.get('roof').steps, [2]);
});

test('validate：全部 26 个错误代码（每个代码均包含触发用例与不触发对照）', () => {
  // 基准合法模型不触发任何错误或警告
  const okRes = validate(baseModel(), cat, { photos: fullPhotoSet() });
  assert.equal(okRes.ok, true);
  assert.deepEqual(okRes.errors, []);
  assert.deepEqual(okRes.warnings, []);

  // 1. model
  assert.deepEqual(codesOf(validate(null, cat).errors), ['model']);
  assert.ok(!codesOf(validate(baseModel(), cat).errors).includes('model'));

  // 2. parts
  assert.deepEqual(codesOf(validate({ format: FORMAT, parts: null }, cat).errors), ['parts']);
  assert.ok(!codesOf(validate(baseModel(), cat).errors).includes('parts'));

  // 3. part
  assert.ok(codesOf(validate(baseModel({ parts: [null] }), cat).errors).includes('part'));
  assert.ok(!codesOf(validate(baseModel(), cat).errors).includes('part'));

  // 4. id
  assert.ok(codesOf(validate(baseModel({ parts: [{ part: '3001', color: 4, at: [0, 0, 0], step: 1 }] }), cat).errors).includes('id'));
  assert.ok(!codesOf(validate(baseModel(), cat).errors).includes('id'));

  // 5. id-dup
  const dupParts = [
    { id: 'p1', part: '3001', color: 4, at: [0, 0, 0], step: 1 },
    { id: 'p1', part: '3001', color: 4, at: [4, 0, 0], step: 1 },
  ];
  assert.ok(codesOf(validate(baseModel({ parts: dupParts }), cat).errors).includes('id-dup'));

  // 6. part-unknown
  assert.ok(codesOf(validate(baseModel({ parts: [{ id: 'p1', part: '999999', color: 4, at: [0, 0, 0], step: 1 }] }), cat).errors).includes('part-unknown'));

  // 7. at
  assert.ok(codesOf(validate(baseModel({ parts: [{ id: 'p1', part: '3001', color: 4, at: [0, 0.5, 0], step: 1 }] }), cat).errors).includes('at'));

  // 8. rot
  assert.ok(codesOf(validate(baseModel({ parts: [{ id: 'p1', part: '3001', color: 4, at: [0, 0, 0], rot: 45, step: 1 }] }), cat).errors).includes('rot'));

  // 9. step
  assert.ok(codesOf(validate(baseModel({ parts: [{ id: 'p1', part: '3001', color: 4, at: [0, 0, 0], step: 0 }] }), cat).errors).includes('step'));

  // 10. modules
  assert.ok(codesOf(validate(baseModel({ modules: 'invalid' }), cat).errors).includes('modules'));

  // 11. module-id（缺失与重复）
  assert.ok(codesOf(validate(baseModel({ modules: [{}] }), cat).errors).includes('module-id'));
  assert.ok(codesOf(validate(baseModel({ modules: [{ id: 'base' }, { id: 'base' }] }), cat).errors).includes('module-id'));

  // 12. module-parent
  assert.ok(codesOf(validate(baseModel({ modules: [{ id: 'base', parent: 'missing' }] }), cat).errors).includes('module-parent'));

  // 13. module-cycle
  assert.ok(
    codesOf(
      validate(
        baseModel({
          modules: [
            { id: 'base', parent: 'm2' },
            { id: 'm2', parent: 'base' },
          ],
        }),
        cat
      ).errors
    ).includes('module-cycle')
  );

  // 14. module-explode
  assert.ok(codesOf(validate(baseModel({ modules: [{ id: 'base', explode: [0, 1] }] }), cat).errors).includes('module-explode'));

  // 15. sub-attach
  assert.ok(codesOf(validate(baseModel({ modules: [{ id: 'base', subassembly: true }] }), cat).errors).includes('sub-attach'));
  assert.ok(
    !codesOf(
      validate(
        baseModel({
          modules: [{ id: 'base', subassembly: true }],
          steps: [{ n: 1 }, { n: 2, attach: 'base' }],
        }),
        cat
      ).errors
    ).includes('sub-attach')
  );

  // 16. attach（指向不存在的模块 / 指向非子组件模块）
  assert.ok(codesOf(validate(baseModel({ steps: [{ n: 1, attach: 'nope' }] }), cat).errors).includes('attach'));
  assert.ok(codesOf(validate(baseModel({ steps: [{ n: 1, attach: 'base' }] }), cat).errors).includes('attach'));

  // 17. attach-order（子组件零件步骤不早于装配步）
  assert.ok(
    codesOf(
      validate(
        baseModel({
          modules: [{ id: 'base' }, { id: 'roof', subassembly: true }],
          steps: [{ n: 1 }, { n: 2, attach: 'roof' }],
          parts: [
            { id: 'p1', part: '3001', color: 4, at: [0, 0, 0], step: 1, module: 'base' },
            { id: 'p2', part: '3001', color: 4, at: [0, 3, 0], step: 2, module: 'roof' },
          ],
        }),
        cat
      ).errors
    ).includes('attach-order')
  );

  // 18. overlap
  assert.ok(
    codesOf(
      validate(
        baseModel({
          parts: [
            { id: 'p1', part: '3001', color: 4, at: [0, 0, 0], step: 1, module: 'base' },
            { id: 'p2', part: '3001', color: 15, at: [2, 0, 0], step: 1, module: 'base' },
          ],
        }),
        cat
      ).errors
    ).includes('overlap')
  );

  // 19. mount
  assert.ok(
    codesOf(
      validate(
        baseModel({
          parts: [{ id: 'p1', part: '3001', color: 4, at: [0, 0, 0], step: 1, module: 'base', mount: 'no_such_part' }],
        }),
        cat
      ).errors
    ).includes('mount')
  );

  // 20. floating
  assert.ok(
    codesOf(
      validate(
        baseModel({
          parts: [
            { id: 'p1', part: '3001', color: 4, at: [0, 0, 0], step: 1, module: 'base' },
            { id: 'p2', part: '3001', color: 4, at: [0, 6, 0], step: 1, module: 'base' },
          ],
        }),
        cat
      ).errors
    ).includes('floating')
  );

  // 21. mech-id（缺失与重复）
  assert.ok(
    codesOf(
      validate(
        baseModel({
          mechanisms: [{ type: 'removable', parts: ['p1'], offset: [0, 5, 0], evidence: ['ext_a000_e30'] }],
        }),
        cat
      ).errors
    ).includes('mech-id')
  );
  assert.ok(
    codesOf(
      validate(
        baseModel({
          mechanisms: [
            { id: 'm1', type: 'removable', parts: ['p1'], offset: [0, 5, 0], evidence: ['ext_a000_e30'] },
            { id: 'm1', type: 'removable', parts: ['p1'], offset: [0, 5, 0], evidence: ['ext_a000_e30'] },
          ],
        }),
        cat
      ).errors
    ).includes('mech-id')
  );

  // 22. mech-type
  assert.ok(
    codesOf(
      validate(
        baseModel({
          mechanisms: [{ id: 'm1', type: 'spin', parts: ['p1'], evidence: ['ext_a000_e30'] }],
        }),
        cat
      ).errors
    ).includes('mech-type')
  );

  // 23. mech-parts（空数组或引用不存在零件）
  assert.ok(
    codesOf(
      validate(
        baseModel({
          mechanisms: [{ id: 'm1', type: 'removable', parts: [], offset: [0, 5, 0], evidence: ['ext_a000_e30'] }],
        }),
        cat
      ).errors
    ).includes('mech-parts')
  );
  assert.ok(
    codesOf(
      validate(
        baseModel({
          mechanisms: [{ id: 'm1', type: 'removable', parts: ['p999'], offset: [0, 5, 0], evidence: ['ext_a000_e30'] }],
        }),
        cat
      ).errors
    ).includes('mech-parts')
  );

  // 24. mech-hinge
  assert.ok(
    codesOf(
      validate(
        baseModel({
          mechanisms: [{ id: 'm1', type: 'hinge', parts: ['p1'], evidence: ['ext_a000_e30'] }],
        }),
        cat
      ).errors
    ).includes('mech-hinge')
  );
  assert.ok(
    !codesOf(
      validate(
        baseModel({
          mechanisms: [{ id: 'm1', type: 'hinge', parts: ['p1'], pivot: [0, 0, 0], axis: [0, 1, 0], range: [0, 90], evidence: ['ext_a000_e30'] }],
        }),
        cat
      ).errors
    ).includes('mech-hinge')
  );

  // 25. mech-slide
  assert.ok(
    codesOf(
      validate(
        baseModel({
          mechanisms: [{ id: 'm1', type: 'slide', parts: ['p1'], evidence: ['ext_a000_e30'] }],
        }),
        cat
      ).errors
    ).includes('mech-slide')
  );
  assert.ok(
    !codesOf(
      validate(
        baseModel({
          mechanisms: [{ id: 'm1', type: 'slide', parts: ['p1'], axis: [1, 0, 0], range: [0, 4], evidence: ['ext_a000_e30'] }],
        }),
        cat
      ).errors
    ).includes('mech-slide')
  );

  // 26. mech-removable
  assert.ok(
    codesOf(
      validate(
        baseModel({
          mechanisms: [{ id: 'm1', type: 'removable', parts: ['p1'], evidence: ['ext_a000_e30'] }],
        }),
        cat
      ).errors
    ).includes('mech-removable')
  );
  assert.ok(
    !codesOf(
      validate(
        baseModel({
          mechanisms: [{ id: 'm1', type: 'removable', parts: ['p1'], offset: [0, 10, 0], evidence: ['ext_a000_e30'] }],
        }),
        cat
      ).errors
    ).includes('mech-removable')
  );
});

test('validate：全部 12 个警告代码与 2 个提示代码（每个代码均包含触发用例与不触发对照）', () => {
  // 1. format
  assert.ok(codesOf(validate(baseModel({ format: 'other' }), cat).warnings).includes('format'));
  assert.ok(!codesOf(validate(baseModel(), cat).warnings).includes('format'));

  // 2. color-unknown
  assert.ok(
    codesOf(
      validate(
        baseModel({ parts: [{ id: 'p1', part: '3001', color: 99999, at: [0, 0, 0], step: 1, module: 'base' }] }),
        cat
      ).warnings
    ).includes('color-unknown')
  );

  // 3. status
  assert.ok(
    codesOf(
      validate(
        baseModel({ parts: [{ id: 'p1', part: '3001', color: 4, at: [0, 0, 0], step: 1, module: 'base', status: 'guessed' }] }),
        cat
      ).warnings
    ).includes('status')
  );

  // 4. step-undefined
  assert.ok(
    codesOf(
      validate(
        baseModel({
          steps: [{ n: 1 }],
          parts: [{ id: 'p1', part: '3001', color: 4, at: [0, 0, 0], step: 2, module: 'base' }],
        }),
        cat
      ).warnings
    ).includes('step-undefined')
  );

  // 5. module-unknown
  assert.ok(
    codesOf(
      validate(
        baseModel({
          modules: [{ id: 'base' }],
          parts: [{ id: 'p1', part: '3001', color: 4, at: [0, 0, 0], step: 1, module: 'unknown_mod' }],
        }),
        cat
      ).warnings
    ).includes('module-unknown')
  );

  // 6. sub-empty
  assert.ok(
    codesOf(
      validate(
        baseModel({
          modules: [{ id: 'base' }, { id: 'empty_sub', subassembly: true }],
          steps: [{ n: 1 }, { n: 2, attach: 'empty_sub' }],
        }),
        cat
      ).warnings
    ).includes('sub-empty')
  );

  // 7. sub-mixed
  assert.ok(
    codesOf(
      validate(
        baseModel({
          modules: [{ id: 'base' }, { id: 'roof', subassembly: true }],
          steps: [{ n: 1 }, { n: 2, attach: 'roof' }],
          parts: [
            { id: 'p1', part: '3001', color: 4, at: [0, 0, 0], step: 1, module: 'base' },
            { id: 'p2', part: '3001', color: 4, at: [0, 3, 0], step: 1, module: 'roof' },
          ],
        }),
        cat
      ).warnings
    ).includes('sub-mixed')
  );

  // 8. door-mount
  assert.ok(
    codesOf(
      validate(
        baseModel({
          steps: [{ n: 1 }],
          parts: [
            { id: 'p1', part: '60596', color: 15, at: [0, 0, 0], step: 1, module: 'base' },
            { id: 'p2', part: '60623', color: 70, at: [0, 0, 0], step: 1, module: 'base' },
          ],
        }),
        cat
      ).warnings
    ).includes('door-mount')
  );
  assert.ok(
    !codesOf(
      validate(
        baseModel({
          steps: [{ n: 1 }],
          parts: [
            { id: 'p1', part: '60596', color: 15, at: [0, 0, 0], step: 1, module: 'base' },
            { id: 'p2', part: '60623', color: 70, at: [0, 0, 0], step: 1, module: 'base', mount: 'p1' },
          ],
        }),
        cat
      ).warnings
    ).includes('door-mount')
  );

  // 9. ground
  assert.ok(
    codesOf(
      validate(
        baseModel({
          parts: [{ id: 'p1', part: '3001', color: 4, at: [0, 2, 0], step: 1, module: 'base' }],
        }),
        cat
      ).warnings
    ).includes('ground')
  );

  // 10. step-order（主体步骤倒置 + 子组件内部步骤倒置）
  assert.ok(
    codesOf(
      validate(
        baseModel({
          steps: [{ n: 1 }, { n: 2 }],
          parts: [
            { id: 'p_top', part: '3001', color: 4, at: [0, 3, 0], step: 1, module: 'base' },
            { id: 'p_bot', part: '3001', color: 4, at: [0, 0, 0], step: 2, module: 'base' },
          ],
        }),
        cat
      ).warnings
    ).includes('step-order')
  );
  assert.ok(
    codesOf(
      validate(
        baseModel({
          modules: [{ id: 'base' }, { id: 'roof', subassembly: true }],
          steps: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4, attach: 'roof' }],
          parts: [
            { id: 'p1', part: '3001', color: 4, at: [0, 0, 0], step: 1, module: 'base' },
            { id: 'r_top', part: '3001', color: 4, at: [0, 6, 0], step: 2, module: 'roof' },
            { id: 'r_bot', part: '3001', color: 4, at: [0, 3, 0], step: 3, module: 'roof' },
          ],
        }),
        cat
      ).warnings
    ).includes('step-order')
  );

  // 11. mech-evidence
  assert.ok(
    codesOf(
      validate(
        baseModel({
          mechanisms: [{ id: 'm1', type: 'removable', parts: ['p1'], offset: [0, 5, 0] }],
        }),
        cat
      ).warnings
    ).includes('mech-evidence')
  );

  // 12. evidence
  assert.ok(
    codesOf(
      validate(
        baseModel({
          parts: [{ id: 'p1', part: '3001', color: 4, at: [0, 0, 0], step: 1, module: 'base', evidence: ['missing_photo_id'] }],
        }),
        cat,
        { photos: fullPhotoSet() }
      ).warnings
    ).includes('evidence')
  );

  // Info: inferred & uncertain
  const infoRes = validate(
    baseModel({
      parts: [
        { id: 'p1', part: '3001', color: 4, at: [0, 0, 0], step: 1, module: 'base', status: 'inferred' },
        { id: 'p2', part: '3001', color: 4, at: [0, 3, 0], step: 1, module: 'base', status: 'uncertain' },
      ],
    }),
    cat
  );
  assert.deepEqual(codesOf(infoRes.info), ['inferred', 'uncertain']);
  assert.equal(infoRes.stats.inferred, 1);
  assert.equal(infoRes.stats.uncertain, 1);
});

test('bom 与 LDraw / MPD 导出：toLDraw、ldrawExt、ldrawLine', () => {
  const flatModel = baseModel({
    steps: [{ n: 1, title: '第一步' }, { n: 2, title: '第二步' }],
    parts: [
      { id: 'p1', part: '3001', color: 4, at: [0, 0, 0], rot: 0, step: 1, module: 'base' },
      { id: 'p2', part: '3001', color: 4, at: [0, 3, 0], rot: 90, step: 2, module: 'base' },
    ],
  });

  assert.equal(ldrawExt(flatModel), '.ldr');
  const allBom = bom(flatModel, cat);
  assert.equal(allBom.length, 1);
  assert.equal(allBom[0].qty, 2);
  const step1Bom = bom(flatModel, cat, (p) => p.step === 1);
  assert.equal(step1Bom[0].qty, 1);

  const line = ldrawLine(flatModel.parts[0], cat.parts['3001']);
  assert.equal(line, '1 4 40 -24 -20 1 0 0 0 1 0 0 0 1 3001.dat');

  const ldr = toLDraw(flatModel, cat);
  assert.ok(ldr.includes('0 // 第 1 步：第一步'));
  assert.ok(ldr.includes('0 STEP'));
  assert.ok(!ldr.includes('0 FILE main.ldr'));

  // 含子组件时导出为 .mpd
  const cottage = readJSON('examples/cottage.brick.json');
  assert.equal(ldrawExt(cottage), '.mpd');
  const mpd = toLDraw(cottage, cat);
  assert.ok(mpd.includes('0 FILE main.ldr'));
  assert.ok(mpd.includes('0 FILE roof.ldr'));
  assert.ok(mpd.includes('1 16 0 0 0 1 0 0 0 1 0 0 0 1 roof.ldr'));
});

test('checkPhotos：完整机位、缺机位、skipped、可开合机位及全部 6 类警告代码', () => {
  assert.equal(PHOTO_SLOTS.length, 14);

  // 完整且合规的照片集
  const okCheck = checkPhotos(fullPhotoSet());
  assert.equal(okCheck.complete, true);
  assert.deepEqual(okCheck.missing, []);
  assert.deepEqual(okCheck.warnings, []);

  // skipped 底面仍算 complete
  const skippedSet = fullPhotoSet({
    skipped: [{ slot: 'bottom', reason: '固定在底板上' }],
    photos: fullPhotoSet().photos.filter((p) => p.kind !== 'bottom'),
  });
  const skipCheck = checkPhotos(skippedSet);
  assert.equal(skipCheck.complete, true);
  assert.ok(skipCheck.have.some((h) => h.slot === 'bottom' && h.skipped === '固定在底板上'));

  // 缺机位 + 可开合设计缺少 open / interior / module + 全部警告代码
  const badSet = {
    format: 'brickbuild-photos',
    capture: {},
    mechanisms: [
      { id: 'door', label: '前门', type: 'hinge' },
      { id: 'roof', label: '屋顶', type: 'removable' },
    ],
    photos: [
      { id: 'ext_a000_e30', file: 'a.jpg', kind: 'exterior', azimuth: 0, elevation: 30, width: 1920, height: 1080 },
      { id: 'ext_a000_e30', file: 'b.jpg', kind: 'exterior', azimuth: 45, elevation: 30 },
      { file: 'no_id.jpg', kind: 'exterior', azimuth: 90, elevation: 30 },
    ],
  };
  const badCheck = checkPhotos(badSet);
  assert.equal(badCheck.complete, false);
  const missingSlots = badCheck.missing.map((m) => m.slot);
  assert.ok(missingSlots.includes('top'));
  assert.ok(missingSlots.includes('bottom'));
  assert.ok(missingSlots.includes('mech-door-open'));
  assert.ok(missingSlots.includes('mech-door-interior'));
  assert.ok(missingSlots.includes('mech-roof-module'));

  const warnCodes = codesOf(badCheck.warnings);
  assert.ok(warnCodes.includes('mech-half'));
  assert.ok(warnCodes.includes('photo-id'));
  assert.ok(warnCodes.includes('photo-dup'));
  assert.ok(warnCodes.includes('resolution'));
  assert.ok(warnCodes.includes('detail'));
  assert.ok(warnCodes.includes('reference'));
});

test('示例模型 cottage.brick.json 与 cottage.photos.json 完整校验通过', () => {
  const model = readJSON('examples/cottage.brick.json');
  const photos = readJSON('examples/cottage.photos.json');
  const v = validate(model, cat, { photos });
  assert.equal(v.ok, true);
  assert.equal(v.errors.length, 0);
  assert.equal(v.warnings.length, 0);

  const p = checkPhotos(photos, model);
  assert.equal(p.complete, true);
  assert.equal(p.missing.length, 0);
});

test('6 向 SNOT 朝向 (up/snot)、扩展零件目录与实物样本 mecha.brick.json 校验', () => {
  const plate2x6 = cat.parts['3795']; // size: [6, 2], h: 1
  // +z 竖装 2×6 板（rot: 90 → w=2, d=6）：X 中心 0+1=1，Y 中心 6 + 6/(2*0.4) = 13.5，Z 基底 2 + 1*0.4 = 2.4
  assert.deepEqual(partCenter({ at: [0, 6, 2], rot: 90, up: '+z', snot: 1 }, plate2x6), [1, 13.5, 2.4]);
  assert.deepEqual(partCenter({ at: [0, 6, 0], rot: 90, up: '-z', snot: 1 }, plate2x6), [1, 13.5, -0.4]);
  assert.deepEqual(partCenter({ at: [3, 10, 0], rot: 0, up: '+x', snot: 2 }, cat.parts['3020']), [3.8, 15, 1]);
  assert.deepEqual(partCenter({ at: [-1, 10, 0], rot: 0, up: '-x', snot: 2 }, cat.parts['3020']), [-1.8, 15, 1]);
  assert.deepEqual(partCenter({ at: [0, 0, 0], rot: 0, up: '-y', snot: 0 }, cat.parts['3001']), [2, 3, 1]);

  // 扩展零件 localCells 凸点测试
  assert.equal(localCells(cat.parts['3941']).filter((c) => c.stud).length, 4);
  assert.equal(localCells(cat.parts['15068']).filter((c) => c.stud).length, 0);
  assert.equal(localCells(cat.parts['41769']).filter((c) => c.stud).length, 5);
  assert.equal(localCells(cat.parts['41770']).filter((c) => c.stud).length, 5);

  // 非法 up 与 snot 校验错误码
  assert.ok(codesOf(validate(baseModel({ parts: [{ id: 'p1', part: '3001', color: 4, at: [0, 0, 0], up: '+w', step: 1 }] }), cat).errors).includes('up'));
  assert.ok(codesOf(validate(baseModel({ parts: [{ id: 'p1', part: '3001', color: 4, at: [0, 0, 0], up: '+z', snot: 1.5, step: 1 }] }), cat).errors).includes('snot'));

  // 实物样本 mecha.brick.json 与 mecha.photos.json 完整校验通过
  const mecha = readJSON('examples/mecha.brick.json');
  const mechaPhotos = readJSON('examples/mecha.photos.json');
  const mv = validate(mecha, cat, { photos: mechaPhotos });
  assert.equal(mv.ok, true);
  assert.equal(mv.errors.length, 0);
  assert.equal(mv.warnings.length, 0);

  const mp = checkPhotos(mechaPhotos, mecha);
  assert.equal(mp.complete, true);
  assert.equal(mp.missing.length, 0);
});

test('165 种扩展零件库、3D 实体防穿模检测 (partBoxes/boxesCollide) 与凸点扣合 (snapPart)', () => {
  // 1. 验证零件库规模 ≥ 165 且包含 12 大核心类别（含 Travis 四面侧凸点砖、正/倒支架、端头夹板 63868、圆孔耳板 3176 等）
  assert.ok(Object.keys(cat.parts).length >= 165);
  for (const id of ['4733', '11211', '22885', '99206', '99780', '99781', '99207', '36840', '63868', '11476', '60478', '3839b', '44301', '44302', '3176', '2444', '15573', '87580']) {
    assert.ok(cat.parts[id], `缺少零件 ${id}`);
  }

  // 2. 验证 Travis 四面侧凸点砖 (4733) 生成 1 顶面凸点 + 4 侧面凸点 = 5 个输出凸点
  const travis = { id: 't1', part: '4733', color: 72, at: [0, 0, 0], rot: 0, step: 1 };
  const tConn = partConnectors(travis, cat.parts['4733']);
  assert.equal(tConn.studs.length, 5);
  assert.deepEqual(tConn.studs.map((s) => s.dir).sort(), ['+x', '+y', '+z', '-x', '-z'].sort());

  // 3. 验证 snapPart 自动计算扣合坐标且与父零件 0 穿模、100% 物理连接
  const snotParent = { id: 'p_core', part: '11211', color: 0, at: [0, 0, 0], rot: 0, step: 1 };
  const snappedPlate = snapPart(snotParent, cat.parts['11211'], 2, { id: 'p_plate', part: '3795', color: 15, rot: 0, step: 2 }, cat.parts['3795'], 4);
  assert.equal(snappedPlate.up, '+z');
  assert.equal(boxesCollide(partBoxes(snotParent, cat.parts['11211']), partBoxes(snappedPlate, cat.parts['3795'])), null);
  assert.equal(partsConnected(snotParent, cat.parts['11211'], snappedPlate, cat.parts['3795']), true);

  // 4. 验证 3D 穿模与虚假 mount 胶水拦截：将竖向圆柱 (up: '+y') 强行插进横向侧装板 (up: '+z') 内部且无凸点扣合时，validate 必须同时报 overlap 与 mount-disconnected 错误
  const badModel = baseModel({
    parts: [
      { id: 'base', part: '11211', color: 0, at: [0, 0, 0], rot: 0, step: 1 },
      { id: 'plate_z', part: '3020', color: 15, at: [-1, 0, 1], rot: 0, up: '+z', snot: 0, mount: 'base', step: 1 },
      { id: 'cyl_clip', part: '3062b', color: 72, at: [0.5, 1, 0.8], rot: 0, up: '+y', snot: 0, mount: 'plate_z', step: 1 },
    ],
  });
  const badRes = validate(badModel, cat);
  assert.equal(badRes.ok, false);
  assert.ok(badRes.errors.some((e) => e.code === 'overlap' && e.parts.includes('plate_z') && e.parts.includes('cyl_clip')));
  assert.ok(badRes.errors.some((e) => e.code === 'mount-disconnected' && e.parts.includes('cyl_clip') && e.parts.includes('plate_z')));

  // 5. 验证机翼底孔反扣与同轴把柄夹持机构：63868 端头单水平夹板 (snot: 0) 既同轴夹住 48336 把柄板 (p30)，又以顶面凸点扣入 41769 楔形翼板 (p57) 底孔，且 0 穿模
  const mecha = readJSON('examples/mecha.brick.json');
  const p30 = mecha.parts.find((p) => p.id === 'p30');
  const p56 = mecha.parts.find((p) => p.id === 'p56');
  const p57 = mecha.parts.find((p) => p.id === 'p57');
  assert.equal(partsConnected(p30, cat.parts[p30.part], p56, cat.parts[p56.part]), true);
  assert.equal(partsConnected(p56, cat.parts[p56.part], p57, cat.parts[p57.part]), true);
  assert.equal(boxesCollide(partBoxes(p56, cat.parts[p56.part]), partBoxes(p57, cat.parts[p57.part])), null);

  // 6. 验证 mecha.brick.json 中全部带 mount 的零件 100% 具备真实物理扣合 (partsConnected === true)
  const mechaById = new Map(mecha.parts.map((p) => [p.id, p]));
  for (const p of mecha.parts) {
    if (p.mount) {
      const m = mechaById.get(p.mount);
      assert.equal(partsConnected(p, cat.parts[p.part], m, cat.parts[m.part]), true, `${p.id} -> ${p.mount} 必须具备真实物理扣合`);
    }
  }
});
