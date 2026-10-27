/**
 * rssi-locate —— 用 WiFi / BLE 信号强度反推室内设备位置。
 *
 * 主打三件事：
 *   1. 户型墙损耗（栅格法，不依赖任何第三方库）
 *   2. 锚点已知时的绝对定位（消掉镜像/旋转/尺度歧义）
 *   3. 房间边界硬约束（点位不许跑到墙外）
 *
 * 精度预期：**纯信号约 ±3 m；锚点 + 户型 + 墙模型约 ±1 m。**
 * 这是 RSSI 的物理上限，不是实现问题 —— 详见 README 的「精度天花板」一节。
 */

export {
  rssiToDistance,
  distanceToRssi,
  rssiToDbm,
  dbmToRssi,
  DEFAULT_MODEL,
} from './model.js';

export {
  buildWalls,
  wallCrossings,
  wallPenaltyMeters,
  DEFAULT_WALL_PENALTY_M,
} from './walls.js';

export { locate } from './locate.js';
