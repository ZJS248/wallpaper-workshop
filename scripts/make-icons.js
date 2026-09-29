'use strict';
/**
 * 应用 / 托盘图标生成器（零依赖）。
 *
 * 为什么自己光栅化而不是手绘 PNG：
 *   - 旧的 electron/icon.png 是个「蓝色圆角方块 + 白色文件夹」，应用图标和托盘图标
 *     长得一模一样，而且完全没表达「壁纸」这件事。
 *   - 仓库不装任何图像库（项目坚持零依赖 + 无构建步骤），所以这里用 Node 内置的
 *     zlib 自己做一遍最小光栅器 + PNG 编码：能画圆角矩形、圆、三角形和线性渐变，
 *     4 倍超采样做抗锯齿，足够画一枚干净的扁平图标。
 *
 * 设计（对齐 Wallpaper Engine 的观感，但不抄它的商标）：
 *   蓝色渐变圆角方块 + 白色「画面」字形 = 相框描边 + 山峦 + 太阳。
 *   语义直白，缩到 16px（托盘）仍然认得出是「壁纸」而不是「文件夹」。
 *
 * 产出：
 *   electron/icon.png   256x256   → package.json 的 build.win.icon，.ico 由 electron-builder 生成
 *   electron/tray.png    64x64    → 托盘
 *   控制台打印 64x64 的 base64，供 electron/main.js 的 TRAY_PNG_BASE64 使用
 *
 * 用法： node scripts/make-icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ============================================================================
 * 一、最小 PNG 编码器（RGBA / 8bit）
 * ========================================================================== */

/** CRC-32（PNG 分块校验用），表在第一次调用时生成 */
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** RGBA 像素缓冲 → PNG 文件内容 */
function encodePng(canvas) {
  const { width: w, height: h, data } = canvas;

  // 每行前置一个过滤器字节（0 = None；本项目图形都是大面积纯色，None 足够且最简单）
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const dst = y * (w * 4 + 1);
    raw[dst] = 0;
    data.copy(raw, dst + 1, y * w * 4, (y + 1) * w * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type 6 = RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ============================================================================
 * 二、最小光栅器
 * ========================================================================== */

function createCanvas(size) {
  return { width: size, height: size, data: Buffer.alloc(size * size * 4) };
}

/**
 * 把一个「在坐标 (u,v) 上返回 [r,g,b,a]（0~1）或 null」的有向函数铺到画布上。
 * SS 倍超采样：每个像素算 SS*SS 个子样本取平均，得到抗锯齿边缘。
 */
function paint(canvas, fn, ss) {
  const S = ss || 4;
  const { width: w, height: h, data } = canvas;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (x + (sx + 0.5) / S) / w;
          const v = (y + (sy + 0.5) / S) / h;
          const c = fn(u, v);
          if (!c) continue;
          const alpha = c[3] === undefined ? 1 : c[3];
          r += c[0] * alpha;
          g += c[1] * alpha;
          b += c[2] * alpha;
          a += alpha;
        }
      }
      const n = S * S;
      if (a <= 0) continue;
      // 颜色按覆盖率归一（premultiply → unpremultiply），边缘才不会发黑
      const i = (y * w + x) * 4;
      data[i] = Math.round(Math.max(0, Math.min(255, (r / a) * 255)));
      data[i + 1] = Math.round(Math.max(0, Math.min(255, (g / a) * 255)));
      data[i + 2] = Math.round(Math.max(0, Math.min(255, (b / a) * 255)));
      data[i + 3] = Math.round((a / n) * 255);
    }
  }
}

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

/** 圆角矩形的有向距离（<=0 在内部），中心 + 半尺寸 + 圆角半径 */
function sdRoundRect(u, v, cx, cy, hw, hh, r) {
  const qx = Math.abs(u - cx) - (hw - r);
  const qy = Math.abs(v - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 圆的有向距离 */
function sdCircle(u, v, cx, cy, r) {
  return Math.hypot(u - cx, v - cy) - r;
}

/** 线段的有向距离（用于相框描边） */
function sdSegment(u, v, ax, ay, bx, by) {
  const pax = u - ax, pay = v - ay;
  const bax = bx - ax, bay = by - ay;
  const h = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

/**
 * 三角形的有向距离（先按半平面取交集）。
 * verts = [[x,y] × 3]，顶点按顺时针/逆时针任一方向给出即可（内部取三者最大值）。
 */
function sdTriangle(u, v, verts) {
  const [a, b, c] = verts;
  // 用叉积的符号统一成「内部为正」
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const sign = cross(a, b, c) >= 0 ? 1 : -1;
  const d1 = sign * cross(a, b, [u, v]);
  const d2 = sign * cross(b, c, [u, v]);
  const d3 = sign * cross(c, a, [u, v]);
  const inside = d1 >= 0 && d2 >= 0 && d3 >= 0;
  if (inside) {
    // 内部：取到三条边的最小距离（取负）
    const e1 = sdSegment(u, v, a[0], a[1], b[0], b[1]);
    const e2 = sdSegment(u, v, b[0], b[1], c[0], c[1]);
    const e3 = sdSegment(u, v, c[0], c[1], a[0], a[1]);
    return -Math.min(e1, e2, e3);
  }
  return Math.min(
    sdSegment(u, v, a[0], a[1], b[0], b[1]),
    sdSegment(u, v, b[0], b[1], c[0], c[1]),
    sdSegment(u, v, c[0], c[1], a[0], a[1])
  );
}

/* ============================================================================
 * 三、图标本体
 * ========================================================================== */

/** #rrggbb → [r,g,b] (0~1) */
function hex(c) {
  const n = parseInt(c.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const BRAND_TOP = hex('#1a9fff');
const BRAND_BOT = hex('#0d6fc4');
const WHITE = [1, 1, 1];

/** 把 #rrggbb 与白色按 t 混合（用来做山峦的第二层颜色） */
function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * 画一版图标。
 *
 * 构图（全部用归一化坐标 0~1，这样 256 和 64 缩放出来的比例完全一致）：
 *   1. 圆角方块：中心 (0.5,0.5)，半尺寸 0.5，圆角 0.225（≈ 22%）
 *   2. 顶部高光：沿 y 方向加一点白色，营造轻微的立体感（不是拟物，只是让纯色不发闷）
 *   3. 相框：内缩的圆角矩形描边，线宽 0.052
 *   4. 太阳：右上角的实心圆
 *   5. 山峦：两座三角，远山更暗、近山更亮，做出层次
 */
function drawIcon(size) {
  const canvas = createCanvas(size);

  paint(canvas, (u, v) => {
    // ---- 圆角方块底 + 垂直渐变 + 顶部高光
    const dBg = sdRoundRect(u, v, 0.5, 0.5, 0.5, 0.5, 0.225);
    if (dBg > 0) return null;

    const t = clamp01(v / 1.0);
    let col = [
      BRAND_TOP[0] + (BRAND_BOT[0] - BRAND_TOP[0]) * t,
      BRAND_TOP[1] + (BRAND_BOT[1] - BRAND_TOP[1]) * t,
      BRAND_TOP[2] + (BRAND_BOT[2] - BRAND_TOP[2]) * t,
    ];
    // 顶部 45% 叠一层渐隐的白色高光
    const gloss = Math.pow(clamp01(1 - v / 0.62), 2) * 0.13;
    col = mix(col, WHITE, gloss);

    let alpha = 1;

    // ---- 相框描边
    const dFrame = Math.abs(sdRoundRect(u, v, 0.5, 0.5, 0.335, 0.265, 0.06)) - 0.026;
    if (dFrame <= 0) {
      col = mix(col, WHITE, 0.62);
      alpha = 1;
    }

    // ---- 太阳
    const dSun = sdCircle(u, v, 0.665, 0.395, 0.058);
    if (dSun <= 0) {
      col = WHITE;
      alpha = 1;
    }

    // ---- 远山（更暗，压在相框里）
    const dFar = sdTriangle(u, v, [[0.305, 0.60], [0.50, 0.345], [0.70, 0.60]]);
    if (dFar <= 0) {
      col = mix(col, WHITE, 0.58);
      alpha = 1;
    }

    // ---- 近山（更亮，压住远山形成层次）
    const dNear = sdTriangle(u, v, [[0.225, 0.60], [0.455, 0.335], [0.685, 0.60]]);
    if (dNear <= 0) {
      col = mix(col, WHITE, 0.34);
      alpha = 1;
    }

    // ---- 地平线：把山脚压平，同时也是相框的下边
    const dGround = sdRoundRect(u, v, 0.5, 0.615, 0.30, 0.012, 0.012);
    if (dGround <= 0) {
      col = mix(col, WHITE, 0.8);
      alpha = 1;
    }

    return [col[0], col[1], col[2], alpha];
  }, 4);

  return canvas;
}

/* ============================================================================
 * 四、输出 + 自检
 * ========================================================================== */

function assertPng(buf, label) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) {
    throw new Error(label + ' 不是合法 PNG（签名不对）');
  }
  if (buf.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error(label + ' 缺少 IHDR 分块');
  }
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const depth = buf[24];
  const colorType = buf[25];
  if (depth !== 8 || colorType !== 6) {
    throw new Error(label + ' 期望 8bit RGBA，实际 ' + depth + '/' + colorType);
  }
  return { w, h };
}

const ROOT = path.resolve(__dirname, '..');

function main() {
  const jobs = [
    { file: path.join(ROOT, 'electron', 'icon.png'), size: 256, label: '应用图标' },
    { file: path.join(ROOT, 'electron', 'tray.png'), size: 64, label: '托盘图标' },
  ];

  const trayBase64 = [];
  for (const job of jobs) {
    const canvas = drawIcon(job.size);
    const buf = encodePng(canvas);
    const dim = assertPng(buf, job.label);
    if (dim.w !== job.size || dim.h !== job.size) {
      throw new Error(job.label + ' 尺寸不对：' + dim.w + 'x' + dim.h);
    }
    fs.writeFileSync(job.file, buf);
    if (job.size === 64) trayBase64.push(buf.toString('base64'));
    console.log(
      '  ' + job.label + '  ' + path.relative(ROOT, job.file) +
      '  ' + dim.w + 'x' + dim.h + '  ' + buf.length + ' bytes'
    );
  }

  // base64 与磁盘上的 tray.png 必须是同一份内容，防止 main.js 里内嵌的和文件漂移
  const onDisk = fs.readFileSync(path.join(ROOT, 'electron', 'tray.png')).toString('base64');
  if (onDisk !== trayBase64[0]) {
    throw new Error('tray.png 与打印出的 base64 不一致');
  }

  console.log('');
  console.log('  把下面这行粘进 electron/main.js 的 TRAY_PNG_BASE64：');
  console.log("  const TRAY_PNG_BASE64 =\n    '" + trayBase64[0] + "';");
}

main();
