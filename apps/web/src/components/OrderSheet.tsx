/**
 * 下单弹层（编辑 → 二次确认 → 提交）。
 *
 * ## 三个必须做对的地方
 *
 * 1. **幂等键的生成时机**
 *    键绑定在"参数指纹"上：参数不变就复用同一个 clientOrderId，参数一改就换新的。
 *    这样"网络超时后用同一个键重试"会被服务端识别为幂等命中而不会重复下单；
 *    而用户改了价格数量后再提交，是一笔新委托，也不会被误判成重复。
 *    如果每次点确认都新生成一个键，服务端去重就完全失效 —— 弱网下必然重复下单。
 *
 * 2. **校验用共享函数，不是自己写一套**
 *    这里调的是 `market-core` 里的 `validateOrder`，与服务端**同一份代码**。
 *    前端校验只负责体验，服务端校验才是最终裁决 —— 前端可以被绕过。
 *
 * 3. **提交中：自己转圈 + 改文案，且不允许重复点击**
 *    置灰 ≠ 加载中。转圈表示"正在进行"，置灰表示"不可用"，两者语义不同。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  calcFee,
  floorToLot,
  fmtAmount,
  fmtPrice,
  genClientOrderId,
  lotRuleOf,
  validateOrder,
} from '@stock/market-core';
import type { OrderSide, OrderType } from '@stock/market-core';
import { instrumentStore, useQuote } from '../store';
import { fetchTradingLimits, submitOrder, useAccount } from '../tradingStore';

export interface OrderSheetProps {
  symbol: string;
  /** 初始方向（从"买入/卖出"按钮进来时决定） */
  side: OrderSide;
  onClose: () => void;
  onToast: (msg: string) => void;
}

type Phase = 'edit' | 'confirm' | 'submitting';

export function OrderSheet({ symbol, side: initialSide, onClose, onToast }: OrderSheetProps) {
  const quote = useQuote(symbol);
  const account = useAccount();
  const inst = instrumentStore.get(symbol);

  const [side, setSide] = useState<OrderSide>(initialSide);
  const [type, setType] = useState<OrderType>('limit');
  const [priceText, setPriceText] = useState('');
  const [volumeText, setVolumeText] = useState('');
  const [limits, setLimits] = useState({ maxBuy: 0, maxSell: 0 });
  const [phase, setPhase] = useState<Phase>('edit');
  const [error, setError] = useState('');

  // 首次拿到行情时用最新价预填一次（之后不再覆盖用户输入）
  const initedRef = useRef('');
  useEffect(() => {
    if (!quote || initedRef.current === symbol) return;
    initedRef.current = symbol;
    setPriceText(String(quote.last || quote.prevClose));
  }, [quote, symbol]);

  // 最大可买卖由服务端算，保证整手规则与预留手续费的口径一致
  useEffect(() => {
    let alive = true;
    void fetchTradingLimits(symbol).then((l) => {
      if (alive) setLimits(l);
    });
    return () => {
      alive = false;
    };
  }, [symbol, side]);

  const price = Number(priceText) || 0;
  const volume = Math.floor(Number(volumeText) || 0);
  const availableVolume = account?.positions.find((p) => p.symbol === symbol)?.available ?? 0;

  const validation = useMemo(() => {
    if (!quote || !inst || !account) return null;
    return validateOrder(
      { symbol, side, type, price, volume },
      { instrument: inst, quote, account, availableVolume },
    );
  }, [symbol, side, type, price, volume, quote, inst, account, availableVolume]);

  /** 表单还没填完时不该报错，只提示 */
  const formIncomplete = volume <= 0 || (type === 'limit' && price <= 0);
  const blocked = Boolean(validation && !validation.ok && !formIncomplete);
  const est = validation?.ok ? validation : null;

  const rule = lotRuleOf(inst?.board);

  /** 幂等键：绑定参数指纹，参数不变就复用 */
  const idemRef = useRef({ fp: '', id: '' });
  const fingerprint = `${symbol}|${side}|${type}|${type === 'limit' ? price : 0}|${volume}`;
  function ensureIdemKey(): string {
    if (idemRef.current.fp !== fingerprint) {
      idemRef.current = { fp: fingerprint, id: genClientOrderId() };
    }
    return idemRef.current.id;
  }

  const setQuickVolume = (ratio: number) => {
    const max = side === 'buy' ? limits.maxBuy : limits.maxSell;
    if (max <= 0) return;
    const raw = ratio >= 1 ? max : Math.floor(max * ratio);
    // 用共享的整手规则向下取整，避免"半仓"算出非整手数量
    const v = rule ? floorToLot(raw, rule) : raw;
    setVolumeText(String(v > 0 ? v : ''));
    setError('');
  };

  async function doSubmit() {
    setPhase('submitting');
    setError('');
    const res = await submitOrder({
      clientOrderId: ensureIdemKey(),
      symbol,
      side,
      type,
      price: type === 'limit' ? price : 0,
      volume,
    });
    if (res.ok) {
      onToast(
        res.deduplicated
          ? '该委托已提交过（幂等命中，未重复下单）'
          : `已提交：${side === 'buy' ? '买入' : '卖出'} ${volume} 股`,
      );
      onClose();
      return;
    }
    setError(res.message ?? '下单失败');
    // 退回确认态而不是关闭：用户可以改参数或直接重试（重试会复用同一幂等键）
    setPhase('confirm');
  }

  if (!quote || !inst) {
    return (
      <div className="sheet-mask" onClick={onClose}>
        <div className="sheet" onClick={(e) => e.stopPropagation()}>
          <div className="empty">加载中…</div>
        </div>
      </div>
    );
  }

  const dirCls = side === 'buy' ? 'up' : 'down';
  const submitting = phase === 'submitting';

  return (
    <div className="sheet-mask" onClick={submitting ? undefined : onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        {/* ---------------- 方向切换 ---------------- */}
        <div className="sheet-head">
          <div className="seg2">
            <button
              className={`seg2-item ${side === 'buy' ? 'active up' : ''}`}
              onClick={() => {
                setSide('buy');
                setPhase('edit');
                setError('');
              }}
            >
              买入
            </button>
            <button
              className={`seg2-item ${side === 'sell' ? 'active down' : ''}`}
              onClick={() => {
                setSide('sell');
                setPhase('edit');
                setError('');
              }}
            >
              卖出
            </button>
          </div>
          <button className="icon-btn" onClick={onClose} disabled={submitting} aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="sheet-body">
          <div className="sheet-title">
            <span>
              {inst.name} <span className="muted">{inst.code}</span>
            </span>
            <span className={`num dir-${quote.changePct > 0 ? 'up' : quote.changePct < 0 ? 'down' : 'flat'}`}>
              {fmtPrice(quote.last)}
            </span>
          </div>

          <div className="sheet-sub">
            <span>
              {side === 'buy' ? '最大可买' : '最大可卖'}{' '}
              <b>{side === 'buy' ? limits.maxBuy : limits.maxSell}</b> 股
            </span>
            {side === 'sell' && <span className="muted">可用 {availableVolume} 股（T+1）</span>}
          </div>

          {phase === 'edit' ? (
            <>
              {/* ---------------- 委托类型 ---------------- */}
              <div className="field">
                <div className="field-label">委托类型</div>
                <div className="chip-row">
                  {(
                    [
                      ['limit', '限价'],
                      ['market-opponent', '对手方最优'],
                    ] as Array<[OrderType, string]>
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      className={`chip-btn ${type === k ? 'active' : ''}`}
                      onClick={() => setType(k)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="field-hint">
                  两市市价单类型不同（沪市有"最优五档即时成交剩余转限价"，深市另有"即时成交剩余撤销"），
                  这里实现两市都有的对手方最优：吃对手盘五档，剩余撤销。
                </div>
              </div>

              {/* ---------------- 价格 ---------------- */}
              <div className="field">
                <div className="field-label">委托价格</div>
                <div className="input-row">
                  <button className="step-btn" onClick={() => setPriceText(stepPrice(price, -1))} disabled={type !== 'limit'}>
                    −
                  </button>
                  <input
                    className="input num"
                    inputMode="decimal"
                    value={type === 'limit' ? priceText : '市价'}
                    disabled={type !== 'limit'}
                    onChange={(e) => {
                      setPriceText(e.target.value.replace(/[^\d.]/g, ''));
                      setError('');
                    }}
                    placeholder="委托价"
                  />
                  <button className="step-btn" onClick={() => setPriceText(stepPrice(price, 1))} disabled={type !== 'limit'}>
                    +
                  </button>
                </div>
                <div className="chip-row">
                  <button className="chip-btn" onClick={() => setPriceText(String(quote.last))} disabled={type !== 'limit'}>
                    最新 {fmtPrice(quote.last)}
                  </button>
                  <button className="chip-btn up" onClick={() => setPriceText(String(quote.limitUp))} disabled={type !== 'limit'}>
                    涨停 {fmtPrice(quote.limitUp)}
                  </button>
                  <button className="chip-btn down" onClick={() => setPriceText(String(quote.limitDown))} disabled={type !== 'limit'}>
                    跌停 {fmtPrice(quote.limitDown)}
                  </button>
                </div>
              </div>

              {/* ---------------- 数量 ---------------- */}
              <div className="field">
                <div className="field-label">委托数量（股）</div>
                <div className="input-row">
                  <button className="step-btn" onClick={() => setVolumeText(String(Math.max(0, volume - (rule?.step ?? 100))))}>
                    −
                  </button>
                  <input
                    className="input num"
                    inputMode="numeric"
                    value={volumeText}
                    onChange={(e) => {
                      setVolumeText(e.target.value.replace(/[^\d]/g, ''));
                      setError('');
                    }}
                    placeholder={rule ? `最小 ${rule.min} 股` : '数量'}
                  />
                  <button className="step-btn" onClick={() => setVolumeText(String(volume + (rule?.step ?? 100)))}>
                    +
                  </button>
                </div>
                <div className="chip-row">
                  <button className="chip-btn" onClick={() => setQuickVolume(1)}>
                    全部
                  </button>
                  <button className="chip-btn" onClick={() => setQuickVolume(0.5)}>
                    1/2
                  </button>
                  <button className="chip-btn" onClick={() => setQuickVolume(1 / 3)}>
                    1/3
                  </button>
                  {rule && (
                    <span className="field-hint inline">
                      {rule.step === 1 ? `${rule.min} 股起、1 股递增` : `${rule.min} 股整数倍`}
                    </span>
                  )}
                </div>
              </div>

              {/* ---------------- 金额与校验 ---------------- */}
              {est && (
                <div className="form-preview">
                  <div>
                    <span className="muted">预计金额</span> <b>{fmtAmount(est.estAmount)}</b>
                  </div>
                  <div>
                    <span className="muted">预计费用</span> <b>{est.fee.total.toFixed(2)} 元</b>
                  </div>
                  {side === 'buy' && (
                    <div>
                      <span className="muted">需冻结</span> <b>{est.frozenAmount.toFixed(2)} 元</b>
                    </div>
                  )}
                </div>
              )}

              {blocked && validation && !validation.ok && (
                <div className="form-error">{validation.message}</div>
              )}
              {!blocked && !est && validation && !validation.ok && (
                <div className="form-hint">{formIncomplete ? '请填写价格与数量' : validation.message}</div>
              )}

              <button
                className={`btn btn-block btn-primary ${dirCls === 'down' ? 'sell' : ''}`}
                disabled={blocked || !est}
                onClick={() => {
                  ensureIdemKey();
                  setPhase('confirm');
                }}
              >
                下一步
              </button>
            </>
          ) : (
            <>
              {/* ---------------- 二次确认 ---------------- */}
              <div className="confirm-box">
                <div className="confirm-side">
                  <span className={`chip ${dirCls}`}>{side === 'buy' ? '买入' : '卖出'}</span>
                  <span className="confirm-name">
                    {inst.name} {inst.code}
                  </span>
                </div>
                <div className="confirm-rows">
                  <div>
                    <span className="muted">委托类型</span>
                    <b>{type === 'limit' ? '限价委托' : '对手方最优价格'}</b>
                  </div>
                  <div>
                    <span className="muted">委托价格</span>
                    <b>{type === 'limit' ? fmtPrice(price) : '市价'}</b>
                  </div>
                  <div>
                    <span className="muted">委托数量</span>
                    <b>{volume} 股</b>
                  </div>
                  <div>
                    <span className="muted">预计金额</span>
                    <b>{est ? fmtAmount(est.estAmount) : '--'}</b>
                  </div>
                  <div>
                    <span className="muted">预计费用</span>
                    <b>{est ? `${est.fee.total.toFixed(2)} 元` : '--'}</b>
                  </div>
                  {side === 'buy' && est && (
                    <div>
                      <span className="muted">冻结资金</span>
                      <b>{est.frozenAmount.toFixed(2)} 元</b>
                    </div>
                  )}
                </div>
                <div className="confirm-tip">
                  {side === 'buy'
                    ? '买入当日不可卖出（T+1），下一交易日可卖。'
                    : '卖出资金实时到账可用，T+1 可提现。'}
                </div>
                {error && <div className="form-error">{error}</div>}
              </div>

              <div className="confirm-actions">
                <button className="btn btn-secondary" disabled={submitting} onClick={() => setPhase('edit')}>
                  返回修改
                </button>
                <button
                  className={`btn btn-primary ${submitting ? 'loading' : ''} ${dirCls === 'down' ? 'sell' : ''}`}
                  disabled={submitting || blocked}
                  onClick={doSubmit}
                >
                  {submitting && <span className="spin" />}
                  {submitting ? '提交中…' : side === 'buy' ? '确认买入' : '确认卖出'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 价格步进：A 股最小变动 0.01 元 */
function stepPrice(price: number, dir: 1 | -1): string {
  const next = Math.max(0, Math.round((price + dir * 0.01) * 100) / 100);
  return next ? String(next) : '';
}

/** 供外部预览费用口径（与提交时一致） */
export function previewFee(side: OrderSide, amount: number): number {
  return calcFee(side, amount).total;
}
