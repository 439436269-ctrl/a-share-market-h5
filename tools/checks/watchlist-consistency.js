/**
 * 渲染结果核验脚本（配合 tools/visual-check.mjs --eval-file 使用）。
 *
 * 检查一件事：**同一行里，价格的颜色/方向必须与涨跌幅一致**。
 * 这在截图里很难靠肉眼判断（尤其缩略图），但量一次计算样式就是确定的。
 * 顺带核对涨跌幅与"最新价/昨收"是否自洽 —— 不一致说明前端拿到了过期字段。
 */
JSON.stringify(
  {
    rows: [...document.querySelectorAll('.quote-row')].map((r) => {
      const priceEl = r.querySelector('.c-price');
      const pillEl = r.querySelector('.chg-pill');
      const priceColor = getComputedStyle(priceEl).color;
      const pillBg = getComputedStyle(pillEl).backgroundColor;
      const price = parseFloat(priceEl.textContent.trim());
      const pct = parseFloat(pillEl.textContent.replace('%', '').replace('+', ''));
      return {
        name: r.querySelector('.c-name .n').textContent,
        price,
        pct,
        priceColor,
        pillBg,
        // 红=涨(#fa5151 → rgb(250, 81, 81))，绿=跌(#2fbe6b → rgb(47, 190, 107))
        priceDir: priceColor === 'rgb(250, 81, 81)' ? 'up' : priceColor === 'rgb(47, 190, 107)' ? 'down' : 'flat',
        pillDir: pillBg === 'rgb(250, 81, 81)' ? 'up' : pillBg === 'rgb(47, 190, 107)' ? 'down' : 'flat',
        pctSign: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat',
      };
    }),
    indices: [...document.querySelectorAll('.index-card')].map((c) => ({
      name: c.querySelector('.name').textContent,
      price: c.querySelector('.price').textContent.trim(),
      pct: c.querySelector('.pct').textContent.trim(),
    })),
    seqText: document.querySelector('.conn-meta')?.textContent ?? '',
  },
  null,
  2,
);
