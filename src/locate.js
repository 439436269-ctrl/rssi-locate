/**
 * 从「样本 × 锚点」的信号矩阵解算坐标。
 *
 * 三种约束，缺一层就散（这是本库的核心）：
 *
 *   1. **锚点坐标已知**   → 每个样本变成独立的三边定位问题，镜像/旋转/尺度歧义消失
 *   2. **户型墙损耗**     → 把「隔两堵墙」和「空手站在旁边」区分开，否则所有点被往中间拉
 *   3. **房间边界**       → 硬约束，样本夹回它该在的房间矩形里，不许跑出去
 *
 * 只有第 1 层时坐标是「相对」的；三层齐了才是真实米制。
 */

import { rssiToDistance, DEFAULT_MODEL } from './model.js';
import { buildWalls, wallCrossings, DEFAULT_WALL_PENALTY_M } from './walls.js';

/**
 * @typedef {Object} Anchor 已知坐标的锚点（AP / 信标）
 * @property {string} id
 * @property {number} x
 * @property {number} y
 * @property {number} [z]
 * @property {number} [floor]
 *
 * @typedef {Object} Sample 一次测量
 * @property {string} id
 * @property {Record<string, number>} signals  锚点 id → 信号百分比
 * @property {number} [floor]
 * @property {number} [z]
 * @property {{ x: number, y: number, w: number, h: number }} [bounds] 允许范围（房间矩形）
 *
 * @typedef {Object} LocateOptions
 * @property {Partial<typeof DEFAULT_MODEL>} [model]
 * @property {number} [wallPenaltyM]   一堵墙折合多少米
 * @property {number} [iterations]     梯度下降轮数
 * @property {number} [minSeparationM] 样本间最小间距（防止全部塌成一点）
 */

/**
 * 经典多维标度：用距离矩阵求前两个主轴的初始坐标（幂迭代，不引入依赖）。
 * @param {number[][]} D 对称距离矩阵
 * @param {number} [dims]
 * @returns {{ x: number[], y: number[] }}
 */
function classicalMDS(D, dims = 2) {
  const n = D.length;
  // 双中心化 B = -0.5 * J D² J
  const D2 = D.map((row) => row.map((d) => d * d));
  const rowMean = D2.map((r) => r.reduce((a, b) => a + b, 0) / n);
  const total = rowMean.reduce((a, b) => a + b, 0) / n;
  const B = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => -0.5 * (D2[i][j] - rowMean[i] - rowMean[j] + total))
  );

  const out = { x: new Array(n).fill(0), y: new Array(n).fill(0) };
  const keys = ['x', 'y'].slice(0, dims);

  for (const key of keys) {
    // 幂迭代求最大特征向量
    let v = Array.from({ length: n }, (_, i) => (i % 2 ? 1 : -1) + 1e-3 * i);
    for (let it = 0; it < 200; it++) {
      const w = B.map((row) => row.reduce((a, b, j) => a + b * v[j], 0));
      const norm = Math.hypot(...w) || 1;
      v = w.map((x) => x / norm);
    }
    const lambda = v.reduce((a, vi, i) => a + vi * B[i].reduce((s, b, j) => s + b * v[j], 0), 0);
    const scale = Math.sqrt(Math.max(0, lambda));
    out[key] = v.map((vi) => vi * scale);
    // 收缩掉这一维，下一轮拿次大
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) B[i][j] -= lambda * v[i] * v[j];
    }
  }
  return out;
}

/**
 * 解算样本坐标。
 *
 * @param {Object} input
 * @param {Anchor[]} input.anchors
 * @param {Sample[]} input.samples
 * @param {{ floors?: any[], annex?: any[] }} [input.plan]  给了就启用墙损耗
 * @param {LocateOptions} [options]
 * @returns {{
 *   nodes: { id: string, x: number, y: number, z: number, floor: number, residual: number }[],
 *   anchors: Anchor[],
 *   residual: number,
 *   absolute: boolean,
 *   warnings: string[]
 * }}
 */
export function locate({ anchors = [], samples = [], plan = null }, options = {}) {
  const {
    model = {},
    wallPenaltyM = DEFAULT_WALL_PENALTY_M,
    iterations = 4000,
    minSeparationM = 0,
  } = options;

  const warnings = [];
  if (!anchors.length) throw new Error('locate(): at least one anchor is required');
  if (!samples.length) throw new Error('locate(): at least one sample is required');

  const walls = plan ? buildWalls(plan) : null;
  if (plan) {
    let cells = 0;
    for (const set of walls.values()) cells += set.size;
    if (cells === 0) warnings.push('plan 里没有有效房间矩形，墙损耗未启用');
  }

  // 只用同时被 ≥2 个锚点看到的样本
  const usable = samples.filter((s) => Object.keys(s.signals ?? {}).length >= 2);
  if (usable.length < samples.length) {
    warnings.push(`${samples.length - usable.length} 个样本只看到 <2 个锚点，已跳过`);
  }

  // 每个样本对每个锚点的目标等效距离
  const obs = usable.map((s) => {
    const list = [];
    for (const [aid, rssi] of Object.entries(s.signals)) {
      const a = anchors.find((x) => x.id === aid);
      if (!a || typeof rssi !== 'number') continue;
      list.push({ anchor: a, dist: rssiToDistance(rssi, model), rssi, akey: a.id });
    }
    return { sample: s, list };
  });

  const seen = obs.filter((o) => o.list.length >= 1);
  const n = seen.length;
  if (!n) throw new Error('locate(): no sample has a usable signal reading');

  // 距离矩阵：样本↔样本（借最短路径近似，样本间常无直接观测）
  const D = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const shared = [];
      for (const oi of seen[i].list) {
        const oj = seen[j].list.find((x) => x.akey === oi.akey);
        if (oj) shared.push(Math.abs(oi.dist - oj.dist));
      }
      const guess = shared.length
        ? Math.max(...shared)
        : Math.abs(seen[i].list[0].dist - seen[j].list[0].dist);
      D[i][j] = D[j][i] = Math.max(0.5, guess);
    }
  }

  // 初始化：MDS，或者锚点重心 + 抖动
  const init = classicalMDS(D);
  const anchoredAll = anchors.every((a) => Number.isFinite(a.x) && Number.isFinite(a.y));
  const cxA = anchors.reduce((s, a) => s + (a.x || 0), 0) / anchors.length;
  const cyA = anchors.reduce((s, a) => s + (a.y || 0), 0) / anchors.length;

  const pos = seen.map((o, i) => ({
    x: anchoredAll ? cxA + init.x[i] : init.x[i],
    y: anchoredAll ? cyA + init.y[i] : init.y[i],
    z: o.sample.z ?? (o.sample.floor === 2 ? 3.2 : 0),
    floor: o.sample.floor ?? 1,
  }));

  // 全局距离标定系数：锚点已知时它可以被学出来，吸收模型的系统性偏差
  let alpha = 1;
  const roomBox = seen.map((o) => {
    const b = o.sample.bounds;
    return b && b.w > 0 && b.h > 0
      ? { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h }
      : null;
  });

  let lr = 0.06;
  let stress = 0;

  for (let it = 0; it < iterations; it++) {
    const grad = pos.map(() => ({ x: 0, y: 0 }));
    let dAlpha = 0;
    stress = 0;

    for (let i = 0; i < n; i++) {
      // 样本 ↔ 锚点
      for (const o of seen[i].list) {
        const dx = pos[i].x - (o.anchor.x ?? 0);
        const dy = pos[i].y - (o.anchor.y ?? 0);
        const dz = pos[i].z - (o.anchor.z ?? (o.anchor.floor === 2 ? 3.2 : 0));
        const dist = Math.hypot(dx, dy, dz) || 1e-6;

        let extra = 0;
        if (walls) {
          extra =
            wallCrossings(
              { x: pos[i].x, y: pos[i].y, z: pos[i].z, floor: pos[i].floor },
              { x: o.anchor.x ?? 0, y: o.anchor.y ?? 0, z: o.anchor.z ?? (o.anchor.floor === 2 ? 3.2 : 0), floor: o.anchor.floor ?? 1 },
              walls
            ).walls * wallPenaltyM;
        }

        // 关键：墙体损耗**已经包含**在信号换算出的距离里（穿墙 → 信号更低 → 等效距离更长）。
        // 所以这里要把它**减掉**，还原成几何距离，不能再加一次。
        //   信号 → d_eff = d_geom + 穿墙数 × wallPenaltyM
        //   求解 ← d_geom = d_eff − 穿墙数 × wallPenaltyM
        const target = Math.max(0.3, o.dist * alpha - extra);
        const diff = dist - target;
        const w = 0.25 + o.rssi / 100;
        stress += w * diff * diff;
        const g = (2 * w * diff) / dist;
        grad[i].x += g * dx;
        grad[i].y += g * dy;
        if (anchoredAll) dAlpha += 2 * w * diff * -o.dist;
      }

      // 样本 ↔ 样本：只做最小间距排斥，防止全部塌成一点
      if (minSeparationM > 0) {
        for (let j = i + 1; j < n; j++) {
          const dx = pos[i].x - pos[j].x;
          const dy = pos[i].y - pos[j].y;
          const dz = pos[i].z - pos[j].z;
          const dist = Math.hypot(dx, dy, dz) || 1e-6;
          if (dist < minSeparationM) {
            const push = minSeparationM - dist;
            const g = 2 * 0.25 * push;
            grad[i].x += (g * dx) / dist;
            grad[i].y += (g * dy) / dist;
            grad[j].x -= (g * dx) / dist;
            grad[j].y -= (g * dy) / dist;
            stress += 0.25 * push * push;
          }
        }
      }
    }

    for (let i = 0; i < n; i++) {
      pos[i].x -= lr * grad[i].x;
      pos[i].y -= lr * grad[i].y;
      const b = roomBox[i];
      if (b) {
        pos[i].x = Math.min(b.x1, Math.max(b.x0, pos[i].x));
        pos[i].y = Math.min(b.y1, Math.max(b.y0, pos[i].y));
      }
    }
    if (anchoredAll) alpha = Math.max(0.35, Math.min(3.0, alpha - lr * 0.02 * dAlpha));
    if (it % 800 === 0 && it > 0) lr *= 0.6;
  }

  if (anchoredAll && Math.abs(alpha - 1) > 0.25) {
    warnings.push(`距离标定系数学到 ${alpha.toFixed(2)}，偏离默认值较多，建议检查 model 参数`);
  }

  const nodes = pos.map((p, i) => ({
    id: seen[i].sample.id,
    x: p.x,
    y: p.y,
    z: p.z,
    floor: p.floor,
    residual: stress / Math.max(1, n),
  }));

  return {
    nodes,
    anchors,
    residual: stress / Math.max(1, n),
    absolute: anchoredAll,
    alpha,
    warnings,
  };
}
