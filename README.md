# rssi-locate

用 WiFi / BLE 的**信号强度**反推室内设备位置 —— 带户型墙损耗、锚点约束和房间边界。

零依赖。Node ≥ 18。

```bash
npm i rssi-locate
```

## 为什么要有这个包

现成的多点定位库（如 `multilateration`）只做几何：给你若干距离，求一个坐标。

但室内场景里，**光有距离是不够的**，实测会遇到三个问题：

| 问题 | 没有它会怎样 |
|---|---|
| 锚点（路由器）坐标未知 | 只能解出**相对**形状：整张图可旋转、可镜像、可缩放 |
| 不建模墙 | 把「隔两堵墙」和「空手站在旁边」当成一回事，所有点位被往中间拉 |
| 不约束范围 | 解出来的点位可能落在房子外面 |

本包把这三点一起处理：**几何 + 墙体衰减 + 硬边界**。

## 精度预期（先说清楚）

| 精度 | 需要什么 |
|---|---|
| ±3 m | 只有信号 |
| **±1 m** | 信号 + 锚点已知 + 户型 + 墙模型 ← 本包的目标 |
| ±0.2 m | 需要 WiFi RTT（802.11mc）或 UWB，普通设备不支持 |

**这是 RSSI 的物理上限，不是实现问题**：

- 操作系统通常只暴露**百分比**（`Signal: 93%`），2 dB 一档，量化噪声本身就约 1 m
- **近距离饱和**：85% 以上时，1.5 m 和 3 m 的读数没有区别
- 人体、门、家具遮挡会带来 3–6 dB 的瞬时波动

拿卷尺量十几个点大约 10 分钟，比任何算法都准。本包的价值是「不用量」和「能反复量」。

## 快速开始

```js
import { locate } from 'rssi-locate';

const result = locate({
  // 已知坐标的锚点（路由 / 信标）
  anchors: [
    { id: 'ap1', x: 0,  y: 0, z: 0, floor: 1 },
    { id: 'ap2', x: 10, y: 0, z: 0, floor: 1 },
    { id: 'ap3', x: 5,  y: 9, z: 0, floor: 1 },
  ],

  // 每次测量：看到了哪些锚点、信号多少（百分比 0–100）
  samples: [
    { id: 'spot-1', floor: 1, z: 0, signals: { ap1: 78, ap2: 61, ap3: 44 } },
    { id: 'spot-2', floor: 1, z: 0, signals: { ap1: 55, ap2: 82, ap3: 50 } },
  ],
});

for (const n of result.nodes) {
  console.log(n.id, n.x.toFixed(1), n.y.toFixed(1));
}
```

### 加上户型（强烈建议）

给了 `plan`，就会启用**墙损耗**；再给 `bounds`，就会把点位**夹在房间里**。

```js
const plan = {
  floors: [
    {
      floor: 1,
      rooms: [
        { name: '客厅', x: 0, y: 0, w: 5, h: 4 },
        { name: '卧室', x: 5, y: 0, w: 4, h: 4 },
      ],
    },
  ],
  // 独立的附属建筑（车库、厂房…），默认记在一楼
  annex: [{ name: '车库', x: 12, y: 0, w: 4, h: 5 }],
};

const result = locate(
  {
    anchors,
    samples: [
      {
        id: 'spot-1',
        floor: 1,
        z: 0,
        signals: { ap1: 62, ap2: 40 },
        bounds: { x: 5, y: 0, w: 4, h: 4 },   // 已知它在卧室里
      },
    ],
    plan,
  },
  { wallPenaltyM: 3.5 }
);
```

## API

### `locate(input, options?) → Result`

**input**

| 字段 | 类型 | 说明 |
|---|---|---|
| `anchors` | `Anchor[]` | 已知坐标的锚点 |
| `samples` | `Sample[]` | 每次测量 |
| `plan` | `{ floors, annex? }` | 户型；给了才启用墙损耗 |

`Anchor`：`{ id, x, y, z?, floor? }`
`Sample`：`{ id, signals: Record<anchorId, number>, floor?, z?, bounds?: {x,y,w,h} }`

**options**

| 选项 | 默认 | 说明 |
|---|---|---|
| `model` | 见下 | 信号↔距离 的标定参数 |
| `wallPenaltyM` | `3.5` | 一堵墙折合多少米等效距离 |
| `iterations` | `4000` | 梯度下降轮数 |
| `minSeparationM` | `0` | 样本间最小间距（设为 0.5–1 可防止塌成一点） |

**Result**

| 字段 | 说明 |
|---|---|
| `nodes` | `{ id, x, y, z, floor, residual }[]` |
| `residual` | 应力 / 样本数，越小越好（仅供参考，别当精度用） |
| `absolute` | 是否所有锚点都有坐标（`false` 时结果是相对的） |
| `alpha` | 学到的全局距离标定系数（偏离 1 太多会进 `warnings`） |
| `warnings` | 跳过的样本、可疑参数等 |

### 墙模型

```js
import { buildWalls, wallCrossings, wallPenaltyMeters } from 'rssi-locate';

const walls = buildWalls(plan);   // Map<floor, Set<gridCell>>

wallCrossings({ x: 2, y: 1.5, z: 0, floor: 1 },
              { x: 6, y: 1.5, z: 0, floor: 1 }, walls);
// → { walls: 1, floors: 0 }
```

`buildWalls` 把房间矩形的四条边**涂到 0.25 m 栅格**上，然后沿直线采样计数：
每穿过一段**连续墙格**算一堵墙。

**为什么不用线段求交**：相邻两个房间共用的那道墙，会被两边各画一次；
不同房间的墙还常有部分重叠（A 的顶边 `(0,8)-(12,8)` vs B 的底边 `(0,8)-(9.3,8)`）。
线段求交会把这些重复数进去 —— 实测同一段路能算出 5 堵墙，而实际只有 2 堵。

**墙按楼层分开存**：两层的墙线在平面上会重合，混在一起会让一楼判断被二楼干扰。

### 信号模型

```js
import { rssiToDistance, distanceToRssi, rssiToDbm, dbmToRssi, DEFAULT_MODEL } from 'rssi-locate';

DEFAULT_MODEL = { rssiRef: 95, dRef: 0.7, exponent: 48.8, maxDistance: 20 };
// 95% ≈ 0.7 m，30% ≈ 15 m，超过 20 m 封顶
```

指数 `48.8` 比自由空间路损大得多，因为**这里的「距离」揉了穿墙损耗**。
换了环境（不同 AP 发射功率、不同频段）建议重新标定：
选两个已知距离的点，代入 `rssiToDistance` 反解 `exponent`。

`rssiToDbm(rssi) = rssi / 2 - 100` —— 这是 Windows WLAN API 的约定，
用来把百分比换回 dBm 做交叉验证。

## 它是怎么算的

1. **信号 → 等效距离**：`d = dRef · 10^((rssiRef − rssi) / exponent)`
2. **初始化**：用样本间的距离矩阵做经典 MDS（幂迭代求主特征向量，不引入依赖）
3. **梯度下降**：最小化 `Σ w·(实际距离 − 目标距离)²`，
   `目标距离 = 模型距离 × α + 穿墙数 × wallPenaltyM`，`w = 0.25 + rssi/100`
4. **硬约束**：每轮迭代后把点位夹回 `bounds` 矩形
5. **标定**：锚点齐全时，全局系数 `α` 与坐标联合优化，吸收模型的系统性偏差

## 已知限制

| 限制 | 说明 |
|---|---|
| **镜像歧义** | 只有信号时整张图可左右翻转而信号不变。给足锚点（≥3 个不共线）才能消掉 |
| **共线退化** | 锚点几乎共线时，解会塌成一条线。实测加「最小间距排斥」和「初始抖动」都救不回来 —— 那是数据里没有的信息，不是参数问题 |
| **跨层只按 2 堵墙算** | 楼板厚度的差异没有建模 |
| **墙模型是二值的** | 承重墙和隔断墙按同一权重；要区分就调 `wallPenaltyM` 或分多套 `plan` |

## 许可证

MIT
