// BrickKit 程序化搭建 API：给智能体的官方搭建路径（替代手写坐标）。
// 每次 add 立即做三项检查，违反即抛中文错误并指明双方零件 id：
//   ① 编号 / 颜色在目录中存在；② 与已有零件 3D 实体不穿模（partBoxes + boxesCollide）；③ id 不重复。
// 有 on 时由 snapPart 自动计算精确扣合坐标（调用方不得再传 at）；无 on 时必须显式给整数格 at。
//
// 目标用法示例（叠砖 / snap 侧装 / 模块归属 / save）：
//
//   import fs from 'node:fs';
//   import { createBuilder } from '../src/core/builder.js';
//
//   const catalog = JSON.parse(fs.readFileSync('catalog/parts.json', 'utf8'));
//   const b = createBuilder({ catalog, meta: { name: '小塔', front: '+z' } });
//
//   const base = b.add('3001', 0, { at: [0, 0, 0], step: 1 });      // ① 无 on：必须显式 at（3 个整数 [x, 层, z]）
//   b.add('3001', 0, { on: base.id, stud: 0, step: 2 });            // ② 叠砖：snapPart 自动算 at，禁止再传 at
//   const snot = b.add('87087', 0, { at: [6, 0, 0], step: 1 });     // ③ SNOT 侧凸点砖
//   b.add('3024', 4, { on: snot.id, stud: 1, up: '+z', step: 2 });  // ④ snap 侧装：up 与侧凸点朝向一致
//   b.setModule(base.id, 'tower');                                  // ⑤ 模块归属
//   b.assert();                                                     // ⑥ validate() 有 errors 即抛错（附前 3 条）
//   b.save('out/tower.brick.json');                                 // ⑦ 校验通过后再落盘
//
// —— 子组件刚体挂装 addAssembly ——
//   // 先在任意位置把一组零件搭好（各自 add），再整体当刚体扣到父件凸点上：
//   const door = ['d1', 'd2', 'd3'].map((id, i) => b.add(i ? '3020' : '3001', 0, { at: [i * 2, 40, 0], id, step: 5 }));
//   b.addAssembly(['d1', 'd2', 'd3'], { on: base.id, stud: 3, anchor: 'd1', anchorReceptor: 0, rot: 90, step: 6, label: '舱门' });
//   // 语义：整组绕竖直轴转 rot 度 → 让 anchor 的第 anchorReceptor 号底孔落在 on 的 stud 号凸点上 →
//   // 组内所有零件做同样的旋转+平移（刚体）；组内零件 step 保持/设为 step-1，装配步自动写入 step。
//   // validate 认可「组内零件由 anchor 支撑」，不再要求各自接地；anchor 必须真实连到组外。
//   // 变换后 at 仍须为整数格，否则抛错（不允许手算小数坐标）。
//
// —— 翻面搭建（倒装作业）——
//   ① 负层（at[1] < 0）合法：第 1~3 步可以先从 y<0 的底部倒装件开始，只要最终接到同一支撑链。
//   ② 整机翻面（底盘朝上作业）时用 createBuilder({ meta: { flip: true } })：
//      validate 把「最上层」当作施工基准面，无需改写任何零件坐标。
import fs from 'node:fs';
import path from 'node:path';
import { FORMAT, VERSION, snapPart, partBoxes, boxesCollide, partsCollide, validate, partConnectors, partCenter, partsConnected, rotXZ, localDirToWorld, transformAssembly3D, findMounts, recompute } from './core.js';

/** 创建构建器；catalog 形如 { parts, colors }（catalog/parts.json 的内容），meta 写入 model.meta */
export function createBuilder({ catalog, meta } = {}) {
  if (!catalog || !catalog.parts) {
    throw new Error('createBuilder 需要传入 catalog（含 parts 零件表），例如：JSON.parse(fs.readFileSync("catalog/parts.json", "utf8"))');
  }
  const parts = [];
  const assemblies = [];                    // 子组件刚体组：{ id, anchor, attachStep, label, on, stud, anchorReceptor, rot, submodel }
  const submodels = Object.create(null);    // 导入的子模型原始定义：{ [id]: { label, anchor, parts } }
  let counter = 0;                          // 自动 id 计数：p001、p002…（只在放置成功后前进）
  let asmCounter = 0;                       // 子组件组编号：asm1、asm2…
  const find = (id) => parts.find((p) => p.id === id);
  const defOf = (p) => catalog.parts[p.part];
  const firstCollision = (candidate, exceptId) => {
    const def = defOf(candidate);
    const boxes = partBoxes(candidate, def);
    if (!boxes.length && !def.wheel) return null;
    for (const other of parts) {
      if (other.id === exceptId) continue;
      const oDef = defOf(other);
      if (partsCollide(candidate, def, boxes, other, oDef, partBoxes(other, oDef))) return other;
    }
    return null;
  };

  const builder = {
    /** 添加零件：add(part, color, { on, stud, receptor, rot, up, at, step, module, id, note, status, evidence }) */
    add(part, color, opts = {}) {
      const { on, stud = 0, receptor = 0, rot, up, at, step = 1, module, id, note, status, evidence } = opts;
      if (on !== undefined && at !== undefined) {
        throw new Error(`add 零件 ${part}：传了 on（父零件 ${on}）就必须由 snapPart 自动计算 at，不能再手动传 at`);
      }
      if (on === undefined && at === undefined) {
        throw new Error(`add 零件 ${part}：没有 on 时必须显式传整数格坐标 at: [x, 层, z]`);
      }
      if (at !== undefined && (!Array.isArray(at) || at.length !== 3 || !at.every(Number.isInteger))) {
        throw new Error(`add 零件 ${part}：at 必须是 3 个整数 [x, 层, z]，收到 ${JSON.stringify(at)}；需要精确扣合请改用 on/stud 让 snapPart 计算`);
      }
      const def = catalog.parts[part];
      if (!def) {
        throw new Error(`add 零件 ${part}：零件编号不在目录中（catalog.parts），先用 "brickkit catalog" 查真实编号，切勿猜测`);
      }
      if (catalog.colors && !catalog.colors[String(color)]) {
        throw new Error(`add 零件 ${part}：颜色代码 ${color} 不在颜色表中（catalog.colors），先用 "brickkit colors" 查代码`);
      }
      const pid = id !== undefined ? id : `p${String(counter + 1).padStart(3, '0')}`;
      if (find(pid)) throw new Error(`add 零件 ${part}：零件 id 重复：${pid}（已有同名零件，请换一个 id）`);

      let placed;
      if (on !== undefined) {
        const parent = find(on);
        if (!parent) throw new Error(`add 零件 ${part}：on 指向的父零件 ${on} 不存在（还没有 add 过）`);
        placed = snapPart(
          parent, defOf(parent), stud,
          { id: pid, part, color, ...(rot !== undefined ? { rot } : {}), ...(up !== undefined ? { up } : {}) },
          def, receptor, { under: Boolean(opts.under) }
        );
        placed.snap = { on, stud, receptor, ...(opts.under ? { under: true } : {}), ...(rot !== undefined ? { rot } : {}), ...(up !== undefined ? { up } : {}) };
        if ((!Number.isInteger(placed.at[0]) || !Number.isInteger(placed.at[2])) && !placed.mount) {
          placed.mount = on;
        }
      } else {
        placed = { id: pid, part, color, at: [...at], rootAt: [...at], ...(rot !== undefined ? { rot } : {}), ...(up !== undefined ? { up } : {}), snot: opts.snot ?? 0 };
      }
      const other = firstCollision(placed);
      if (other) {
        throw new Error(`add 零件 ${part}：新零件 ${pid} 与已有零件 ${other.id}（${other.part}）发生 3D 穿模，位置 ${JSON.stringify(placed.at)}；请挪开或改用 on/stud 扣合`);
      }
      placed.step = step;
      if (module !== undefined) placed.module = module;
      if (opts.mount !== undefined) placed.mount = opts.mount;
      if (opts.accessory !== undefined) placed.accessory = opts.accessory;
      if (note !== undefined) placed.note = note;
      if (status !== undefined) placed.status = status;
      if (evidence !== undefined) placed.evidence = evidence;
      parts.push(placed);
      if (id === undefined) counter++;
      return placed;
    },

    /** 移除零件，返回被移除的零件对象 */
    remove(id) {
      const i = parts.findIndex((p) => p.id === id);
      if (i < 0) throw new Error(`remove：找不到零件 ${id}`);
      return parts.splice(i, 1)[0];
    },

    /**
     * 子组件刚体挂装：把一组已经 add 过的零件当作刚体，按锚点零件的底孔扣到父件凸点上。
     * addAssembly(ids, { on, stud, anchor, anchorReceptor, rot, step, module, label })
     *   ids            组内零件 id（必须都已 add；至少 2 件，且组内必须连成一体）
     *   on / stud      父零件 id 与其凸点编号（partsConnected 语义）
     *   anchor         锚点零件 id（默认 ids[0]），组的坐标系以它为准
     *   anchorReceptor 锚点零件的底孔编号（默认 0）
     *   rot            整组绕竖直轴旋转角（0/90/180/270）；省略时自动在四向里找第一个真能扣上的
     *   step           装配步（组内零件统一写这个 step，默认沿用组内最大 step）
     *   module/label   模块归属与显示标签
     * 组内所有零件做同一旋转 + 平移（刚体），变换后逐件复查：不穿模、不与父件脱离、at 为整数格（SNOT 件除外）。
     */
    addAssembly(ids, opts = {}) {
      const { on, stud = 0, anchor, anchorReceptor = 0, rot, step, module, label } = opts;
      if (!Array.isArray(ids) || ids.length < 2) throw new Error(`addAssembly：ids 至少要有 2 个零件，收到 ${JSON.stringify(ids)}`);
      if (new Set(ids).size !== ids.length) throw new Error(`addAssembly：ids 有重复：${JSON.stringify(ids)}`);
      if (on === undefined) throw new Error('addAssembly：必须给 on（父零件 id），子组件要扣到父件凸点上');
      const parent = find(on);
      if (!parent) throw new Error(`addAssembly：on 指向的父零件 ${on} 不存在（还没有 add 过）`);
      const members = ids.map((id) => {
        const p = find(id);
        if (!p) throw new Error(`addAssembly：组内零件 ${id} 不存在（还没有 add 过）`);
        const def = defOf(p);
        if (!def) throw new Error(`addAssembly：组内零件 ${id}（${p.part}）不在目录中`);
        return { p, def };
      });
      const anchorId = anchor !== undefined ? anchor : ids[0];
      const anchorEntry = members.find(({ p }) => p.id === anchorId);
      if (!anchorEntry) throw new Error(`addAssembly：anchor ${anchorId} 必须是组内零件（${ids.join(', ')}）`);
      // 组内连通性：锚点之外的每件都要和组内某件真实相连（刚体前提，不允许散件打包）
      const connOf = new Map(members.map(({ p, def }) => [p.id, partConnectors(p, def)]));
      for (const { p, def } of members) {
        if (p.id === anchorId) continue;
        const linked = members.some(({ p: q, def: dq }) => q.id !== p.id && partsConnected(p, def, q, dq, connOf.get(p.id), connOf.get(q.id)));
        if (!linked) throw new Error(`addAssembly：组内零件 ${p.id}（${p.part}）与组内其他零件没有真实物理连接，不能作为刚体挂装`);
      }
      const pDef = defOf(parent), pConn = partConnectors(parent, pDef);
      const parentStud = pConn.studs[stud];
      if (!parentStud) throw new Error(`addAssembly：父零件 ${on}（${parent.part}）不存在凸点 #${stud}（共 ${pConn.studs.length} 个）`);
      const aConn = partConnectors(anchorEntry.p, anchorEntry.def);
      const aRec = aConn.receptors[anchorReceptor];
      if (!aRec) {
        throw new Error(`addAssembly：锚点零件 ${anchorId}（${anchorEntry.p.part}）没有第 ${anchorReceptor} 号底孔：该零件共 ${aConn.receptors.length} 个底孔（编号 0~${aConn.receptors.length - 1}）`);
      }
      // 支持完整 3D 正交刚体变换（含桌面平搭子组件 90°/180° SNOT 翻立挂装到侧凸点）
      const tries = rot !== undefined ? [rot] : [0, 90, 180, 270];
      let placed = null, usedRot = null;
      for (const deg of tries) {
        const res = transformAssembly3D(members, parent, pDef, stud, anchorId, anchorReceptor, deg);
        if (res) { placed = res; usedRot = deg; break; }
      }
      if (!placed) {
        throw new Error(`addAssembly：锚点零件 ${anchorId}（${anchorEntry.p.part}）的底孔 #${anchorReceptor}（朝向 ${aRec.dir}）无法扣到父零件 ${on}（${parent.part}）凸点 #${stud}（朝向 ${parentStud.dir}）` +
          `${rot !== undefined ? `（已试 rot=${rot}）` : '（已试 rot=0/90/180/270）'}；请检查锚点底孔与父件凸点连接类型是否匹配`);
      }
      const memberIds = new Set(ids);
      // 碰撞复查：组内 vs 组外；组内互相之间（刚体内部原本不穿模，变换后也复查一遍）
      for (const cand of placed) {
        const boxes = partBoxes(cand, defOf(cand));
        for (const other of parts) {
          if (memberIds.has(other.id)) continue;
          if (other.id === parent.id) continue;   // 与父件的接触面允许贴合（由 partsConnected 保真）
          if (partsCollide(cand, defOf(cand), boxes, other, defOf(other), partBoxes(other, defOf(other)))) {
            throw new Error(`addAssembly：挂装后零件 ${cand.id}（${cand.part}）与已有零件 ${other.id}（${other.part}）发生 3D 穿模，位置 ${JSON.stringify(cand.at)}`);
          }
        }
        for (const m2 of placed) {
          if (m2.id === cand.id) continue;
          if (partsCollide(cand, defOf(cand), boxes, m2, defOf(m2), partBoxes(m2, defOf(m2)))) {
            throw new Error(`addAssembly：挂装后组内零件 ${cand.id} 与 ${m2.id} 发生 3D 穿模（刚体内部原本不应重叠）`);
          }
        }
      }
      const gid = opts.id || `asm${++asmCounter}`;
      // 保存挂装前的局部快照供 recompute 使用
      submodels[gid] = {
        label: label ?? gid,
        anchor: anchorId,
        parts: members.map(({ p }) => ({ ...p, at: [...p.at], ...(p.snap ? { snap: { ...p.snap } } : {}), ...(p.rootAt ? { rootAt: [...p.rootAt] } : {}) })),
      };
      // 组内零件保留各自原有的搭建步（它们先在别处搭好），装配步 = 传入的 step，缺省取组内最大步 + 1。
      // validate 要求「子组件零件的 step 早于装配步」，因此装配步必须严格大于组内每件的 step。
      const maxMemberStep = Math.max(...members.map(({ p }) => p.step || 1));
      const attachStep = Number.isInteger(step) ? step : maxMemberStep + 1;
      if (!Number.isInteger(attachStep) || attachStep < 1) throw new Error(`addAssembly：step 必须是 ≥1 的整数，收到 ${JSON.stringify(step)}`);
      if (attachStep <= maxMemberStep) {
        throw new Error(`addAssembly：装配步 step=${attachStep} 必须晚于组内零件的搭建步（最大 ${maxMemberStep}）；先在早的步骤把组搭好，再用更晚的 step 装上`);
      }
      for (const cand of placed) {
        const p = find(cand.id);
        Object.assign(p, cand);
        p.subassembly = gid;
        p.subassemblyAnchor = anchorId;
        p.module = module ?? gid;             // 组员统一归到子组件模块下（stepPlan 据此识别子组件批次）
      }
      assemblies.push({ id: gid, submodel: gid, on, stud, anchor: anchorId, anchorReceptor, rot: usedRot, attachStep, label: label ?? gid });
      return { id: gid, anchor: anchorId, rot: usedRot, step: attachStep, label: label ?? gid, parts: ids.slice() };
    },

    /**
     * 导入外部子模型（.brick.json 文件路径或模型对象）并作为 3D 刚体挂装到主模型父件凸点上。
     * 子模型可在自身局部坐标系 [0,0,0] 桌面平搭（up: '+y'），挂装时自动完成命名前缀隔离与 3D 翻立/旋转，
     * 避免在主模型原点发生中间态碰撞。若省略 stud 或传 autoMount: true，则自动搜索无穿模挂点。
     */
    importSubmodel(subModelOrFile, opts = {}) {
      const subObj = typeof subModelOrFile === 'string'
        ? JSON.parse(fs.readFileSync(subModelOrFile, 'utf8'))
        : subModelOrFile;
      if (!subObj || !Array.isArray(subObj.parts) || subObj.parts.length < 1) {
        throw new Error('importSubmodel：子模型必须包含非空 parts 数组');
      }
      const { on, stud, anchor, anchorReceptor, rot, step, id, prefix, label, autoMount } = opts;
      if (!on) throw new Error('importSubmodel：必须指定父零件 on');
      const parent = find(on);
      if (!parent) throw new Error(`importSubmodel：父零件 ${on} 不存在`);

      const gid = id || subObj.meta?.id || `asm${++asmCounter}`;
      const pfx = prefix !== undefined ? prefix : `${gid}_`;
      const idMap = Object.create(null);
      for (const sp of subObj.parts) {
        const newId = find(sp.id) || pfx ? `${pfx}${sp.id}` : sp.id;
        if (find(newId)) throw new Error(`importSubmodel：映射后的零件 id ${newId} 与主模型已有零件重名`);
        idMap[sp.id] = newId;
      }
      const rawAnchor = anchor || subObj.anchor || subObj.meta?.anchor || subObj.parts[0].id;
      const mappedAnchor = idMap[rawAnchor] || rawAnchor;
      const localParts = subObj.parts.map((sp) => {
        const np = {
          ...sp,
          id: idMap[sp.id],
          at: [...sp.at],
          ...(sp.rootAt ? { rootAt: [...sp.rootAt] } : {}),
          ...(sp.snap ? { snap: { ...sp.snap, on: idMap[sp.snap.on] || sp.snap.on } } : {}),
          ...(sp.mount ? { mount: idMap[sp.mount] || sp.mount } : {}),
        };
        return np;
      });
      const members = localParts.map((p) => {
        const def = defOf(p);
        if (!def) throw new Error(`importSubmodel：子模型零件 ${p.id}（${p.part}）不在目录中`);
        return { p, def };
      });
      // 组内连通性检查（多于 1 件时要求 100% 连通）
      if (members.length > 1) {
        const connOf = new Map(members.map(({ p, def }) => [p.id, partConnectors(p, def)]));
        const visited = new Set([mappedAnchor]);
        const q = [mappedAnchor];
        while (q.length) {
          const cur = q.pop();
          const curEntry = members.find(({ p }) => p.id === cur);
          for (const { p: nxt, def: ndef } of members) {
            if (visited.has(nxt.id)) continue;
            if (partsConnected(curEntry.p, curEntry.def, nxt, ndef, connOf.get(cur), connOf.get(nxt.id))) {
              visited.add(nxt.id);
              q.push(nxt.id);
            }
          }
        }
        if (visited.size < members.length) {
          const detached = members.filter(({ p }) => !visited.has(p.id)).map(({ p }) => p.id);
          throw new Error(`importSubmodel：子模型 ${gid} 内部存在未物理连接的散件（${detached.join(', ')}），不能作为刚体挂装`);
        }
      }

      let useStud = stud ?? 0;
      let useRec = anchorReceptor ?? 0;
      let useRot = rot;
      let placed = null;

      if (autoMount || stud === undefined) {
        const cands = findMounts({ parts }, { parts: localParts, anchor: mappedAnchor }, catalog, {
          parent: on, anchor: mappedAnchor, stud, receptor: anchorReceptor, rot, maxResults: 1,
        });
        if (!cands.length) {
          throw new Error(`importSubmodel：在父零件 ${on}（${parent.part}）上未找到任何可无穿模挂载子模型 ${gid}（锚点 ${mappedAnchor}）的合法位置`);
        }
        useStud = cands[0].stud;
        useRec = cands[0].anchorReceptor;
        useRot = cands[0].rot;
        placed = cands[0].placed;
      } else {
        const pDef = defOf(parent);
        const tries = useRot !== undefined ? [useRot] : [0, 90, 180, 270];
        for (const deg of tries) {
          const candPlaced = transformAssembly3D(members, parent, pDef, useStud, mappedAnchor, useRec, deg);
          if (!candPlaced) continue;
          // 检查与主模型碰撞
          let hitOther = null, hitCand = null;
          for (const cand of candPlaced) {
            const boxes = partBoxes(cand, defOf(cand));
            for (const other of parts) {
              if (other.id === parent.id) continue;
              if (partsCollide(cand, defOf(cand), boxes, other, defOf(other), partBoxes(other, defOf(other)))) {
                hitOther = other; hitCand = cand; break;
              }
            }
            if (hitOther) break;
          }
          if (!hitOther) { placed = candPlaced; useRot = deg; break; }
          if (tries.length === 1) {
            throw new Error(`importSubmodel：挂装后零件 ${hitCand.id}（${hitCand.part}）与主模型零件 ${hitOther.id}（${hitOther.part}）发生 3D 穿模，位置 ${JSON.stringify(hitCand.at)}`);
          }
        }
        if (!placed) {
          throw new Error(`importSubmodel：子模型 ${gid}（锚点 ${mappedAnchor} 底孔 #${useRec}）无法无穿模扣到父零件 ${on}（${parent.part}）凸点 #${useStud}`);
        }
      }

      const maxMemberStep = Math.max(...localParts.map((p) => p.step || 1));
      const attachStep = Number.isInteger(step) ? step : maxMemberStep + 1;
      if (attachStep <= maxMemberStep) {
        throw new Error(`importSubmodel：装配步 step=${attachStep} 必须晚于子模型内部最大搭建步（${maxMemberStep}）`);
      }

      submodels[gid] = {
        label: label || subObj.meta?.name || gid,
        anchor: mappedAnchor,
        parts: localParts,
      };
      for (const cand of placed) {
        cand.subassembly = gid;
        cand.subassemblyAnchor = mappedAnchor;
        cand.module = gid;
        parts.push(cand);
      }
      assemblies.push({
        id: gid, submodel: gid, on, stud: useStud,
        anchor: mappedAnchor, anchorReceptor: useRec, rot: useRot,
        attachStep, label: label || subObj.meta?.name || gid,
      });
      return { id: gid, anchor: mappedAnchor, stud: useStud, anchorReceptor: useRec, rot: useRot, step: attachStep, parts: placed.map((p) => p.id) };
    },

    /**
     * 修改根零件的基准位置 rootAt 并自动沿 snap 树与 mounts 刚体挂装树级联重算全模型所有后代零件的坐标。
     * 若重算后发生任何 3D 穿模则自动回滚并报错。
     */
    reanchor(id, newAt) {
      const p = find(id);
      if (!p) throw new Error(`reanchor：找不到零件 ${id}`);
      if (!Array.isArray(newAt) || newAt.length !== 3 || !newAt.every(Number.isInteger)) {
        throw new Error(`reanchor：newAt 必须是 3 个整数 [x, 层, z]，收到 ${JSON.stringify(newAt)}`);
      }
      const snapshot = parts.map((x) => ({ id: x.id, at: [...x.at], rot: x.rot, up: x.up, snot: x.snot, rootAt: x.rootAt ? [...x.rootAt] : undefined }));
      p.at = [...newAt];
      p.rootAt = [...newAt];
      builder.recompute();
      // 碰撞复查
      for (let i = 0; i < parts.length; i++) {
        const a = parts[i], boxesA = partBoxes(a, defOf(a));
        for (let j = i + 1; j < parts.length; j++) {
          const b = parts[j];
          // 同一刚体子组件与其挂载父件允许接触
          if (a.subassembly && a.subassembly !== b.subassembly) {
            const asm = assemblies.find((x) => x.id === a.subassembly);
            if (asm && asm.on === b.id) continue;
          }
          if (b.subassembly && b.subassembly !== a.subassembly) {
            const asm = assemblies.find((x) => x.id === b.subassembly);
            if (asm && asm.on === a.id) continue;
          }
          if (partsCollide(a, defOf(a), boxesA, b, defOf(b), partBoxes(b, defOf(b)))) {
            for (const s of snapshot) {
              const cur = find(s.id);
              if (cur) { cur.at = s.at; cur.rot = s.rot; cur.up = s.up; cur.snot = s.snot; if (s.rootAt) cur.rootAt = s.rootAt; }
            }
            throw new Error(`reanchor：平移根零件 ${id} 后导致 ${a.id} 与 ${b.id} 发生 3D 穿模，已自动回滚`);
          }
        }
      }
      return p;
    },

    /** 触发参数化装配树拓扑级联重算 */
    recompute() {
      const m = {
        parts,
        submodels,
        mounts: assemblies.filter((a) => a.on !== undefined),
      };
      recompute(m, catalog);
      return builder;
    },

    /** 整格平移（dAt = [dx, d层, dz]），平移后重查 3D 穿模，违反即回滚并抛中文错误 */
    move(id, dAt) {
      const p = find(id);
      if (!p) throw new Error(`move：找不到零件 ${id}`);
      if (!Array.isArray(dAt) || dAt.length !== 3 || !dAt.every(Number.isInteger)) {
        throw new Error(`move：dAt 必须是 3 个整数 [dx, d层, dz]，收到 ${JSON.stringify(dAt)}`);
      }
      const prev = p.at;
      p.at = [prev[0] + dAt[0], prev[1] + dAt[1], prev[2] + dAt[2]];
      const other = firstCollision(p, id);
      if (other) {
        p.at = prev;   // 回滚，保持模型状态一致
        throw new Error(`move：零件 ${id}（${p.part}）平移后与已有零件 ${other.id}（${other.part}）发生 3D 穿模，已回滚到原位置`);
      }
      return p;
    },

    /** 设置零件的模块归属 */
    setModule(id, moduleId) {
      const p = find(id);
      if (!p) throw new Error(`setModule：找不到零件 ${id}`);
      p.module = moduleId;
      return p;
    },

    /** 调 core 的 validate 校验整个模型，返回 { ok, errors, warnings, info, stats } */
    validate(opts = {}) {
      return validate(builder.model(), catalog, opts);
    },

    /** 有 errors 即 throw（附前 3 条明细），否则返回校验结果 */
    assert(opts = {}) {
      const res = validate(builder.model(), catalog, opts);
      if (!res.ok) {
        const head = res.errors.slice(0, 3).map((e) => `  - [${e.code}] ${e.msg}`).join('\n');
        throw new Error(`assert 失败：模型有 ${res.errors.length} 个校验错误：\n${head}${res.errors.length > 3 ? '\n  …' : ''}`);
      }
      return res;
    },

    /** 导出模型对象（深拷贝，修改不影响构建器状态） */
    model() {
      const clonePart = (p) => ({
        ...p,
        at: [...p.at],
        ...(p.rootAt ? { rootAt: [...p.rootAt] } : {}),
        ...(p.snap ? { snap: { ...p.snap } } : {}),
        ...(p.evidence ? { evidence: [...p.evidence] } : {}),
      });
      const out = {
        format: FORMAT,
        version: VERSION,
        meta: { name: '未命名模型', ...(meta || {}) },
        parts: parts.map(clonePart),
      };
      // 子组件刚体组：模块（subassembly:true）+ 装配步（attach）+ submodels/mounts 关系树
      if (assemblies.length) {
        out.modules = assemblies.map((a) => ({ id: a.id, label: a.label, subassembly: true }));
        const nums = [...new Set([...parts.map((p) => p.step || 1), ...assemblies.map((a) => a.attachStep)])].sort((a, b) => a - b);
        out.steps = nums.map((n) => {
          const a = assemblies.find((x) => x.attachStep === n);
          return a ? { n, title: `装上${a.label}`, attach: a.id } : { n, title: `第 ${n} 步` };
        });
        const subKeys = Object.keys(submodels);
        if (subKeys.length) {
          out.submodels = {};
          for (const k of subKeys) {
            out.submodels[k] = {
              label: submodels[k].label,
              anchor: submodels[k].anchor,
              parts: submodels[k].parts.map(clonePart),
            };
          }
        }
        out.mounts = assemblies.map((a) => ({
          id: a.id,
          submodel: a.submodel || a.id,
          on: a.on,
          stud: a.stud,
          anchor: a.anchor,
          anchorReceptor: a.anchorReceptor,
          rot: a.rot,
          step: a.attachStep,
          label: a.label,
        }));
      }
      return out;
    },

    /** 当前零件列表（深拷贝） */
    parts() {
      return parts.map((p) => ({
        ...p,
        at: [...p.at],
        ...(p.rootAt ? { rootAt: [...p.rootAt] } : {}),
        ...(p.snap ? { snap: { ...p.snap } } : {}),
        ...(p.evidence ? { evidence: [...p.evidence] } : {}),
      }));
    },

    /** 把模型以 JSON 写入 file（自动建目录），返回文件路径 */
    save(file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(builder.model(), null, 2) + '\n', 'utf8');
      return file;
    },
  };
  return builder;
}
