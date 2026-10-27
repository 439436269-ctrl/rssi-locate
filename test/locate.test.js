import test from 'node:test';
import assert from 'node:assert/strict';
import { locate } from '../src/index.js';
import { distanceToRssi } from '../src/model.js';

/** 用真实几何 + 简化路损造一批「完美」测量，验证解算能回到原点位 */
function synth(anchors, truth, extraWalls = 0) {
  return truth.map((t, i) => {
    const signals = {};
    for (const a of anchors) {
      const d = Math.hypot(a.x - t.x, a.y - t.y);
      // 完美模型：信号只由距离决定
      signals[a.id] = Math.round(distanceToRssi(Math.max(0.7, d + extraWalls)));
    }
    return { id: `p${i}`, floor: 1, z: 0, signals };
  });
}

const anchors = [
  { id: 'a1', x: 0, y: 0, z: 0, floor: 1 },
  { id: 'a2', x: 10, y: 0, z: 0, floor: 1 },
  { id: 'a3', x: 5, y: 9, z: 0, floor: 1 },
];

const truth = [
  { x: 2, y: 2 },
  { x: 8, y: 3 },
  { x: 4, y: 7 },
];

test('锚点坐标齐全时输出绝对坐标', () => {
  const samples = synth(anchors, truth);
  const r = locate({ anchors, samples }, { iterations: 3000 });
  assert.equal(r.absolute, true);
  assert.equal(r.nodes.length, 3);
});

test('完美数据能还原到 1.5 m 以内', () => {
  const samples = synth(anchors, truth);
  const r = locate({ anchors, samples }, { iterations: 5000 });
  const errs = r.nodes.map((n) => {
    const t = truth[Number(n.id.slice(1))];
    return Math.hypot(n.x - t.x, n.y - t.y);
  });
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  assert.ok(mean < 1.5, `平均误差 ${mean.toFixed(2)} m 太大（${errs.map((e) => e.toFixed(2)).join(', ')}）`);
});

test('房间边界约束会把点位夹回矩形内', () => {
  const samples = synth(anchors, truth).map((s) => ({
    ...s,
    bounds: { x: 3, y: 6, w: 2, h: 2 },   // 只有一个「房间」
  }));
  const r = locate({ anchors, samples }, { iterations: 3000 });
  for (const n of r.nodes) {
    assert.ok(n.x >= 3 && n.x <= 5, `x=${n.x} 超出 [3,5]`);
    assert.ok(n.y >= 6 && n.y <= 8, `y=${n.y} 超出 [6,8]`);
  }
});

test('给了户型就启用墙损耗（不报错且仍有结果）', () => {
  const plan = {
    floors: [
      {
        floor: 1,
        rooms: [
          { name: 'A', x: 0, y: 0, w: 5, h: 4 },
          { name: 'B', x: 5, y: 0, w: 5, h: 4 },
          { name: 'C', x: 0, y: 4, w: 5, h: 5 },
        ],
      },
    ],
  };
  const samples = synth(anchors, truth);
  const r = locate({ anchors, samples, plan }, { iterations: 3000 });
  assert.equal(r.nodes.length, 3);
  assert.ok(Number.isFinite(r.residual));
});

test('只有 1 个锚点可见的样本被跳过并给出警告', () => {
  const samples = [
    ...synth(anchors, truth),
    { id: 'thin', floor: 1, z: 0, signals: { a1: 80 } },
  ];
  const r = locate({ anchors, samples }, { iterations: 1000 });
  assert.equal(r.nodes.length, 3);
  assert.ok(r.warnings.some((w) => w.includes('已跳过')));
});

test('缺少锚点或样本时明确报错', () => {
  assert.throws(() => locate({ anchors: [], samples: [{ id: 'x', signals: {} }] }), /anchor/i);
  assert.throws(() => locate({ anchors, samples: [] }), /sample/i);
});
