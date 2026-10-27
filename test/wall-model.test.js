import test from 'node:test';
import assert from 'node:assert/strict';
import { locate, buildWalls, wallCrossings, rssiToDistance } from '../src/index.js';
import { distanceToRssi } from '../src/model.js';

/**
 * 这批测试守的是「墙模型的方向」。
 *
 * 曾经踩过的坑：求解器把穿墙损耗**加到**目标距离上，
 * 而信号换算出的距离里**已经包含**了墙体损耗 —— 加了两次，
 * 结果所有点位被推离真值 3–5 m，标定系数 α 被压到下限 0.35。
 */

const plan = {
  floors: [
    {
      floor: 1,
      rooms: [
        { name: '客厅', x: 0, y: 0, w: 5, h: 4 },
        { name: '卧室', x: 5, y: 0, w: 4, h: 4 },
        { name: '厨房', x: 0, y: 4, w: 4, h: 3 },
      ],
    },
  ],
};

const anchors = [
  { id: 'a1', x: 1, y: 1, z: 0, floor: 1 },
  { id: 'a2', x: 3, y: 6, z: 0, floor: 1 },
  { id: 'a3', x: 8, y: 3, z: 0, floor: 1 },
];

const truth = [
  { id: 's1', x: 3.5, y: 2.5 },
  { id: 's2', x: 7.0, y: 1.5 },
  { id: 's3', x: 1.5, y: 5.5 },
];

const WALL_M = 3.5;

/** 按「距离 + 穿墙等效米数」造信号，模拟真实观测 */
function synthWithWalls() {
  const walls = buildWalls(plan);
  return truth.map((t) => {
    const signals = {};
    for (const a of anchors) {
      const d = Math.hypot(a.x - t.x, a.y - t.y);
      const extra = wallCrossings({ ...t, z: 0, floor: 1 }, a, walls).walls * WALL_M;
      signals[a.id] = Math.round(distanceToRssi(Math.max(0.7, d + extra)));
    }
    return { id: t.id, floor: 1, z: 0, signals };
  });
}

test('有墙时解算误差 < 1.5 m（墙损耗不能重复计算）', () => {
  const r = locate(
    { anchors, samples: synthWithWalls(), plan },
    { wallPenaltyM: WALL_M, iterations: 5000 }
  );
  const errs = r.nodes.map((n) => {
    const t = truth.find((x) => x.id === n.id);
    return Math.hypot(n.x - t.x, n.y - t.y);
  });
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  assert.ok(mean < 1.5, `平均误差 ${mean.toFixed(2)} m（各点 ${errs.map((e) => e.toFixed(2)).join(', ')}）`);
});

test('标定系数应停在 1 附近（符号错了会被压到 0.35 下限）', () => {
  const r = locate(
    { anchors, samples: synthWithWalls(), plan },
    { wallPenaltyM: WALL_M, iterations: 5000 }
  );
  assert.ok(r.alpha > 0.7 && r.alpha < 1.35, `α = ${r.alpha.toFixed(3)} 偏离太多，墙模型方向可能又反了`);
});

test('墙损耗减完后目标距离仍为正（不会算出负距离）', () => {
  // 极端情况：信号很强但穿了很多墙
  const samples = [
    { id: 'x', floor: 1, z: 0, signals: { a1: 96, a2: 96, a3: 96 } },
  ];
  for (const n of locate({ anchors, samples, plan }, { iterations: 800 }).nodes) {
    assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), '坐标出现 NaN');
  }
});

test('不给户型时，墙损耗被硬塞进全局系数 α（α 会明显漂移）', () => {
  // 这是一个诚实记录：样本少、墙型单一时，全局缩放能「假装」抵消墙体损耗，
  // 误差甚至可能更小。所以判断墙模型有没有生效，不能只看误差 —— 要看 α：
  //   带户型 → α 贴近 1（每对点的墙数被单独扣掉了）
  //   不带   → α 被拉到 0.6 左右（用一个全局系数硬凑所有墙）
  const samples = synthWithWalls();
  const withPlan = locate({ anchors, samples, plan }, { wallPenaltyM: WALL_M, iterations: 5000 });
  const without = locate({ anchors, samples }, { iterations: 5000 });

  assert.ok(withPlan.alpha > 0.85, `带户型 α 应在 1 附近，实际 ${withPlan.alpha.toFixed(3)}`);
  assert.ok(without.alpha < 0.75, `不带户型 α 应被拉低，实际 ${without.alpha.toFixed(3)}`);
});
