import { useEffect, useMemo } from 'react';
import { fmtPct, fmtPrice } from '@stock/market-core';
import type { Instrument } from '@stock/market-core';
import { QuoteRow } from '../components/QuoteRow';
import { useInstruments, useQuote, useWatchlist } from '../store';
import { acquire, release } from '../net';
import { navigate } from '../router';

/** 指数卡片 —— 同样只订阅自己那一个指数 */
function IndexCard({ symbol, inst }: { symbol: string; inst: Instrument | undefined }) {
  const q = useQuote(symbol);
  const pct = q?.changePct ?? 0;
  const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  return (
    <div className="index-card" onClick={() => navigate(`#/stock/${encodeURIComponent(symbol)}`)}>
      <div className="name">{inst?.name ?? symbol}</div>
      <div className={`price dir-${dir}`}>{fmtPrice(q?.last)}</div>
      <div className={`pct dir-${dir}`}>{fmtPct(pct)}</div>
    </div>
  );
}

export function WatchlistPage() {
  const symbols = useWatchlist();
  const instruments = useInstruments();

  const indices = useMemo(
    () => [...instruments.values()].filter((i) => i.board === 'index'),
    [instruments],
  );

  // 指数条一直显示在页面顶部，所以它们必须被订阅 ——
  // 否则会出现"指数卡片永远是 --"这种看起来像 bug 的空数据
  useEffect(() => {
    const list = indices.map((i) => i.symbol);
    if (list.length === 0) return;
    list.forEach(acquire);
    return () => list.forEach(release);
  }, [indices]);

  return (
    <>
      <div className="index-strip">
        {indices.map((i) => (
          <IndexCard key={i.symbol} symbol={i.symbol} inst={i} />
        ))}
        {indices.length === 0 && <div className="empty" style={{ padding: 12 }}>加载中…</div>}
      </div>

      <div className="card">
        <div className="card-head">
          自选
          <span className="sub">{symbols.length} 只 · 长按可拖拽排序（待做）</span>
        </div>
        <div className="list-head">
          <span>名称 / 代码</span>
          <span className="c-price">最新价</span>
          <span className="c-chg">涨跌幅</span>
        </div>
        {symbols.length === 0 ? (
          <div className="empty">自选为空</div>
        ) : (
          symbols.map((s) => <QuoteRow key={s} symbol={s} inst={instruments.get(s)} />)
        )}
      </div>
    </>
  );
}
