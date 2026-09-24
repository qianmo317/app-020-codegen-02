import { useMemo, useState } from 'react';
import type { Building, Floor } from '../../model';
import { SERVICE_KIND_LABELS } from '../../model';
import { summarizeCosts } from '../../lib/maintenance';
import { floorLabel } from '../../store/id';
import { Link } from '../../router';

const yuan = (v: number) => `¥${v.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

/** 费用：按楼栋 × 季度汇总（材料/人工/运输），并按设施类型看哪一类最费钱 */
export function CostTab({ buildings, floors }: { buildings: Building[]; floors: Record<string, Floor> }) {
  const currentYear = String(new Date().getFullYear());
  const [year, setYear] = useState(currentYear);
  const summary = useMemo(() => summarizeCosts(buildings, floors, { year }), [buildings, floors, year]);

  const years = useMemo(() => {
    const all = summarizeCosts(buildings, floors);
    const set = new Set(all.services.map((s) => s.date.slice(0, 4)));
    set.add(currentYear);
    return [...set].sort().reverse();
  }, [buildings, floors, currentYear]);

  return (
    <>
      <div className="toolbar">
        <label className="row">年度
          <select value={year} onChange={(e) => setYear(e.target.value)}>
            {years.map((y) => <option key={y} value={y}>{y} 年</option>)}
          </select>
        </label>
        <span className="tag">全年合计 <b className={summary.grandTotal ? 'bad' : ''}>{yuan(summary.grandTotal)}</b></span>
        <span className="hint">费用在登记送检/维修/换新时按材料、人工、运输三项记录</span>
      </div>

      <h3>按楼栋 × 季度</h3>
      <table className="table">
        <thead>
          <tr><th>楼栋</th><th>季度</th><th>材料</th><th>人工</th><th>运输</th><th>小计</th></tr>
        </thead>
        <tbody>
          {summary.byBuildingQuarter.map((bq) =>
            bq.quarters.map((q, i) => (
              <tr key={`${bq.buildingId}-${q.quarter}`}>
                {i === 0 && <td rowSpan={bq.quarters.length}><b>{bq.buildingName}</b><br /><span className="hint">年合计 {yuan(bq.yearTotal)}</span></td>}
                <td>{q.quarter}</td>
                <td>{yuan(q.material)}</td>
                <td>{yuan(q.labor)}</td>
                <td>{yuan(q.transport)}</td>
                <td><b>{yuan(q.total)}</b></td>
              </tr>
            )),
          )}
          {!summary.byBuildingQuarter.length && (
            <tr><td colSpan={6} className="hint">{year} 年暂无维保费用记录</td></tr>
          )}
        </tbody>
      </table>

      <h3>按设施类型（哪一类最费钱）</h3>
      <table className="table" style={{ maxWidth: 640 }}>
        <thead><tr><th>设施类型</th><th>维保次数</th><th>费用合计</th><th>占比</th></tr></thead>
        <tbody>
          {summary.byFacilityKind.map((k, i) => (
            <tr key={k.facilityKind} className={i === 0 && k.total > 0 ? 'overdue-row' : ''}>
              <td>{i === 0 && k.total > 0 ? `🏆 ${k.label}` : k.label}</td>
              <td>{k.count}</td>
              <td><b>{yuan(k.total)}</b></td>
              <td>{summary.grandTotal ? `${Math.round((k.total / summary.grandTotal) * 100)}%` : '—'}</td>
            </tr>
          ))}
          {!summary.byFacilityKind.length && <tr><td colSpan={4} className="hint">无数据</td></tr>}
        </tbody>
      </table>

      <h3>费用明细</h3>
      <table className="table">
        <thead>
          <tr><th>日期</th><th>楼栋</th><th>楼层</th><th>设施编号</th><th>类别</th><th>材料</th><th>人工</th><th>运输</th><th>合计</th><th /></tr>
        </thead>
        <tbody>
          {summary.services.map((s) => (
            <tr key={s.id}>
              <td className="nowrap">{s.date}</td>
              <td>{s.buildingName}</td>
              <td>{floorLabel(s.floorLevel)}</td>
              <td>{s.facilityCode}</td>
              <td>{SERVICE_KIND_LABELS[s.kind]}</td>
              <td>{yuan(s.cost.material)}</td>
              <td>{yuan(s.cost.labor)}</td>
              <td>{yuan(s.cost.transport)}</td>
              <td><b>{yuan(s.total)}</b></td>
              <td><Link className="btn" to={`/floor/${s.floorId}`}>查看</Link></td>
            </tr>
          ))}
          {!summary.services.length && <tr><td colSpan={10} className="hint">无明细</td></tr>}
        </tbody>
      </table>
    </>
  );
}
