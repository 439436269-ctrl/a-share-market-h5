/**
 * 图表绘制范围核验。
 *
 * 分时图最容易出的问题是"数据取到了、但 x 轴映射错了 / 归并口径不一致"，
 * 结果曲线被压在左边一小条，或者碎成一堆柱子。
 * 光看截图容易误判，这里做两件确定的事：
 *   1. 直接问后端要同一份 1 分钟数据，核对条数与去重后的分钟数是否相等；
 *   2. 在绘图区内扫描**曲线色**像素（排除网格线与右轴文字），
 *      得到曲线真实的横向终点，与"按数据条数推算的期望终点"对比。
 */
(async () => {
  const canvas = document.querySelector('.chart-wrap canvas');
  if (!canvas) return JSON.stringify({ error: 'canvas 不存在' });

  const PAD_L = 6;
  const PAD_R = 44;
  const dpr = window.devicePixelRatio;
  const cssW = canvas.width / dpr;
  const plotW = cssW - PAD_L - PAD_R;
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const img = ctx.getImageData(0, 0, width, height).data;

  // ---- 全量非透明像素的横向范围（包含网格线，仅作参考）
  const colHasInk = new Array(width).fill(false);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (img[(y * width + x) * 4 + 3] > 0) colHasInk[x] = true;
    }
  }
  let inkFirst = -1;
  let inkLast = -1;
  for (let x = 0; x < width; x++) {
    if (colHasInk[x]) {
      if (inkFirst < 0) inkFirst = x;
      inkLast = x;
    }
  }

  // ---- 只认"曲线色"：涨 #fa5151 / 跌 #2fbe6b / 均价线 #f0a020
  const CURVE_COLORS = [
    [0xfa, 0x51, 0x51],
    [0x2f, 0xbe, 0x6b],
    [0xf0, 0xa0, 0x20],
  ];
  const near = (v, t) => Math.abs(v - t) <= 26;
  const curveCols = new Array(width).fill(false);
  // 只在绘图区内扫描：右轴百分比文字也用涨跌色，不排除会造成假阳性
  const plotRightPx = Math.min(width, Math.round((PAD_L + plotW) * dpr));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < plotRightPx; x++) {
      const i = (y * width + x) * 4;
      if (img[i + 3] < 40) continue;
      const r = img[i];
      const g = img[i + 1];
      const b = img[i + 2];
      for (const c of CURVE_COLORS) {
        if (near(r, c[0]) && near(g, c[1]) && near(b, c[2])) {
          curveCols[x] = true;
          break;
        }
      }
    }
  }
  let curveLast = -1;
  let curveCount = 0;
  for (let x = 0; x < width; x++) {
    if (curveCols[x]) {
      curveLast = x;
      curveCount += 1;
    }
  }

  // ---- 后端数据：条数、去重分钟数、时间范围
  const res = await fetch('/api/kline?symbol=600519.SH&period=1m&limit=240');
  const body = await res.json();
  const bars = body.bars ?? [];
  const distinct = new Set(bars.map((b) => b.ts)).size;

  const expectedRightCss = PAD_L + ((bars.length - 1) / 239) * plotW;
  const curveLastCss = curveLast / dpr;
  const okExtent = bars.length > 1 && curveLastCss > expectedRightCss - 16;

  return JSON.stringify(
    {
      canvasCss: { w: Math.round(cssW), h: Math.round(height / dpr) },
      dpr,
      barsFromApi: bars.length,
      distinctMinutes: distinct,
      noDuplicateMinutes: bars.length === distinct,
      firstBarCst: bars[0] ? new Date(bars[0].ts).toISOString() : null,
      lastBarCst: bars.length ? new Date(bars[bars.length - 1].ts).toISOString() : null,
      inkColumnsCss: { first: +(inkFirst / dpr).toFixed(1), last: +(inkLast / dpr).toFixed(1) },
      curveColorColumns: curveCount,
      curveLastColumnCss: +curveLastCss.toFixed(1),
      expectedLastColumnCss: +expectedRightCss.toFixed(1),
      verdict: okExtent
        ? 'OK：曲线画到了数据应有的横向位置，且无重复分钟'
        : `SUSPECT：曲线只到 ${curveLastCss.toFixed(1)}px，期望至少 ${(expectedRightCss - 16).toFixed(1)}px；或存在重复分钟`,
    },
    null,
    2,
  );
})();
