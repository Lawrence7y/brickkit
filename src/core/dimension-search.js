// 3D 尺寸智能解析、单轴尺寸过滤、多词组合搜索与零件能力判决。

export const CAPABILITY = Object.freeze({
  assemble: 'assemble',
  display: 'display',
  unverified: 'unverified',
});

export const CAPABILITY_LABEL = Object.freeze({
  assemble: '可装配',
  display: '仅展示',
  unverified: '待核实',
});

/**
 * 由目录条目与连接器统计推导能力。
 */
export function classifyCapability(def, connectorStats) {
  if (!def) return { capability: CAPABILITY.unverified, reason: '目录里没有这个零件' };
  if (def.needsManual) return { capability: CAPABILITY.unverified, reason: def.needsManualReason || '目录标记为需人工核对' };
  if (!connectorStats || connectorStats.error) {
    return { capability: CAPABILITY.unverified, reason: '连接器无法从几何生成' };
  }
  const total = connectorStats.total ?? connectorStats.connectorCount ?? 0;
  if (total === 0) return { capability: CAPABILITY.display, reason: '该零件没有可计算的连接接口' };
  return { capability: CAPABILITY.assemble, reason: '' };
}

/**
 * 智能尺寸解析器：
 * 1. 3D: W x L x H[unit]（如 1x4x3, 2x2x2, 1x2x5p, 1x4x1砖, 1 4 3, 2*4*1）
 *    - 前两维宽×长与长×宽对称匹配 [sx, sz] 或 [sz, sx]
 *    - 第三维高度：带 p/片 则精确匹配片高；带 b/砖 则精确匹配砖高 (3片/砖)；
 *      无单位则同时兼容片高与砖高 (h === H 或 h === H * 3)
 * 2. 2D: W x L（如 2x4, 4x2, 2*4, 2×4, 2 4）
 *    - 宽×长与长×宽双向对称匹配
 * 3. 单轴高度: 高3, 高3片, 高1砖, h=3, h:3, h 3, h:1b
 * 4. 单轴宽度: 宽2, w=2, w:2, w 2
 * 5. 单轴长度: 长4, l=4, l:4, l 4
 */
export function parseDimensionQuery(q) {
  const s = String(q || '').trim();
  if (!s) return null;

  // 1. 3D: W x L x H[unit] (e.g. 1x4x3, 2x2x2, 1x2x5p, 1x4x1砖, 1 4 3, 2*4*1)
  const m3 = s.match(/^(\d+(?:\.\d+)?)(?:\s*[x×*]\s*|\s+)(\d+(?:\.\d+)?)(?:\s*[x×*]\s*|\s+)(\d+(?:\.\d+)?)\s*(p|片|b|砖)?$/i);
  if (m3) {
    const d1 = Number(m3[1]), d2 = Number(m3[2]), hRaw = Number(m3[3]);
    const unit = m3[4] ? m3[4].toLowerCase() : null;
    return {
      type: '3d', w: d1, l: d2, hRaw, unit,
      matches(entry) {
        if (!entry || !Array.isArray(entry.size)) return false;
        const [w0, l0] = entry.size;
        if (!((w0 === d1 && l0 === d2) || (w0 === d2 && l0 === d1))) return false;
        const eh = entry.h ?? 1;
        if (unit === 'b' || unit === '砖') return Math.abs(eh - hRaw * 3) < 1e-4;
        if (unit === 'p' || unit === '片') return Math.abs(eh - hRaw) < 1e-4;
        return Math.abs(eh - hRaw) < 1e-4 || Math.abs(eh - hRaw * 3) < 1e-4;
      },
    };
  }

  // 2. 2D: W x L (e.g. 2x4, 4x2, 2*4, 2×4, 2 4)
  const m2 = s.match(/^(\d+(?:\.\d+)?)(?:\s*[x×*]\s*|\s+)(\d+(?:\.\d+)?)$/i);
  if (m2) {
    const d1 = Number(m2[1]), d2 = Number(m2[2]);
    return {
      type: '2d', w: d1, l: d2,
      matches(entry) {
        if (!entry || !Array.isArray(entry.size)) return false;
        const [w0, l0] = entry.size;
        return (w0 === d1 && l0 === d2) || (w0 === d2 && l0 === d1);
      },
    };
  }

  // 3. Single-axis: Height (e.g. 高3, 高3片, 高1砖, h=3, h:3, h 3, h:1b)
  const mH = s.match(/^(?:高\s*|h\s*[:=\s]?\s*)(\d+(?:\.\d+)?)\s*(p|片|b|砖)?$/i);
  if (mH) {
    const hRaw = Number(mH[1]);
    const unit = mH[2] ? mH[2].toLowerCase() : null;
    return {
      type: 'height', hRaw, unit,
      matches(entry) {
        if (!entry) return false;
        const eh = entry.h ?? 1;
        if (unit === 'b' || unit === '砖') return Math.abs(eh - hRaw * 3) < 1e-4;
        if (unit === 'p' || unit === '片') return Math.abs(eh - hRaw) < 1e-4;
        return Math.abs(eh - hRaw) < 1e-4 || Math.abs(eh - hRaw * 3) < 1e-4;
      },
    };
  }

  // 4. Single-axis: Width (e.g. 宽2, w=2, w:2, w 2)
  const mW = s.match(/^(?:宽\s*|w\s*[:=\s]?\s*)(\d+(?:\.\d+)?)$/i);
  if (mW) {
    const val = Number(mW[1]);
    return {
      type: 'width', w: val,
      matches(entry) {
        if (!entry || !Array.isArray(entry.size)) return false;
        return entry.size[0] === val || entry.size[1] === val;
      },
    };
  }

  // 5. Single-axis: Length (e.g. 长4, l=4, l:4, l 4)
  const mL = s.match(/^(?:长\s*|l\s*[:=\s]?\s*)(\d+(?:\.\d+)?)$/i);
  if (mL) {
    const val = Number(mL[1]);
    return {
      type: 'length', l: val,
      matches(entry) {
        if (!entry || !Array.isArray(entry.size)) return false;
        return entry.size[0] === val || entry.size[1] === val;
      },
    };
  }

  return null;
}

/** 单词/单标记匹配（优先尝试尺寸匹配，其次匹配编号、中英文名称与分类） */
export function matchesSingleToken(entry, token) {
  if (!entry || !token) return false;
  const dim = parseDimensionQuery(token);
  if (dim && dim.matches(entry)) return true;
  const t = token.toLowerCase();
  if (String(entry.partId || '').toLowerCase().includes(t)) return true;
  if (String(entry.name || '').toLowerCase().includes(t)) return true;
  if (entry.nameZh && String(entry.nameZh).toLowerCase().includes(t)) return true;
  if (entry.zh && String(entry.zh).toLowerCase().includes(t)) return true;
  if (entry.category && String(entry.category).toLowerCase().includes(t)) return true;
  if (entry.kind && String(entry.kind).toLowerCase().includes(t)) return true;
  if (entry.uiCategory && String(entry.uiCategory).toLowerCase().includes(t)) return true;
  return false;
}

/**
 * 复合查询匹配：支持整句尺寸（如 "2 4"、"1x4x3"）与空格分隔多条件组合（如 "砖 高3 宽2"、"高3 宽2"）。
 * 多条件间为 AND 关系（全部标记均需命中）。
 */
export function matchesItemQuery(entry, q) {
  const raw = String(q || '').trim();
  if (!raw) return true;
  if (!entry) return false;

  // 优先整句尺寸匹配（避免 "2 4" 被拆解成独立的 2 和 4）
  const wholeDim = parseDimensionQuery(raw);
  if (wholeDim) return wholeDim.matches(entry);

  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) {
    return matchesSingleToken(entry, tokens[0]);
  }
  return tokens.every((tok) => matchesSingleToken(entry, tok));
}
