/**
 * 交易页：账户概览 / 持仓 / 委托 / 成交。
 *
 * 三块列表各自订阅自己的数据（见 tradingStore.ts）：
 * 资金持仓每秒推一次，委托与成交是事件驱动 —— 分开订阅就不会被账户推送带着白重渲染。
 */
import { useEffect, useState } from 'react';
import {
  ORDER_STATUS_TEXT,
  fmtAmount,
  fmtPct,
  fmtPrice,
  fmtTime,
  isCancelable,
  fillRatio,
} from '@stock/market-core';
import { useInstruments } from '../store';
import { cancelOrder, useAccount, useOrders, useTrades } from '../tradingStore';
import { navigate } from '../router';

function dirOf(v: number): string {
  return v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
}

export function TradePage() {
  const account = useAccount();
  const orders = useOrders();
  const trades = useTrades();
  const instruments = useInstruments();
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  const nameOf = (symbol: string) => instruments.get(symbol)?.name ?? symbol;
  const codeOf = (symbol: string) => instruments.get(symbol)?.code ?? symbol;

  const activeOrders = orders.filter((o) => isCancelable(o));
  const doneOrders = orders.filter((o) => !isCancelable(o));

  async function onCancel(orderId: string) {
    const res = await cancelOrder(orderId);
    setToast(res.ok ? (res.deduplicated ? '该委托已撤销' : '撤单已提交') : (res.message ?? '撤单失败'));
  }

  return (
    <>
      {/* ---------------- 账户概览 ---------------- */}
      <div className="hero">
        <div className="asset-label">总资产（元）</div>
        <div className="asset-total num">{account ? account.totalAsset.toFixed(2) : '--'}</div>
        <div className={`asset-pnl num dir-${dirOf(account?.totalPnl ?? 0)}`}>
          累计盈亏 {account ? `${account.totalPnl >= 0 ? '+' : ''}${account.totalPnl.toFixed(2)}` : '--'}
        </div>
        <div className="asset-grid">
          <div>
            <div className="k">可用资金</div>
            <div className="v num">{account ? account.cash.toFixed(2) : '--'}</div>
          </div>
          <div>
            <div className="k">冻结资金</div>
            <div className="v num">{account ? account.frozen.toFixed(2) : '--'}</div>
          </div>
          <div>
            <div className="k">持仓市值</div>
            <div className="v num">{account ? account.marketValue.toFixed(2) : '--'}</div>
          </div>
        </div>
      </div>

      {/* ---------------- 持仓 ---------------- */}
      <div className="card">
        <div className="card-head">
          持仓
          <span className="sub">{account?.positions.length ?? 0} 只 · 市值随行情实时跳动</span>
        </div>
        {!account || account.positions.length === 0 ? (
          <div className="empty">暂无持仓</div>
        ) : (
          <>
            <div className="list-head trade-head">
              <span>名称 / 持仓</span>
              <span className="c-price">现价 / 成本</span>
              <span className="c-chg">盈亏</span>
            </div>
            {account.positions.map((p) => (
              <div
                className="quote-row trade-row"
                key={p.symbol}
                onClick={() => navigate(`#/stock/${encodeURIComponent(p.symbol)}`)}
              >
                <div className="c-name">
                  <div className="n">{nameOf(p.symbol)}</div>
                  <div className="c">
                    {p.volume} 股 · 可用 {p.available}
                  </div>
                </div>
                <div className="c-price">
                  <div className={`num dir-${dirOf(p.last - p.costPrice)}`}>{fmtPrice(p.last)}</div>
                  <div className="sub num">成本 {fmtPrice(p.costPrice)}</div>
                </div>
                <div className="c-chg">
                  <div className={`num dir-${dirOf(p.pnl)}`}>
                    {p.pnl >= 0 ? '+' : ''}
                    {p.pnl.toFixed(0)}
                  </div>
                  <div className={`sub num dir-${dirOf(p.pnlPct)}`}>{fmtPct(p.pnlPct)}</div>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* ---------------- 委托 ---------------- */}
      <div className="card">
        <div className="card-head">
          当日委托
          <span className="sub">
            {activeOrders.length} 笔可撤 / 共 {orders.length} 笔
          </span>
        </div>
        {orders.length === 0 ? (
          <div className="empty">暂无委托</div>
        ) : (
          orders.slice(0, 30).map((o) => {
            const cancelable = isCancelable(o);
            const ratio = fillRatio(o);
            const statusCls =
              o.status === 'filled'
                ? 'ok'
                : o.status === 'rejected'
                  ? 'bad'
                  : o.status === 'canceled'
                    ? ''
                    : 'accent';
            return (
              <div className="order-row" key={o.orderId}>
                <div className="order-main">
                  <div className="order-line1">
                    <span className={`chip ${o.side === 'buy' ? 'up' : 'down'}`}>
                      {o.side === 'buy' ? '买' : '卖'}
                    </span>
                    <span className="order-name">{nameOf(o.symbol)}</span>
                    <span className="muted num">{codeOf(o.symbol)}</span>
                    <span className="order-spacer" />
                    <span className={`chip ${statusCls}`}>{ORDER_STATUS_TEXT[o.status]}</span>
                  </div>
                  <div className="order-line2 num">
                    <span>
                      {o.type === 'limit' ? '限价' : '市价'} {fmtPrice(o.price)}
                    </span>
                    <span className="muted">
                      {o.filledVolume}/{o.volume}
                    </span>
                    <span className="muted">{fmtTime(o.createdAt)}</span>
                  </div>
                  {o.status === 'partially_filled' && (
                    <div className="fill-bar">
                      <span style={{ width: `${Math.round(ratio * 100)}%` }} />
                    </div>
                  )}
                  {o.status === 'rejected' && o.rejectReason && (
                    <div className="order-reason">{o.rejectReason}</div>
                  )}
                </div>
                {cancelable && (
                  <button className="btn btn-secondary btn-cancel" onClick={() => void onCancel(o.orderId)}>
                    撤单
                  </button>
                )}
              </div>
            );
          })
        )}
        {doneOrders.length > 30 && <div className="empty">仅显示最近 30 笔</div>}
      </div>

      {/* ---------------- 成交 ---------------- */}
      <div className="card">
        <div className="card-head">
          当日成交
          <span className="sub">{trades.length} 笔</span>
        </div>
        {trades.length === 0 ? (
          <div className="empty">暂无成交</div>
        ) : (
          <>
            <div className="list-head trade-head">
              <span>名称 / 时间</span>
              <span className="c-price">价格 / 数量</span>
              <span className="c-chg">金额</span>
            </div>
            {trades.slice(0, 30).map((t) => (
              <div className="quote-row trade-row" key={t.tradeId}>
                <div className="c-name">
                  <div className="n">
                    <span className={`chip ${t.side === 'buy' ? 'up' : 'down'}`}>
                      {t.side === 'buy' ? '买' : '卖'}
                    </span>{' '}
                    {nameOf(t.symbol)}
                  </div>
                  <div className="c num">{fmtTime(t.at)}</div>
                </div>
                <div className="c-price">
                  <div className="num">{fmtPrice(t.price)}</div>
                  <div className="sub num">{t.volume} 股</div>
                </div>
                <div className="c-chg">
                  <div className="num">{fmtAmount(t.amount)}</div>
                  <div className="sub num muted">费 {t.fee.toFixed(2)}</div>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
