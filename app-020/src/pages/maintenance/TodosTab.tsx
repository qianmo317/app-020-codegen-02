import { useMemo } from 'react';
import type { Building, Floor } from '../../model';
import { collectTodos, type TodoItem } from '../../lib/maintenance';
import { floorLabel } from '../../store/id';
import { Link } from '../../router';

const REASON_LABELS: Record<TodoItem['reason'], string> = {
  hydro: '水压试验',
  scrap: '报废换新',
  check_overdue: '巡检过期',
  check_missing: '缺巡检记录',
  facility_defect: '设施缺陷',
};

/** 待办：提前预警 + 已到期的全部事项，标明送检 / 换新 / 巡检，按紧急程度排序 */
export function TodosTab({ buildings, floors }: { buildings: Building[]; floors: Record<string, Floor> }) {
  const now = Date.now();
  const todos = useMemo(() => collectTodos(buildings, floors, now), [buildings, floors, now]);
  const dueCount = todos.filter((t) => t.due).length;
  const upcomingCount = todos.length - dueCount;

  const exportCsv = () => {
    const header = '建筑,楼层,编号,类型,事项,待办动作,应办日期,剩余天数,状态,说明';
    const lines = todos.map((t) =>
      [
        t.buildingName,
        floorLabel(t.floorLevel),
        t.facilityCode,
        t.reason,
        REASON_LABELS[t.reason],
        t.action,
        t.dueDate ?? '—',
        t.daysLeft ?? '—',
        t.upcoming ? '提前预警' : '已到期',
        t.message,
      ].join(','),
    );
    const blob = new Blob([`﻿${[header, ...lines].join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `维保待办_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <div className="toolbar">
        <span className="tag">已到期 {dueCount}</span>
        <span className="tag">提前预警 {upcomingCount}</span>
        <button onClick={exportCsv} disabled={!todos.length}>导出待办 CSV</button>
        <span className="hint">灭火器到期前 30 天自动提前列入；报废 / 送检按出厂日期与送检记录推算</span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>状态</th><th>建筑</th><th>楼层</th><th>编号</th><th>事项</th>
            <th>待办动作</th><th>应办日期</th><th>剩余</th><th>说明</th><th />
          </tr>
        </thead>
        <tbody>
          {todos.map((t, i) => (
            <tr key={`${t.facilityId}-${t.reason}-${i}`} className={t.upcoming ? '' : 'overdue-row'}>
              <td>
                {t.upcoming
                  ? <span className="badge st-low_pressure">预警</span>
                  : <span className="badge st-expired">到期</span>}
              </td>
              <td>{t.buildingName}</td>
              <td>{floorLabel(t.floorLevel)}</td>
              <td>{t.facilityCode}</td>
              <td>{REASON_LABELS[t.reason]}</td>
              <td><b className={t.action === '换新' ? 'bad' : t.action === '送检' ? 'warn' : ''}>{t.action}</b></td>
              <td>{t.dueDate ?? '—'}</td>
              <td>{t.daysLeft == null ? '—' : t.daysLeft < 0 ? `逾期 ${-t.daysLeft} 天` : `${t.daysLeft} 天`}</td>
              <td className="hint">{t.message}</td>
              <td><Link className="btn" to={`/floor/${t.floorId}`}>处理</Link></td>
            </tr>
          ))}
          {!todos.length && (
            <tr><td colSpan={10} className="hint">暂无待办：所有设施均在检验/寿命周期内</td></tr>
          )}
        </tbody>
      </table>
    </>
  );
}
