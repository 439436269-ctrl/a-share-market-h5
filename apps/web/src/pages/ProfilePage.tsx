import { DebugPanel } from '../components/DebugPanel';

/**
 * "我的"页：放诊断面板 + 演示脚本。
 *
 * 演示脚本写进产品里不是玩笑 —— 面试现场手忙脚乱找命令是最亏的，
 * 把话术和操作步骤固化下来，能保证每次演示都稳定复现。
 */
export function ProfilePage() {
  return (
    <>
      <DebugPanel />

      <div className="card">
        <div className="card-head">
          面试演示脚本
          <span className="sub">按顺序走，30 秒讲清技术含量</span>
        </div>
        <div style={{ padding: '0 12px 14px', fontSize: 12, lineHeight: 2, color: 'var(--text-2)' }}>
          <div>
            <b>1. 实时性</b> — 自选列表价格在跳动，每行独立高亮。说明订阅粒度下沉到了单只标的，
            300 只票里只有 3 只在变时，React 只调度这 3 个组件。
          </div>
          <div>
            <b>2. 可靠性</b> — 点上面「注入 40% 丢帧」，观察状态条切到"缺口补拉中"、日志打出缺口区间，
            1 秒内自动恢复。这是序号守卫 + 全量快照补拉，不是"重试一下"。
          </div>
          <div>
            <b>3. 自绘图表</b> — 进任意个股，分时图/日K 都是 Canvas 手写。切换 5分/15分/60分
            能看到同一份 1 分钟数据被读时聚合，写的时候只存一个粒度。
          </div>
          <div>
            <b>4. 业务细节</b> — 五档盘口、封涨停时卖盘为空、红涨绿跌、涨跌停价按板块幅度算、
            交易状态由服务端下发决定按钮可用性。
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">关于本项目</div>
        <div style={{ padding: '0 12px 14px', fontSize: 12, lineHeight: 1.9, color: 'var(--text-2)' }}>
          <div>· 前端：React + TypeScript + Canvas 自绘（零图表库）</div>
          <div>· 传输：WebSocket 广播帧 + 全局 seq + 缺口补拉 + 心跳/退避重连</div>
          <div>· 服务端：Node BFF 代理行情源（浏览器无法直连，CORS + Referer 限制）</div>
          <div>· 数据链路：逐笔成交 → 1 分钟 bar → 日线，读时聚合</div>
          <div>· 虚拟时钟：任何时间打开都能看到完整交易日，便于演示与回归</div>
        </div>
      </div>
    </>
  );
}
