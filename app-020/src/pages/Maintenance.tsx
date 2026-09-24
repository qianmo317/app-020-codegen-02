import { useMemo, useState } from 'react';
import { FACILITY_LABELS, SERVICE_TYPE_LABELS } from '../model';
import type { FacilityKind } from '../model';
import { useStore, setExpectedCount, seedExpectedCountsFromMap } from '../store/store';
import { floorLabel } from '../store/id';
import { Link } from '../router';
import {
  maintenanceTodos,
  reconcileFloorCounts,
  summarizeCosts,
  costYears,
  type TodoAction,
} from '../lib/maintenance';
import { download } from './Facilities';

const ACTION_LABELS: Record<TodoAction, string> = {
  hydro_test: '送检',
  replace: '换新',
  repair: '维修',
};

const ACTION_CLASS: Record<TodoAction, string> = {
  hydro_test: 'act-hydro',
  replace: 'act-replace',
  repair: 'act-repair',
};

const yuan = (v: number) => `¥${v.toFixed(2)}`;

export function MaintenancePage() {
  const buildings = useStore((s) => s.buildings);
  const floors = useStore((s) => s.floors);
  const now = Date.now();
  const years = useMemo(() => costYears(buildings, floors), [buildings, floors]);
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [actionFilter, setActionFilter] = useState<'all' | TodoAction>('all');

  const todos = useMemo(
    () => maintenanceTodos(buildings, floors, now).filter((t) => actionFilter === 'all' || t.action === actionFilter),
    [buildings, floors, now, actionFilter],
  );
  const costs = useMemo(() => summarizeCosts(buildings, floors, year), [buildings, floors, year]);
  const diffs = useMemo(() => reconcileFloorCounts(buildings, floors), [buildings, floors]);

  // 对账表：展开每个登记了账面数量的楼层 × 类型
  const expectedRows = useMemo(() => {
    const out: {
      buildingName: string;
      floorId: string;
      level: number;
      kind: FacilityKind;
      expected: number;
      actual: number;
      diff: number;
    }[] = [];
    for (const b of buildings) {
      for (const fid of b.floors) {
        const f = floors[fid];
        if (!f || !f.expectedCounts) continue;
        for (const [kindStr, expected] of Object.entries(f.expectedCounts)) {
          if (expected == null) continue;
          const kind = kindStr as FacilityKind;
          const actual = f.facilities.filter((x) => x.kind === kind).length;
          out.push({ buildingName: b.name, floorId: f.id, level: f.level, kind, expected, actual, diff: expected - actual });
        }
      }
    }
    out.sort((a, b) => a.buildingName.localeCompare(b.buildingName, 'zh') || a.level - b.level);
    return out;
  }, [buildings, floors]);

  // 尚未登记账面数量的楼层（提示去建档）
  const unregisteredFloors = useMemo(() => {
    const out: { buildingName: string; floorId: string; level: number }[] = [];
    for (const b of buildings) {
      for (const fid of b.floors) {
        const f = floors[fid];
        if (f && (!f.expectedCounts || Object.keys(f.expectedCounts).length === 0)) {
          out.push({ buildingName: b.name, floorId: f.id, level: f.level });
        }
      }
    }
    return out;
  }, [buildings, floors]);

  const exportCsv = () => {
    const lines: string[] = [];
    lines.push(`维保费用汇总（${year} 年）`);
    lines.push('楼栋,Q1,Q2,Q3,Q4,全年合计');
    for (const b of costs.byBuilding) {
      lines.push([b.buildingName, b.q1, b.q2, b.q3, b.q4, b.yearTotal].map(String).join(','));
    }
    lines.push('', `设施类型年度费用（${year} 年）`);
    lines.push('设施类型,材料费,人工费,运输费,合计,维保笔数');
    for (const k of costs.byKind) {
      lines.push([FACILITY_LABELS[k.kind], k.material, k.labor, k.transport, k.total, k.count].map(String).join(','));
    }
    lines.push('', '维保待办（导出时状态）');
    lines.push('楼栋,楼层,编号,类型,处理方式,期限,说明');
    for (const t of todos) {
      lines.push(
        [t.buildingName, floorLabel(t.floorLevel), t.facilityCode, FACILITY_LABELS[t.kind], ACTION_LABELS[t.action], t.dueDate ?? '—', t.reason]
          .map((x) => `"${String(x).replace(/"/g, '""')}"`)
          .join(','),
      );
    }
    download(`维保账_${year}.csv`, lines.join('\n'));
  };

  return (
    <div className="page">
      <h2>维保账 · 送检/换新待办、费用与账实对账</h2>
      <div className="toolbar">
        <span className="hint">
          水压试验/报废年限按出厂日期与历次送检、换新记录自动计算（干粉 10 年报废/2 年试压，CO₂ 10 年/5 年，水基 6 年/1 年，到期前 30 天预警）
        </span>
        <button style={{ marginLeft: 'auto' }} onClick={exportCsv}>导出年度维保账 CSV</button>
      </div>

      {/* 待办 */}
      <section className="section">
        <h3>待办（送检 / 换新 / 维修）</h3>
        <div className="toolbar">
          {(['all', 'hydro_test', 'replace', 'repair'] as const).map((a) => (
            <button key={a} className={actionFilter === a ? 'on' : ''} onClick={() => setActionFilter(a)}>
              {a === 'all' ? '全部' : ACTION_LABELS[a]}
            </button>
          ))}
          <span className="hint">共 {todos.length} 项</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>处理</th><th>楼栋</th><th>楼层</th><th>编号</th><th>类型</th><th>期限</th><th>说明</th><th />
            </tr>
          </thead>
          <tbody>
            {todos.map((t) => (
              <tr key={`${t.facilityId}-${t.action}`} className={t.overdue ? 'overdue-row' : ''}>
                <td><span className={`badge ${ACTION_CLASS[t.action]}`}>{ACTION_LABELS[t.action]}</span></td>
                <td>{t.buildingName}</td>
                <td>{floorLabel(t.floorLevel)}</td>
                <td>{t.facilityCode}</td>
                <td>{FACILITY_LABELS[t.kind]}</td>
                <td>
                  {t.dueDate ?? '—'}
                  {t.overdue && t.daysLeft !== null && <span className="bad"> 逾期 {-t.daysLeft} 天</span>}
                  {!t.overdue && t.daysLeft !== null && <span className="hint"> 剩 {t.daysLeft} 天</span>}
                </td>
                <td>{t.reason}</td>
                <td><Link className="btn" to={`/floor/${t.floorId}`}>去处理</Link></td>
              </tr>
            ))}
            {todos.length === 0 && (
              <tr><td colSpan={8} className="hint">暂无待办：设施未到试压/报废期限，检查状态正常</td></tr>
            )}
          </tbody>
        </table>
      </section>

      {/* 费用 */}
      <section className="section">
        <h3>费用汇总</h3>
        <div className="toolbar">
          <label className="row">
            年度
            <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {[...new Set([...years, new Date().getFullYear()])].sort((a, b) => b - a).map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </label>
          <span className="hint">{year} 年全部楼栋维保支出合计 <b className={costs.total > 0 ? 'warn' : ''}>{yuan(costs.total)}</b></span>
        </div>

        <h4 className="hint">按楼栋 × 季度</h4>
        <table className="table">
          <thead>
            <tr><th>楼栋</th><th>Q1</th><th>Q2</th><th>Q3</th><th>Q4</th><th>全年</th></tr>
          </thead>
          <tbody>
            {costs.byBuilding.map((b) => (
              <tr key={b.buildingId}>
                <td>{b.buildingName}</td>
                <td>{b.q1 ? yuan(b.q1) : '—'}</td>
                <td>{b.q2 ? yuan(b.q2) : '—'}</td>
                <td>{b.q3 ? yuan(b.q3) : '—'}</td>
                <td>{b.q4 ? yuan(b.q4) : '—'}</td>
                <td><b>{b.yearTotal ? yuan(b.yearTotal) : '—'}</b></td>
              </tr>
            ))}
            {costs.byBuilding.length === 0 && <tr><td colSpan={6} className="hint">暂无楼栋</td></tr>}
          </tbody>
        </table>

        <h4 className="hint" style={{ marginTop: 14 }}>按设施类型（哪一类最费钱）</h4>
        <table className="table">
          <thead>
            <tr><th>设施类型</th><th>材料</th><th>人工</th><th>运输</th><th>合计</th><th>维保笔数</th></tr>
          </thead>
          <tbody>
            {costs.byKind.map((k) => (
              <tr key={k.kind}>
                <td>{FACILITY_LABELS[k.kind]}</td>
                <td>{yuan(k.material)}</td>
                <td>{yuan(k.labor)}</td>
                <td>{yuan(k.transport)}</td>
                <td><b>{yuan(k.total)}</b></td>
                <td>{k.count}</td>
              </tr>
            ))}
            {costs.byKind.length === 0 && <tr><td colSpan={6} className="hint">{year} 年暂无维保费用记录</td></tr>}
          </tbody>
        </table>
      </section>

      {/* 账实对账 */}
      <section className="section">
        <h3>账实对账（账面数量 vs 图上实布）</h3>
        {diffs.length > 0 && (
          <p className="bad">
            发现 {diffs.length} 处对不上：
            {diffs.slice(0, 6).map((d) =>
              `${d.buildingName} ${floorLabel(d.floorLevel)} ${FACILITY_LABELS[d.kind]} ${d.diff > 0 ? '少' : '多'}${Math.abs(d.diff)}具`).join('；')}
            {diffs.length > 6 ? ' …' : ''}
          </p>
        )}
        {diffs.length === 0 && expectedRows.length > 0 && (
          <p className="good">✔ 已登记的账面数量与图上实布全部一致</p>
        )}
        <table className="table">
          <thead>
            <tr><th>楼栋</th><th>楼层</th><th>设施类型</th><th>账面（具）</th><th>图上（具）</th><th>差几具</th><th />
            </tr>
          </thead>
          <tbody>
            {expectedRows.map((r) => (
              <tr key={`${r.floorId}-${r.kind}`} className={r.diff !== 0 ? 'overdue-row' : ''}>
                <td>{r.buildingName}</td>
                <td>{floorLabel(r.level)}</td>
                <td>{FACILITY_LABELS[r.kind]}</td>
                <td>
                  <input
                    type="number" min={0} style={{ width: 80 }}
                    value={r.expected}
                    onChange={(e) => setExpectedCount(r.floorId, r.kind, e.target.value === '' ? null : Number(e.target.value))}
                  />
                </td>
                <td>{r.actual}</td>
                <td>
                  {r.diff === 0
                    ? <span className="good">一致</span>
                    : <span className="bad">{r.diff > 0 ? `图上少 ${r.diff}` : `图上多 ${-r.diff}`}</span>}
                </td>
                <td><Link className="btn" to={`/floor/${r.floorId}`}>看图</Link></td>
              </tr>
            ))}
            {expectedRows.length === 0 && (
              <tr><td colSpan={7} className="hint">尚未登记任何楼层的账面数量</td></tr>
            )}
          </tbody>
        </table>
        {unregisteredFloors.length > 0 && (
          <div className="toolbar" style={{ marginTop: 10 }}>
            <span className="hint">以下楼层尚未建立账面数量：</span>
            {unregisteredFloors.slice(0, 8).map((f) => (
              <span key={f.floorId} className="tag">
                {f.buildingName} · {floorLabel(f.level)}
                <button
                  className="ghost"
                  style={{ marginLeft: 6, padding: '0 6px' }}
                  onClick={() => seedExpectedCountsFromMap(f.floorId)}
                  title="以图上当前数量建立账面台账，之后再按实物盘点调整"
                >
                  按图建账
                </button>
              </span>
            ))}
          </div>
        )}
        <p className="hint">
          账面数量按现场实物盘点逐楼层登记；「按图建账」可用图上当前数量初始化后再调整。每具设施的检查与维保履历在楼层编辑器中点击设施查看。
          作业类型：{Object.values(SERVICE_TYPE_LABELS).join(' / ')}
        </p>
      </section>
    </div>
  );
}
