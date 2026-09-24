import { useMemo } from 'react';
import type { Building, FacilityKind, Floor } from '../../model';
import { FACILITY_LABELS } from '../../model';
import { setLedgerCount } from '../../store/store';
import { reconcileAll, reconcileFloor } from '../../lib/maintenance';
import { floorLabel } from '../../store/id';
import { Link } from '../../router';

const KIND_ORDER: FacilityKind[] = ['extinguisher', 'hydrant', 'exit_sign', 'emergency_light', 'exit', 'sprinkler'];

/** 账实对账：账上数量（手工盘点录入）与图上实际布置逐楼层、逐类型核对 */
export function ReconcileTab({ buildings, floors }: { buildings: Building[]; floors: Record<string, Floor> }) {
  const discrepancies = useMemo(() => reconcileAll(buildings, floors), [buildings, floors]);
  const diffTotalSum = discrepancies.reduce((s, r) => s + Math.abs(r.diffTotal), 0);

  return (
    <>
      <div className="toolbar">
        <span className={`tag ${discrepancies.length ? '' : 'st-ok'}`}>
          {discrepancies.length ? `${discrepancies.length} 层账实不符，累计差 ${diffTotalSum} 具` : '全部楼层账实相符'}
        </span>
        <span className="hint">「账面数量」填巡检台账/盘点表上的数量；留空表示该类型未盘点（不参与核对）</span>
      </div>

      {discrepancies.length > 0 && (
        <>
          <h3>差异楼层（差几具、差在哪一层）</h3>
          <table className="table">
            <thead><tr><th>建筑</th><th>楼层</th><th>类型</th><th>账面</th><th>图上</th><th>差异</th><th />
            </tr></thead>
            <tbody>
              {discrepancies.flatMap((r) =>
                r.kindDiffs.filter((k) => k.diff !== 0).map((k) => (
                  <tr key={`${r.floorId}-${k.kind}`} className="overdue-row">
                    <td>{r.buildingName}</td>
                    <td><b>{floorLabel(r.floorLevel)}</b></td>
                    <td>{k.label}</td>
                    <td>{k.ledger}</td>
                    <td>{k.onMap}</td>
                    <td>
                      <b className="bad">
                        {k.diff > 0 ? `账上多 ${k.diff} 具（图上少摆）` : `图上多 ${-k.diff} 具（账上漏登）`}
                      </b>
                    </td>
                    <td><Link className="btn" to={`/floor/${r.floorId}`}>去图纸核对</Link></td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </>
      )}

      <h3>逐楼层盘点录入</h3>
      {buildings.map((b) =>
        b.floors.map((fid) => {
          const floor = floors[fid];
          if (!floor) return null;
          const r = reconcileFloor(b, floor);
          const onMapCounts = new Map<FacilityKind, number>();
          for (const f of floor.facilities) onMapCounts.set(f.kind, (onMapCounts.get(f.kind) ?? 0) + 1);
          return (
            <div className="section" key={fid}>
              <div className="toolbar">
                <b>{b.name} · {floorLabel(floor.level)}</b>
                {r.matched
                  ? <span className="badge st-ok">账实相符</span>
                  : <span className="badge st-damaged">差 {r.diffTotal > 0 ? '+' : ''}{r.diffTotal} 具</span>}
                <Link className="btn" to={`/floor/${fid}`}>打开图纸</Link>
              </div>
              <table className="table subtable">
                <thead><tr><th>类型</th><th>账面数量（台账/盘点）</th><th>图上数量</th><th>差异</th></tr></thead>
                <tbody>
                  {KIND_ORDER.map((kind) => {
                    const onMap = onMapCounts.get(kind) ?? 0;
                    const ledger = floor.ledgerCounts?.[kind];
                    const entered = ledger != null;
                    const diff = entered ? ledger - onMap : 0;
                    return (
                      <tr key={kind}>
                        <td>{FACILITY_LABELS[kind]}</td>
                        <td>
                          <input
                            type="number" min={0} style={{ width: 90 }}
                            placeholder="未盘点"
                            value={ledger ?? ''}
                            onChange={(e) =>
                              setLedgerCount(fid, kind, e.target.value === '' ? null : Number(e.target.value))
                            }
                          />
                        </td>
                        <td>{onMap}</td>
                        <td>
                          {!entered ? <span className="hint">未盘点</span>
                            : diff === 0 ? <span className="good">相符</span>
                            : <b className="bad">{diff > 0 ? `+${diff}（图上少）` : `${diff}（账上少）`}</b>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        }),
      )}
      {buildings.length === 0 && <p className="hint">还没有建筑。</p>}
    </>
  );
}
