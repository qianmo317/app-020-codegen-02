import { useState } from 'react';
import { addBuilding, deleteBuilding, loadDemo, useStore } from '../store/store';
import { Link } from '../router';
import type { BuildingKind, Floor } from '../model';
import { collectTodos } from '../lib/maintenance';

const KIND_LABELS: Record<BuildingKind, string> = {
  office: '办公楼',
  retail: '商业',
  factory: '厂房',
  school: '学校',
};

export function Home() {
  const buildings = useStore((s) => s.buildings);
  const floors = useStore((s) => s.floors);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<BuildingKind>('office');

  return (
    <div className="page">
      <h2>建筑与楼层</h2>
      <div className="toolbar">
        <input placeholder="建筑名称" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={kind} onChange={(e) => setKind(e.target.value as BuildingKind)}>
          {Object.entries(KIND_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <button
          disabled={!name.trim()}
          onClick={() => {
            addBuilding(name.trim(), kind);
            setName('');
          }}
        >
          新建建筑
        </button>
        <button className="ghost" onClick={() => loadDemo()}>载入示例</button>
      </div>

      {buildings.length === 0 && <p className="hint">还没有建筑。新建一个，或点「载入示例」体验完整流程。</p>}

      <div className="cards">
        {buildings.map((b) => {
          const bfs = b.floors.map((id) => floors[id]).filter(Boolean);
          const errors = bfs.reduce((s, f) => s + (f.lastValidation?.items.filter((i) => i.severity === 'error').length ?? 0), 0);
          const floorMap: Record<string, Floor> = Object.fromEntries(bfs.map((f) => [f.id, f]));
          const todoCount = collectTodos([b], floorMap).length;
          return (
            <div className="card" key={b.id}>
              <div className="cardhead">
                <Link to={`/building/${b.id}`} className="cardtitle">{b.name}</Link>
                <span className="tag">{KIND_LABELS[b.kind]}</span>
              </div>
              <div className="cardmeta">
                {bfs.length} 个楼层 ·
                <span className={errors > 0 ? 'bad' : 'good'}> 超限项 {errors}</span> ·
                <span className={todoCount > 0 ? 'warn' : ''}> 维保待办 {todoCount}</span>
              </div>
              <div className="cardactions">
                <Link className="btn" to={`/building/${b.id}`}>打开</Link>
                <button
                  className="danger"
                  onClick={() => {
                    if (confirm(`删除建筑「${b.name}」及其全部楼层？`)) deleteBuilding(b.id);
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
