/**
 * 自选列表行 —— 细粒度订阅的落点。
 *
 * 注意这个组件**没有 quote prop**：它自己订阅自己那一只。
 * 于是 300 只自选里只有 3 只跳动时，React 只会调度这 3 个组件，
 * 而不是整个列表。这就是能不能扛住高频行情的分水岭。
 */
import { memo, useEffect, useRef, useState } from 'react';
import { fmtPct, fmtPrice, limitLabel } from '@stock/market-core';
import type { Instrument } from '@stock/market-core';
import { useQuote } from '../store';
import { navigate } from '../router';

export interface QuoteRowProps {
  symbol: string;
  inst: Instrument | undefined;
}

export const QuoteRow = memo(function QuoteRow({ symbol, inst }: QuoteRowProps) {
  const quote = useQuote(symbol);

  // 价格跳动时闪一下 —— 让"实时"这件事被看见
  const prevRef = useRef<number | undefined>(undefined);
  const [flash, setFlash] = useState('');
  const last = quote?.last;

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = last;
    if (last === undefined || prev === undefined || last === prev) return;
    setFlash(last > prev ? 'flash-up' : 'flash-down');
    const timer = setTimeout(() => setFlash(''), 560);
    return () => clearTimeout(timer);
  }, [last]);

  const pct = quote?.changePct ?? 0;
  const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  const tag = quote ? limitLabel(quote) : null;

  return (
    <div
      className={`quote-row ${flash}`}
      onClick={() => navigate(`#/stock/${encodeURIComponent(symbol)}`)}
    >
      <div className="c-name">
        <div className="n">{inst?.name ?? symbol}</div>
        <div className="c">
          {inst?.code ?? symbol} · {inst?.market ?? ''}
          {tag && <span className={`chip ${tag === '涨停' ? 'up' : tag === '跌停' ? 'down' : ''}`} style={{ marginLeft: 4 }}>{tag}</span>}
        </div>
      </div>
      <div className={`c-price dir-${dir}`}>{fmtPrice(quote?.last)}</div>
      <div className="c-chg">
        <span className={`chg-pill ${dir}`}>{fmtPct(pct)}</span>
      </div>
    </div>
  );
});
