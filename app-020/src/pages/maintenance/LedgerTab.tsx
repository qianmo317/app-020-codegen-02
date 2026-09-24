import { Fragment, useMemo, useState } from 'react';
import type { Building, Facility, FacilityKind, Floor } from '../../model';
import { APPEARANCE_LABELS, FACILITY_LABELS, SEAL_LABELS } from '../../model';
import { checkDueInfo } from '../../lib/engine';
import { extinguisherLifecycle } from '../../lib/serviceLife';
import { facilityTimeline, costTotal } from '../../lib/maintenance';
import { SERVICE_KIND_LABELS } from '../../model';
import { floorLabel } from '../../store/id';
import { Link } from '../../router';
import { pointInPoly } from '../../lib/geometry';

type Row = {
  buildingName: string;
  floorId: string;
  floorLevel: number;
  roomName: string;
  fac: Facility;
};

/** 维保台账：全楼设施 + 最近巡检（压力/外观/铅封）+ 寿命状态；展开看单具完整历史 */
export function LedgerTab({ buildings, floors }: { buildings: Building[]; floors: Record<string, Floor> }) {
  const [kindFilter, setKindFilter] = useState<'all' | FacilityKind>('all');
  const [onlyIssue, setOnlyIssue] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const now = Date.now();

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const b of buildings) {
      for (const fid of b.floors) {
        const f = floors[fid];
        if (!f) continue;
        for (const fac of f.facilities) {
          if (kindFilter !== 'all' && fac.kind !== kindFilter) continue;
          const due = checkDueInfo(fac, now);
          const life = fac.kind === 'extinguisher' ? extinguisherLifecycle(fac, now) : null;
          const issue = due.overdue || due.missing || due.defect || !!life?.todo;
          if (onlyIssue && !issue) continue;
          const room = f.rooms.find((r) => pointInPoly({ x: fac.x, y: fac.y }, r.polygon));
          out.push({ buildingName: b.name, floorId: f.id, floorLevel: f.level, roomName: room?.name ?? '—', fac });
        }
      }
    }
    return out;
  }, [buildings, floors, kindFilter, onlyIssue, now]);

  return (
    <>
      <div className="toolbar">
        <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value as 'all' | FacilityKind)}>
          <option value="all">全部类型</option>
          {Object.entries(FACILITY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label className="row">
          <input type="checkbox" checked={onlyIssue} onChange={(e) => setOnlyIssue(e.target.checked)} />
          只看有问题（过期/缺检/损坏/待送检/待换新）
        </label>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>建筑</th><th>楼层</th><th>编号</th><th>类型</th><th>房间</th>
            <th>出厂日期</th><th>最近巡检</th><th>压力</th><th>外观/铅封</th>
            <th>寿命状态</th><th>历史</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ buildingName, floorId, floorLevel, roomName, fac }) => {
            const sorted = [...fac.checks].sort((a, b2) => b2.date.localeCompare(a.date));
            const last = sorted[0];
            const due = checkDueInfo(fac, now);
            const life = fac.kind === 'extinguisher' ? extinguisherLifecycle(fac, now) : null;
            const open = openId === fac.id;
            return (
              <Fragment key={fac.id}>
                <tr className={due.overdue || due.missing || due.defect || life?.todo ? 'overdue-row' : ''}>
                  <td>{buildingName}</td>
                  <td>{floorLabel(floorLevel)}</td>
                  <td>{fac.code}{fac.retiredDate && <span className="badge st-damaged"> 已换</span>}</td>
                  <td>{FACILITY_LABELS[fac.kind]}</td>
                  <td>{roomName}</td>
                  <td>{fac.manufactureDate ?? '—'}</td>
                  <td>{last ? last.date : <span className="bad">未检</span>}</td>
                  <td>
                    {last?.pressureMpa != null
                      ? `${last.pressureMpa}MPa${last.pressureZone === 'red' ? ' 🔴' : last.pressureZone === 'green' ? ' 🟢' : ''}`
                      : '—'}
                  </td>
                  <td>
                    {last
                      ? `${last.appearance ? APPEARANCE_LABELS[last.appearance] : '—'} / ${last.seal ? SEAL_LABELS[last.seal] : '—'}`
                      : '—'}
                  </td>
                  <td>
                    {fac.kind !== 'extinguisher' ? '—'
                      : life?.todo
                        ? <b className={life.action === 'replace' ? 'bad' : 'warn'}>
                            {life.action === 'replace' ? '待换新' : '待送检'}{life.upcoming ? '（预警）' : ''}
                          </b>
                        : fac.retiredDate ? '已退役'
                        : <span className="good">正常</span>}
                  </td>
                  <td>
                    <button className="ghost" onClick={() => setOpenId(open ? null : fac.id)}>
                      {open ? '收起' : `${fac.checks.length + (fac.services?.length ?? 0)} 条`}
                    </button>
                  </td>
                  <td><Link className="btn" to={`/floor/${floorId}`}>图纸</Link></td>
                </tr>
                {open && (
                  <tr className="detail-row">
                    <td colSpan={12}>
                      <FacilityHistory fac={fac} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {!rows.length && (
            <tr><td colSpan={12} className="hint">无符合条件的设施</td></tr>
          )}
        </tbody>
      </table>
    </>
  );
}

/** 单具设施的历史时间线（出厂 → 巡检 → 送检/维修/换新） */
function FacilityHistory({ fac }: { fac: Facility }) {
  const events = facilityTimeline(fac).slice().reverse();
  return (
    <div className="historybox">
      <h4>{fac.code} 历史记录（同一具设施按时间串联）</h4>
      <table className="table subtable">
        <thead>
          <tr><th>日期</th><th>类型</th><th>详情</th><th>费用</th></tr>
        </thead>
        <tbody>
          {events.map((ev, i) => (
            <tr key={i}>
              <td className="nowrap">{ev.date}</td>
              <td>
                <span className={`badge ${ev.type === 'check' ? `st-${ev.check!.status}` : 'st-ok'}`}>
                  {ev.type === 'manufacture' ? '出厂' : ev.type === 'retire' ? '退役' : ev.title}
                </span>
              </td>
              <td>
                {ev.detail || '—'}
                {ev.service?.vendor ? <span className="hint">（{ev.service.vendor}）</span> : null}
              </td>
              <td className="nowrap">{ev.service ? `¥${costTotal(ev.service.cost)}` : '—'}</td>
            </tr>
          ))}
          {!events.length && <tr><td colSpan={4} className="hint">暂无历史记录</td></tr>}
        </tbody>
      </table>
      <p className="hint">
        换下配件的配件号在维保记录详情中保留；服务类别：
        {Object.values(SERVICE_KIND_LABELS).join(' / ')}
      </p>
    </div>
  );
}
