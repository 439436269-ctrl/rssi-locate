import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWalls, wallCrossings, wallPenaltyMeters } from '../src/walls.js';
import { rssiToDistance, distanceToRssi, rssiToDbm, dbmToRssi } from '../src/model.js';

/** 一间 4×3 的房 + 旁边一间 3×3，外加一栋东侧独立小屋 */
const plan = {
  floors: [
    {
      floor: 1,
      rooms: [
        { name: 'A', x: 0, y: 0, w: 4, h: 3 },
        { name: 'B', x: 4, y: 0, w: 3, h: 3 },
      ],
    },
    { floor: 2, rooms: [{ name: 'C', x: 0, y: 0, w: 4, h: 3 }] },
  ],
  annex: [{ name: '小屋', x: 12, y: 0, w: 3, h: 3 }],
};

const walls = buildWalls(plan);

test('墙格按楼层分开存', () => {
  assert.ok(walls.has(1) && walls.has(2));
  assert.ok(walls.get(1).size > 0 && walls.get(2).size > 0);
});

test('同一房间内两点：0 堵墙', () => {
  const r = wallCrossings({ x: 1, y: 1.5, z: 0, floor: 1 }, { x: 3, y: 1.5, z: 0, floor: 1 }, walls);
  assert.equal(r.walls, 0);
});

test('相邻两个房间之间：1 堵墙', () => {
  const r = wallCrossings({ x: 2, y: 1.5, z: 0, floor: 1 }, { x: 6, y: 1.5, z: 0, floor: 1 }, walls);
  assert.equal(r.walls, 1);
});

test('共用墙不会被重复计数（A→B 与 B→A 一样）', () => {
  const a = wallCrossings({ x: 2, y: 1.5, z: 0, floor: 1 }, { x: 6, y: 1.5, z: 0, floor: 1 }, walls);
  const b = wallCrossings({ x: 6, y: 1.5, z: 0, floor: 1 }, { x: 2, y: 1.5, z: 0, floor: 1 }, walls);
  assert.equal(a.walls, b.walls);
});

test('跨楼层按 2 堵墙折算', () => {
  const r = wallCrossings({ x: 2, y: 1.5, z: 0, floor: 1 }, { x: 2, y: 1.5, z: 3.2, floor: 2 }, walls);
  assert.equal(r.walls, 2);
  assert.equal(r.floors, 1);
});

test('主楼到独立小屋：两侧外墙共 2 堵', () => {
  // 从 B 房间出发（不穿 A→B 那道内墙）：B 的东外墙 + 小屋的西外墙
  const r = wallCrossings({ x: 5, y: 1.5, z: 0, floor: 1 }, { x: 13.5, y: 1.5, z: 0, floor: 1 }, walls);
  assert.equal(r.walls, 2);
});

test('从更深处的房间去小屋，中间的内墙也算上', () => {
  // 起点在 A：出门先穿 A→B 的内墙，再是 B 外墙、小屋外墙，共 3 堵
  const r = wallCrossings({ x: 1, y: 1, z: 0, floor: 1 }, { x: 13.5, y: 1.5, z: 0, floor: 1 }, walls);
  assert.equal(r.walls, 3);
});

test('二楼墙不干扰一楼判断', () => {
  // 2F 的 C 房间在 (0,0)-(4,3)，与 1F 的 A 完全重合；
  // 如果两层墙混在一起，一楼房间内的这段直线会数出墙
  const r = wallCrossings({ x: 0.5, y: 1.5, z: 0, floor: 1 }, { x: 3.5, y: 1.5, z: 0, floor: 1 }, walls);
  assert.equal(r.walls, 0);
});

test('没有户型时穿墙数为 0（不报错）', () => {
  const empty = buildWalls({});
  const r = wallCrossings({ x: 0, y: 0, z: 0, floor: 1 }, { x: 10, y: 0, z: 0, floor: 1 }, empty);
  assert.equal(r.walls, 0);
});

test('墙损耗按每堵墙的米数折算', () => {
  const a = { x: 2, y: 1.5, z: 0, floor: 1 };
  const b = { x: 6, y: 1.5, z: 0, floor: 1 };
  assert.equal(wallPenaltyMeters(a, b, walls, 3.5), 3.5);
  assert.equal(wallPenaltyMeters(a, b, walls, 7), 7);
});

test('信号 → 距离 是单调递减的', () => {
  const d90 = rssiToDistance(90);
  const d60 = rssiToDistance(60);
  const d30 = rssiToDistance(30);
  assert.ok(d90 < d60 && d60 < d30);
  assert.ok(d90 > 0);
});

test('信号 → 距离 有上限，不会算出天文数字', () => {
  assert.ok(rssiToDistance(1) <= 20);
});

test('距离 ↔ 信号 互为逆运算', () => {
  for (const rssi of [90, 75, 60, 45, 30]) {
    const back = distanceToRssi(rssiToDistance(rssi));
    assert.ok(Math.abs(back - rssi) < 1e-6, `rssi=${rssi} 回推得到 ${back}`);
  }
});

test('百分比 ↔ dBm 的换算符合 Windows 约定', () => {
  assert.equal(rssiToDbm(100), -50);
  assert.equal(rssiToDbm(60), -70);
  assert.equal(dbmToRssi(-70), 60);
  assert.equal(dbmToRssi(-200), 0);   // 裁剪
});
