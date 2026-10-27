/**
 * tools/lib/snap-gt.mjs —— BrickVLM 合成数据引擎的「步骤 / Ground Truth」抽取层
 *
 * 设计红线（与 PRD Phase 4 一致）：
 *   1) **GT 唯一来源 = 模型 parts[].snap**（on/stud/receptor/rot）。不做启发式猜测。
 *      - 没有 `snap` 的零件是**根件**（rootAt 定位），不计入 GT。
 *   2) 每条 GT 必须通过 `partsConnected` 物理复核；任一失败 → 整个样本丢弃（说明模型本身有假连接）。
 *   3) GT 引用的父件必须出现在**基准状态**（step < t）里，否则该标签在状态图上根本看不见，
 *      样本不可解 → 丢弃并计数（原因 `parent-in-same-step`）。
 *   4) GT 的目标凸点在基准状态（step ≤ t−1）必须**空闲**；否则模型自相矛盾 → 丢弃（`target-stud-not-open`）。
 *   5) 可选 `allowDerivedSnap`（默认 **false**）：对完全没有 snap 树的模型，从权威 `at/rot/up`
 *      反解「唯一物理扣合」。反解必须同时满足：
 *        a) `snapPart` 算出的坐标与原 `at` 逐位相等（1e-7）、`up`/`rot` 一致；
 *        b) `partsConnected` 成立；
 *        c) **物理接触身份唯一**（同一父件 + 同一凸点世界坐标只有一种解）——底孔编号等价组内取最小号。
 *      任何歧义（多于一种物理接触）都不产出 GT。产物逐条标 `_provenance: "derived"`，
 *      与真实 `snap`（`_provenance: "snap"`）严格区分，禁止混作真实标注。
 */

import fs from 'node:fs';
import path from 'node:path';
import { computeOpenStuds } from './open-studs.mjs';

/** 读合并目录：{ parts: {...ext, ...curated}, colors, curated, ext }（口径同 cli/brickkit.mjs 顶部） */
export function loadCatalog(root) {
  const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  const extFile = path.join(root, 'catalog/parts-ldraw.json');
  const ext = fs.existsSync(extFile) ? readJSON(extFile).parts : {};
  const curated = readJSON(path.join(root, 'catalog/parts.json')).parts;
  const colors = readJSON(path.join(root, 'catalog/colors.json')).colors;
  return { parts: { ...ext, ...curated }, colors, curated, ext };
}

/** 按 parts[].step 分组 → Map<number, part[]>（保持 parts 数组原顺序，便于稳定复现） */
export function groupByStep(model) {
  const map = new Map();
  for (const p of model.parts || []) {
    if (!p || !Number.isInteger(p.step)) continue;
    if (!map.has(p.step)) map.set(p.step, []);
    map.get(p.step).push(p);
  }
  return new Map([...map.entries()].sort((a, b) => a[0] - b[0]));
}

/** 一条 GT 记录（严格 6 字段，供 SFT 答案与奖励函数直接复用；不含内部 id） */
export function gtItemOf(p) {
  return {
    part: p.part,
    color: p.color,
    on: p.snap.on,
    stud: p.snap.stud,
    receptor: p.snap.receptor ?? 0,
    rot: p.snap.rot ?? p.rot ?? 0,
  };
}

/**
 * 从权威 `at/rot/up` 反解唯一物理扣合（仅 `allowDerivedSnap` 时使用）。
 * 返回 Map<partId, {on, stud, receptor, under}>；未解出或有歧义的零件不出现在 Map 里。
 */
export function deriveSnapCandidates({ model, cat, snapPart, partConnectors, partsConnected }) {
  const parts = (model.parts || []).filter((p) => p && cat.parts[p.part]);
  const idx = new Map(parts.map((p, i) => [p.id, i]));
  const out = new Map();

  for (const child of parts) {
    if (child.snap) continue;               // 真实 snap 优先，不覆盖
    const defC = cat.parts[child.part];
    const childUp = child.up || '+y';
    const childRot = child.rot ?? 0;
    let nRec = 0;
    try {
      nRec = partConnectors({ ...child, at: [0, 0, 0], snot: 0 }, defC).receptors.length;
    } catch { nRec = 0; }
    if (!nRec) continue;

    const identities = new Map();           // 物理接触身份 → 最优 (stud, receptor)
    for (const parent of parts) {
      if (parent === child) continue;
      if (idx.get(parent.id) >= idx.get(child.id)) continue;   // 只为「先装的父件」反解
      if (parent.step > child.step) continue;
      const defP = cat.parts[parent.part];
      let pConn = null;
      try { pConn = partConnectors(parent, defP); } catch { continue; }
      for (const s of pConn.studs) {
        for (const under of [false, true]) {
          for (let r = 0; r < nRec; r++) {
            let snapped = null;
            try {
              snapped = snapPart(parent, defP, s.index,
                { id: child.id, part: child.part, color: child.color, rot: childRot, up: childUp },
                defC, r, { under });
            } catch { continue; }
            if (Math.abs(snapped.at[0] - child.at[0]) > 1e-7
              || Math.abs(snapped.at[1] - child.at[1]) > 1e-7
              || Math.abs(snapped.at[2] - child.at[2]) > 1e-7) continue;
            if ((snapped.up || '+y') !== childUp) continue;
            if ((snapped.rot ?? 0) !== childRot) continue;
            if (!partsConnected(parent, defP, snapped, defC)) continue;
            const key = `${parent.id}@${s.pos.map((v) => v.toFixed(3)).join(',')}${under ? 'U' : ''}`;
            const prev = identities.get(key);
            const cand = { on: parent.id, stud: s.index, receptor: r, under };
            if (!prev || cand.stud < prev.stud || (cand.stud === prev.stud && cand.receptor < prev.receptor)) {
              identities.set(key, cand);
            }
          }
        }
      }
    }
    if (identities.size !== 1) continue;      // 0 = 无解（根件/悬空），>1 = 歧义
    out.set(child.id, [...identities.values()][0]);
  }
  return out;
}

/**
 * 抽取全部步骤样本。
 *
 * @param {object} args
 * @param {object} args.model
 * @param {object} args.cat
 * @param {string} args.modelId
 * @param {{ partConnectors:Function, partsConnected:Function, snapPart:Function }} args.lib
 * @param {boolean} [args.allowDerivedSnap=false]
 * @param {number} [args.maxSteps=Infinity]
 * @returns {{ samples: object[], dropped: object[], stats: object }}
 */
export function extractStepSamples({
  model, cat, modelId, lib, allowDerivedSnap = false, maxSteps = Infinity,
}) {
  const { partConnectors, partsConnected, snapPart } = lib;
  const dropped = [];
  const samples = [];
  const drop = (step, reason, detail, parts = []) => dropped.push({ model: modelId, step, reason, detail, parts });

  const stepMap = groupByStep(model);
  const allSteps = [...stepMap.keys()];

  // 反解仅在显式开关下进行；产物逐条标注 provenance
  const derived = allowDerivedSnap
    ? deriveSnapCandidates({ model, cat, snapPart, partConnectors, partsConnected })
    : new Map();

  for (const t of allSteps) {
    if (samples.length >= maxSteps) break;
    const partsAtT = stepMap.get(t) || [];
    const baseIds = new Set((model.parts || []).filter((p) => p && p.step < t).map((p) => p.id));

    // ---- 1) 组 GT：只有带 snap（或反解成功）的零件才算 GT
    const gt = [];
    for (const p of partsAtT) {
      const src = p.snap ? 'snap' : (derived.has(p.id) ? 'derived' : null);
      if (!src) continue;                       // 根件：不计入 GT
      if (!cat.parts[p.part]) { drop(t, 'part-unknown', `目录里没有零件 ${p.part}`, [p.id]); continue; }
      if (src === 'snap' ? p.snap.under : derived.get(p.id).under) {
        // `under: true` 是「底孔反扣」专用机制，6 字段动作契约无法表达，单独计数后剔除该条
        drop(t, 'under-snap-unsupported', '零件的 snap.under=true（底孔反扣），超出 6 字段动作契约', [p.id]);
        continue;
      }
      const d = src === 'snap' ? p.snap : derived.get(p.id);
      gt.push({
        _partId: p.id,
        _provenance: src,
        part: p.part,
        color: p.color,
        on: d.on,
        stud: d.stud,
        receptor: d.receptor ?? 0,
        rot: d.rot ?? p.rot ?? 0,
      });
    }
    if (!gt.length) {
      if (partsAtT.length) drop(t, 'no-snap-parts', `第 ${t} 步的 ${partsAtT.length} 个零件全部是根件（无 snap）`, partsAtT.map((p) => p.id));
      continue;
    }

    // ---- 2) 父件必须在基准状态里（否则标签不在状态图上，该条不可解）。
    //        这里逐条剔除而不是整步丢弃：真实说明书里「装上甲、再往甲上扣乙」同页很常见，
    //        基准图上只看得见甲的父件标签。可解部分照常产出，被推迟的部分在 metadata 里如实记名。
    const deferred = gt.filter((g) => !baseIds.has(g.on));
    const installable = gt.filter((g) => baseIds.has(g.on));
    if (!installable.length) {
      drop(t, 'parent-in-same-step', `${gt.length} 条 GT 的父件与子件同一步安装，状态图上没有该凸点标签`, gt.map((g) => g._partId));
      continue;
    }

    // ---- 3) 物理复核：任何一条假连接 → 整样本丢弃（说明模型本身有假连接）
    const byId = new Map((model.parts || []).map((p) => [p.id, p]));
    const bad = [];
    for (const g of gt) {
      const child = byId.get(g._partId);
      const parent = byId.get(g.on);
      if (!parent) { bad.push({ id: g._partId, why: `父件 ${g.on} 不存在` }); continue; }
      let ok = false;
      try { ok = partsConnected(parent, cat.parts[parent.part], child, cat.parts[child.part]); } catch { ok = false; }
      if (!ok) bad.push({ id: g._partId, why: `partsConnected(${g._partId} on ${g.on}) 为 false` });
    }
    if (bad.length) {
      drop(t, 'false-connection', `${bad.length} 条 GT 物理复核失败：${bad.map((b) => b.why).join('；')}`, bad.map((b) => b.id));
      continue;
    }

    // ---- 4) 状态图（step ≤ t−1）上的空闲凸点；GT 目标凸点必须真的空闲
    const openStuds = computeOpenStuds(model, cat, { stepMax: t - 1, partConnectors });
    const openKeys = new Set(openStuds.map((s) => `${s.id}#${s.stud}`));
    const missing = installable.filter((g) => !openKeys.has(`${g.on}#${g.stud}`));
    const solvable = installable.filter((g) => openKeys.has(`${g.on}#${g.stud}`));
    if (!solvable.length) {
      drop(t, 'target-stud-not-open', `可安装的 ${installable.length} 条 GT 目标凸点在基准状态已占用或不可见`, installable.map((g) => g._partId));
      continue;
    }

    samples.push({
      modelId,
      step: t,
      baseStep: t - 1,
      gt: solvable.map((g) => ({ ...g })),
      deferred: deferred.map((g) => ({ ...g })),
      unsolvable: missing.map((g) => ({ ...g })),
      openStuds,
      partsAtT,
    });
  }

  const dropReasons = {};
  for (const d of dropped) dropReasons[d.reason] = (dropReasons[d.reason] || 0) + 1;
  const avgOpen = samples.length ? samples.reduce((a, s) => a + s.openStuds.length, 0) / samples.length : 0;
  const provenance = samples.length
    ? samples.reduce((acc, s) => {
      for (const g of s.gt) acc[g._provenance] = (acc[g._provenance] || 0) + 1;
      return acc;
    }, {})
    : {};
  const deferredCount = samples.reduce((a, s) => a + s.deferred.length, 0);
  const unsolvableCount = samples.reduce((a, s) => a + s.unsolvable.length, 0);

  return {
    samples,
    dropped,
    stats: {
      model: modelId,
      steps: allSteps.length,
      stepsWithParts: allSteps.length,
      samples: samples.length,
      dropped: dropped.length,
      dropReasons,
      avgOpenStuds: Number(avgOpen.toFixed(2)),
      derivedSnapParts: derived.size,
      gtProvenance: provenance,
      // 同一步内「父件也在本步」→ 推迟到可解步骤，不计入答案
      gtDeferredSameStep: deferredCount,
      // 目标凸点在基准状态已被占用/不可见 → 不计入答案
      gtTargetStudOccupied: unsolvableCount,
    },
  };
}

/** 供奖励函数复用：模型副本（深拷贝） */
export function cloneModel(model) {
  return JSON.parse(JSON.stringify(model));
}
