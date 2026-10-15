/**
 * 诊断面板 —— 这个项目里我最想让你在面试中打开的一页。
 *
 * 它把"可靠性机制"从口头描述变成了可以当场演示的东西：
 *   点「注入 40% 丢帧」→ 状态条切到 *缺口补拉中* → 日志打出缺口区间 → 1 秒内自动恢复。
 *
 * 绝大多数候选人讲到"我做了断线重连/丢包处理"时只能描述，拿不出证据。
 * 有这一页，性质就完全不同了。
 */
import { useState } from 'react';
import { fmtTime } from '@stock/market-core';
import { useLogs, useStatus } from '../store';
import { useServerStats } from './ConnectionBar';

export function DebugPanel() {
  const { stats } = useStatus();
  const server = useServerStats(2000);
  const logs = useLogs();
  const [busy, setBusy] = useState(false);

  const setDrop = async (rate: number) => {
    setBusy(true);
    try {
      await fetch(`/api/debug/drop?rate=${rate}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card debug">
      <div className="card-head">
        链路诊断
        <span className="sub">证明"丢包不会让行情错下去"</span>
      </div>

      <div className="debug-stats">
        <div>
          序号缺口 <b>{stats?.gaps ?? 0}</b> 次
        </div>
        <div>
          重连 <b>{stats?.reconnects ?? 0}</b> 次
        </div>
        <div>
          当前 seq <b>{stats?.lastSeq ?? '-'}</b>
        </div>
        <div>
          已收帧 <b>{stats?.frames ?? 0}</b>
        </div>
        <div>
          心跳 RTT <b>{stats?.rtt ? `${stats.rtt} ms` : '—'}</b>
        </div>
        <div>
          订阅 <b>{stats?.subscribed ?? 0}</b> 只
        </div>
        <div>
          行情源 <b>{server?.source ?? '-'}</b>
          {server?.degraded ? ' (降级)' : ''}
        </div>
        <div>
          在线连接 <b>{server?.clients ?? 0}</b>
        </div>
        <div>
          服务端丢帧率 <b>{((server?.dropRate ?? 0) * 100).toFixed(0)}%</b>
        </div>
        <div>
          虚拟时间 <b>{server?.clock.virtualTime ?? '-'}</b>
        </div>
        <div>
          回放第 <b>{server?.clock.day ?? 0}</b> 日
        </div>
        <div>
          行情源丢帧 <b>{server ? `${server.droppedFrames} 帧` : '-'}</b>
        </div>
      </div>

      <div className="trade-actions">
        <button className="btn btn-secondary" disabled={busy} onClick={() => setDrop(0.4)}>
          注入 40% 丢帧
        </button>
        <button className="btn btn-secondary" disabled={busy} onClick={() => setDrop(0)}>
          恢复正常
        </button>
      </div>

      <div className="log-box">
        {logs.length === 0 && <div>暂无日志</div>}
        {logs.map((l) => (
          <div key={l.id}>
            <span className="t">{fmtTime(l.at)}</span>
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}
