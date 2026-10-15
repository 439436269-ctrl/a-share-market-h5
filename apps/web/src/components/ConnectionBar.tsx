/**
 * 顶部连接状态条。
 *
 * 行情产品里这条状态条不是装饰 —— 它回答用户最焦虑的问题：
 * "我看到的价是实时价，还是卡住的旧价？"
 * 所以它必须区分「已连接 / 重连中 / 序号缺口补拉中」，
 * 而不是简单地绿点/红点。
 */
import { useEffect, useState } from 'react';
import { PHASE_LABEL } from '@stock/market-core';
import type { ConnectionStatus, MarketPhase } from '@stock/market-core';
import { useStatus } from '../store';

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  idle: '未连接',
  connecting: '连接中…',
  open: '实时',
  resyncing: '缺口补拉中',
  reconnecting: '重连中',
  closed: '已断开',
};

interface ServerStats {
  seq: number;
  clients: number;
  dropRate: number;
  droppedFrames: number;
  sentFrames: number;
  source: string;
  degraded: boolean;
  clock: { mode: string; speed: number; virtualTime: string; phase: MarketPhase; day: number };
}

/** 轮询服务端状态：交易阶段、虚拟时间、连接数 —— 都是低频数据，3s 一次足够 */
export function useServerStats(intervalMs = 3000): ServerStats | null {
  const [stats, setStats] = useState<ServerStats | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/stats');
        if (!res.ok) return;
        const data = (await res.json()) as ServerStats;
        if (alive) setStats(data);
      } catch {
        /* 忽略：连接状态由 WS 侧负责 */
      }
    };
    void load();
    const timer = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [intervalMs]);
  return stats;
}

export function ConnectionBar() {
  const { status, detail, stats } = useStatus();
  const server = useServerStats();
  const phase = server?.clock.phase;

  return (
    <div className="conn-bar">
      <span className={`conn-dot ${status}`} />
      <span>{STATUS_LABEL[status]}</span>
      {detail && <span className="conn-meta">· {detail}</span>}
      {phase && (
        <span className={`chip ${phase === 'continuous' ? 'accent' : ''}`}>
          {PHASE_LABEL[phase]}
        </span>
      )}
      {server?.clock.mode === 'replay' && (
        <span className="chip" title="虚拟时间回放，保证任何时间打开都能看到行情">
          {server.clock.speed}x {server.clock.virtualTime.slice(-5)}
        </span>
      )}
      <span className="conn-spacer" />
      {stats && (
        <span className="conn-meta">
          seq {stats.lastSeq} · {stats.frames}帧
          {stats.gaps > 0 ? ` · 缺口${stats.gaps}` : ''}
        </span>
      )}
    </div>
  );
}
