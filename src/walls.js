/**
 * 户型墙模型：算两点之间穿了几堵墙。
 *
 * 为什么用栅格法而不是线段求交：
 *   相邻两个房间共用的那道墙，如果按「每个房间画四条边」来建，
 *   会被两边各画一次；不同房间的墙还常有部分重叠
 *   （A 房间的顶边 (0,8)-(12,8) vs B 房间的底边 (0,8)-(9.3,8)）。
 *   线段求交会把这些重复数进去 —— 实测同一段路能算出 5 堵墙，而实际只有 2 堵。
 *
 *   栅格法：把墙涂到 0.25 m 网格上，重复部分自然合并；
 *   然后沿直线走一遍，**每穿过一段连续墙格算一堵墙**。
 */

const CELL = 0.25;

/**
 * @typedef {{ x: number, y: number, w: number, h: number, name?: string }} Room
 * @typedef {{ floor: number, rooms: Room[] }} FloorLike
 * @typedef {{ x: number, y: number, z?: number, floor?: number }} Point
 */

/**
 * 把户型的房间矩形栅格化成墙集合，**按楼层分开**。
 *
 * 按楼层分开是必须的：两层楼的墙线在平面上会重合，
 * 混在一起会让一楼的判断被二楼的墙干扰（实测「同一房间内两点」能算出穿 2 堵墙）。
 *
 * @param {{ floors?: FloorLike[], annex?: (Room & { name?: string })[] }} plan
 * @returns {Map<number, Set<string>>} 楼层 → 墙格集合
 */
export function buildWalls(plan = {}) {
  const byFloor = new Map();
  const bucket = (f) => {
    if (!byFloor.has(f)) byFloor.set(f, new Set());
    return byFloor.get(f);
  };

  const paint = (cells, a, b) => {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (CELL * 0.4)));
    for (let i = 0; i <= n; i++) {
      const x = a.x + ((b.x - a.x) * i) / n;
      const y = a.y + ((b.y - a.y) * i) / n;
      cells.add(`${Math.round(x / CELL)},${Math.round(y / CELL)}`);
    }
  };

  const blocks = [
    ...(plan.floors ?? []).map((f) => ({ floor: f.floor ?? 1, rooms: f.rooms ?? [] })),
    // 独立附属建筑（车库、厂房…）默认记在一楼
    ...(plan.annex?.length ? [{ floor: 1, rooms: plan.annex }] : []),
  ];

  for (const blk of blocks) {
    const cells = bucket(blk.floor);
    for (const r of blk.rooms) {
      if (!r || !(r.w > 0) || !(r.h > 0)) continue;
      const p1 = { x: r.x, y: r.y };
      const p2 = { x: r.x + r.w, y: r.y };
      const p3 = { x: r.x + r.w, y: r.y + r.h };
      const p4 = { x: r.x, y: r.y + r.h };
      paint(cells, p1, p2);
      paint(cells, p2, p3);
      paint(cells, p3, p4);
      paint(cells, p4, p1);
    }
  }
  return byFloor;
}

/**
 * 两点之间穿墙数。
 *
 * 跨楼层时至少穿过一块楼板，按 2 堵墙折算（楼板的衰减通常大于一面内墙）。
 *
 * @param {Point} a
 * @param {Point} b
 * @param {Map<number, Set<string>>} walls `buildWalls` 的返回值
 * @returns {{ walls: number, floors: number }}
 */
export function wallCrossings(a, b, walls) {
  const fa = a.floor ?? 1;
  const fb = b.floor ?? 1;
  if ((a.z ?? 0) !== (b.z ?? 0) || fa !== fb) return { walls: 2, floors: 1 };

  const cells = walls.get(fa);
  if (!cells || cells.size === 0) return { walls: 0, floors: 0 };

  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(2, Math.ceil(dist / (CELL * 0.5)));
  let count = 0;
  let inWall = false;

  for (let i = 0; i <= steps; i++) {
    const x = a.x + ((b.x - a.x) * i) / steps;
    const y = a.y + ((b.y - a.y) * i) / steps;
    const gx = Math.round(x / CELL);
    const gy = Math.round(y / CELL);

    // 3×3 邻域：斜穿网格时单点判定会漏格，把同一道墙数成两堵
    let hit = false;
    for (let dx = -1; dx <= 1 && !hit; dx++) {
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        if (cells.has(`${gx + dx},${gy + dy}`)) hit = true;
      }
    }
    if (hit && !inWall) count++;
    inWall = hit;
  }
  return { walls: count, floors: 0 };
}

/**
 * 一堵墙折合多少米等效距离。
 *
 * 标定依据：5 GHz 穿过一道内墙约 12 dB；本库的距离指数是 24.4 dB/decade，
 * 每 dB 约等于 +9.9% 距离，12 dB ≈ 3.1 倍。
 * 在 10 m 的路径上，一堵墙大约相当于多走 3~4 m。
 */
export const DEFAULT_WALL_PENALTY_M = 3.5;

/**
 * 两点之间的墙损耗，折算成等效距离增量（米）。
 *
 * @param {Point} a
 * @param {Point} b
 * @param {Map<number, Set<string>>} walls
 * @param {number} [penaltyPerWall]
 * @returns {number} 米
 */
export function wallPenaltyMeters(a, b, walls, penaltyPerWall = DEFAULT_WALL_PENALTY_M) {
  return wallCrossings(a, b, walls).walls * penaltyPerWall;
}
