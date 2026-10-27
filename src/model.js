/**
 * 信号强度 ↔ 距离 的互相换算。
 *
 * 默认参数来自室内实测标定（2.4/5 GHz 混测，含穿墙损耗）。
 * 这里的「距离」不是几何距离，而是**等效传播距离** —— 一堵墙相当于多走几米。
 * 两者分开建模：几何距离由坐标给出，墙损耗由 floorplan 给出。
 */

/** 默认标定：95% ≈ 0.7 m，30% ≈ 15 m */
export const DEFAULT_MODEL = {
  rssiRef: 95,     // 参考信号（百分比）
  dRef: 0.7,       // 参考距离（米）
  exponent: 48.8,  // 衰减指数：每下降 48.8 个百分点，距离 ×10
  maxDistance: 20, // 距离上限（米），防止弱信号算出天文数字
};

/**
 * 信号百分比 → 等效距离（米）。
 *
 * @param {number} rssi
 * @param {Partial<typeof DEFAULT_MODEL>} [model]
 * @returns {number} 米
 */
export function rssiToDistance(rssi, model = {}) {
  const { rssiRef, dRef, exponent, maxDistance } = { ...DEFAULT_MODEL, ...model };
  const d = dRef * Math.pow(10, (rssiRef - rssi) / exponent);
  return Math.min(maxDistance, d);
}

/**
 * 等效距离（米）→ 信号百分比。`rssiToDistance` 的逆函数。
 *
 * @param {number} distance
 * @param {Partial<typeof DEFAULT_MODEL>} [model]
 * @returns {number}
 */
export function distanceToRssi(distance, model = {}) {
  const { rssiRef, dRef, exponent } = { ...DEFAULT_MODEL, ...model };
  return rssiRef - exponent * Math.log10(Math.max(1e-6, distance) / dRef);
}

/**
 * 信号百分比 ↔ dBm 的近似换算（Windows WLAN API 的约定）。
 *
 * 注意：**操作系统通常只暴露百分比**，这一步是往回推 dBm，
 * 量化步长 2 dB —— 这本身就是约 1 m 的定位噪声。
 *
 * @param {number} rssi 0–100
 * @returns {number} dBm（约 -100 … -50）
 */
export function rssiToDbm(rssi) {
  return rssi / 2 - 100;
}

/**
 * dBm → 信号百分比（`rssiToDbm` 的逆函数），并裁剪到 0–100。
 * @param {number} dbm
 * @returns {number}
 */
export function dbmToRssi(dbm) {
  return Math.max(0, Math.min(100, (dbm + 100) * 2));
}
