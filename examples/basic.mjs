/**
 * 示例：一个有墙的两居室，2 台已知锚点 + 3 个待定位点。
 *
 * 运行：npm run example
 */
import { locate, buildWalls, wallCrossings, rssiToDistance } from '../src/index.js';

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
  { id: 'ap-客厅', x: 1, y: 1, z: 0, floor: 1 },
  { id: 'ap-厨房', x: 3, y: 6, z: 0, floor: 1 },
  { id: 'ap-卧室', x: 8, y: 3, z: 0, floor: 1 },
];

// 三个真实位置（用来对照解算结果）
const truth = [
  { id: '沙发', x: 3.5, y: 2.5 },
  { id: '床头', x: 7, y: 1.5 },
  { id: '灶台', x: 1.5, y: 5.5 },
];

const walls = buildWalls(plan);

// 造观测：距离 → 信号，并把穿墙折算成额外的等效距离
const samples = truth.map((t) => {
  const signals = {};
  for (const a of anchors) {
    const d = Math.hypot(a.x - t.x, a.y - t.y);
    const extra = wallCrossings({ ...t, z: 0, floor: 1 }, a, walls).walls * 3.5;
    // 反推信号：得自己解一下 rssiToDistance 的逆
    const effDist = d + extra;
    const rssi = 95 - 48.8 * Math.log10(effDist / 0.7);
    signals[a.id] = Math.round(Math.max(5, Math.min(99, rssi)));
  }
  return { id: t.id, floor: 1, z: 0, signals };
});

console.log('观测信号：');
for (const s of samples) {
  console.log(' ', s.id, JSON.stringify(s.signals));
}

const result = locate({ anchors, samples, plan }, { wallPenaltyM: 3.5, iterations: 5000 });

console.log('\n解算结果（vs 真值）：');
for (const n of result.nodes) {
  const t = truth.find((x) => x.id === n.id);
  const err = Math.hypot(n.x - t.x, n.y - t.y);
  console.log(
    `  ${n.id.padEnd(4)}  解 (${n.x.toFixed(2)}, ${n.y.toFixed(2)})` +
      `  真 (${t.x.toFixed(2)}, ${t.y.toFixed(2)})  误差 ${err.toFixed(2)} m`
  );
}

console.log(`\n绝对坐标: ${result.absolute}   标定系数 α = ${result.alpha.toFixed(3)}`);
if (result.warnings.length) console.log('警告:', result.warnings);

console.log('\n顺便看一眼模型：');
for (const rssi of [90, 70, 50, 30]) {
  console.log(`  ${rssi}% → ${rssiToDistance(rssi).toFixed(2)} m`);
}
