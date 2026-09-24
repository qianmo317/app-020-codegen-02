import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppearanceStatus,
  Facility,
  Pt,
  ReplacedPart,
  Room,
  RoomUsage,
  SealStatus,
  ServiceType,
} from '../model';
import {
  APPEARANCE_LABELS,
  CHECK_STATUS_LABELS,
  SEAL_LABELS,
  SERVICE_TYPE_LABELS,
  USAGE_LABELS,
  FACILITY_LABELS,
} from '../model';
import { addRoom, addFacility, deleteFacility, deleteRoom, moveFacility, moveRoom, updateRoom, updateFacility, setUnderlay, setLastValidation, useStore, addCheck, deleteCheck, addService, deleteService } from '../store/store';
import { floorLabel } from '../store/id';
import { getBlob, putBlob, compressImage } from '../store/db';
import { uid } from '../store/id';
import { bboxOf } from '../lib/geometry';
import { computeCoverage, validateFloor } from '../lib/engine';
import { extinguisherLife, facilityTimeline } from '../lib/maintenance';
import { FloorPlan, mmFromEvent, wheelZoom, type DragState, type Selection, type Tool, type View } from '../components/FloorPlan';
import { FacilityGlyph, USAGE_FILLS } from '../components/symbols';

import { ValidationPanel } from '../components/ValidationPanel';
import { Link } from '../router';

const SNAP = 100; // 绘制/拖动吸附 0.1m
const snap = (v: number) => Math.round(v / SNAP) * SNAP;

const ROOM_USAGES: RoomUsage[] = ['office', 'retail', 'storage', 'ward', 'other'];
const FAC_KINDS = ['extinguisher', 'hydrant', 'exit_sign', 'emergency_light', 'exit', 'sprinkler'] as const;

type Props = { floorId: string };

export function FloorEditor({ floorId }: Props) {
  const floor = useStore((s) => s.floors[floorId]);
  const building = useStore((s) => s.buildings.find((b) => b.id === floor?.buildingId));
  const rules = useStore((s) => (floor ? s.rules[s.buildings.find((b) => b.id === floor.buildingId)?.kind ?? 'office'] : undefined));
  const rulesVersion = rules?.version ?? 0;

  const [tool, setTool] = useState<Tool>('select');
  const [roomUsage, setRoomUsage] = useState<RoomUsage>('office');
  const [draftPoints, setDraftPoints] = useState<Pt[]>([]);
  const [draftCursor, setDraftCursor] = useState<Pt | null>(null);
  const [selected, setSelected] = useState<Selection>(null);
  const [view, setView] = useState<View>({ cx: 20000, cy: 10000, zoom: 0.06 });
  const [drag, setDrag] = useState<DragState>(null);
  const [dragDelta, setDragDelta] = useState<Pt>({ x: 0, y: 0 });
  const [coverageCells, setCoverageCells] = useState<Pt[] | null>(null);
  const [highlight, setHighlight] = useState<Pt | null>(null);
  const [underlayUrl, setUnderlayUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // 底图 URL 加载
  useEffect(() => {
    let url: string | null = null;
    let revoked = false;
    if (floor?.underlay) {
      getBlob(floor.underlay.key).then((blob) => {
        if (blob && !revoked) {
          url = URL.createObjectURL(blob);
          setUnderlayUrl(url);
        }
      });
    } else {
      setUnderlayUrl(null);
    }
    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [floor?.underlay?.key]);

  // 初始视野：按楼层范围适配
  useEffect(() => {
    if (!floor) return;
    const polys = floor.rooms.map((r) => r.polygon);
    if (!polys.length) return;
    const bb = bboxOf(polys);
    const el = svgRef.current;
    const pxW = el ? el.clientWidth : 800;
    const pxH = el ? el.clientHeight : 600;
    const wMm = bb.maxX - bb.minX + 8000;
    const hMm = bb.maxY - bb.minY + 8000;
    setView({
      cx: (bb.minX + bb.maxX) / 2,
      cy: (bb.minY + bb.maxY) / 2,
      zoom: Math.min(pxW / wMm, pxH / hMm),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floorId, floor?.rooms.length === 0]);

  // 自动校验（防抖）
  useEffect(() => {
    if (!floor || !rules) return;
    setBusy(true);
    const t = setTimeout(() => {
      // 引擎计算放在下一帧，保证「校验中」状态先渲染
      requestAnimationFrame(() => {
        const result = validateFloor(floor, rules);
        setLastValidation(floorId, result);
        setBusy(false);
      });
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floorId, floor?.version, rulesVersion]);

  if (!floor || !rules) {
    return <div className="page">楼层不存在。<Link to="/">返回首页</Link></div>;
  }

  const toMm = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const svg = svgRef.current!;
      return mmFromEvent(svg, view, e);
    },
    [view],
  );

  // ---------- 画布事件 ----------

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button === 1 || tool === 'pan' || (tool === 'select' && e.currentTarget === e.target)) {
      const p = toMm(e);
      setDrag({ kind: 'pan', startMm: p, orig: { cx: view.cx, cy: view.cy }, moved: false });
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    if (tool === 'select') {
      setSelected(null);
      return;
    }
  };

  const onRoomDown = (e: React.PointerEvent<SVGGElement>, room: Room) => {
    if (tool !== 'select') return;
    const p = toMm(e);
    setSelected({ type: 'room', id: room.id });
    setDrag({ kind: 'room', id: room.id, startMm: p, orig: room.polygon, moved: false });
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onFacilityDown = (e: React.PointerEvent<SVGGElement>, fac: Facility) => {
    if (tool !== 'select') return;
    const p = toMm(e);
    setSelected({ type: 'facility', id: fac.id });
    setDrag({ kind: 'facility', id: fac.id, startMm: p, orig: { x: fac.x, y: fac.y }, moved: false });
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = toMm(e);
    if (tool === 'room' || tool === 'corridor') setDraftCursor({ x: snap(p.x), y: snap(p.y) });
    if (!drag) return;
    if (drag.kind === 'pan') {
      const o = drag.orig as { cx: number; cy: number };
      const dx = (p.x - drag.startMm.x) * view.zoom;
      const dy = (p.y - drag.startMm.y) * view.zoom;
      setView({ ...view, cx: o.cx - dx / view.zoom, cy: o.cy - dy / view.zoom });
      return;
    }
    const dx = snap(p.x - drag.startMm.x);
    const dy = snap(p.y - drag.startMm.y);
    if (dx !== 0 || dy !== 0) drag.moved = true;
    setDragDelta({ x: dx, y: dy });
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag) {
      // 绘制/放置点击
      const p = toMm(e);
      const sp = { x: snap(p.x), y: snap(p.y) };
      if (tool === 'room' || tool === 'corridor') {
        // 双击起点附近闭合
        if (draftPoints.length >= 3 && Math.hypot(sp.x - draftPoints[0].x, sp.y - draftPoints[0].y) < 600) {
          commitDraft();
          return;
        }
        setDraftPoints([...draftPoints, sp]);
      } else if (tool !== 'select' && tool !== 'pan') {
        addFacility(floorId, tool, sp.x, sp.y);
      }
      return;
    }
    const d = drag;
    const delta = dragDelta;
    setDrag(null);
    setDragDelta({ x: 0, y: 0 });
    if (!d.moved || (delta.x === 0 && delta.y === 0)) {
      if (d.kind === 'pan') return;
      if (d.kind === 'mark') return;
    }
    if (d.kind === 'room' && d.id && (delta.x !== 0 || delta.y !== 0)) {
      moveRoom(floorId, d.id, delta.x, delta.y);
    } else if (d.kind === 'facility' && d.id && (delta.x !== 0 || delta.y !== 0)) {
      const fac = floor.facilities.find((f) => f.id === d.id);
      if (fac) moveFacility(floorId, d.id, fac.x + delta.x, fac.y + delta.y);
    }
  };

  const commitDraft = () => {
    if (draftPoints.length >= 3) {
      addRoom(floorId, draftPoints, tool === 'corridor' ? `走道${floor.rooms.filter((r) => r.usage === 'corridor').length + 1}` : `房间${floor.rooms.length + 1}`, tool === 'corridor' ? 'corridor' : roomUsage);
    }
    setDraftPoints([]);
    setDraftCursor(null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitDraft();
    if (e.key === 'Escape') {
      setDraftPoints([]);
      setDraftCursor(null);
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      if (selected.type === 'room') deleteRoom(floorId, selected.id);
      else deleteFacility(floorId, selected.id);
      setSelected(null);
    }
  };

  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const svg = svgRef.current!;
    setView(wheelZoom(view, e, svg));
  };

  const locate = (pt: Pt | null | undefined, sel?: Selection) => {
    if (pt) {
      setHighlight(pt);
      setView((v) => ({ ...v, cx: pt.x, cy: pt.y }));
      setTimeout(() => setHighlight(null), 2500);
    }
    if (sel) setSelected(sel);
    setTool('select');
  };

  const showCoverage = () => {
    if (coverageCells) {
      setCoverageCells(null);
      return;
    }
    const exts = floor.facilities.filter((f) => f.kind === 'extinguisher').map((f) => ({ x: f.x, y: f.y }));
    const res = computeCoverage(floor.rooms, exts, rules.extinguisherRadiusM, true);
    setCoverageCells(res.cells);
  };

  const importUnderlay = async (file: File) => {
    const { blob, w, h } = await compressImage(file, 1600);
    const key = `underlay/${uid()}`;
    await putBlob(key, blob);
    const polys = floor.rooms.map((r) => r.polygon);
    const bb = polys.length ? bboxOf(polys) : { minX: 0, minY: 0, maxX: 40000, maxY: 30000 };
    const scale = (bb.maxX - bb.minX) / w || 10;
    setUnderlay(floorId, {
      key,
      wPx: w,
      hPx: h,
      offsetX: bb.minX,
      offsetY: bb.minY,
      scaleMmPerPx: scale,
      opacity: 0.5,
      visible: true,
    });
  };

  const selRoom: Room | undefined = selected?.type === 'room' ? floor.rooms.find((r) => r.id === selected.id) : undefined;
  const selFac: Facility | undefined = selected?.type === 'facility' ? floor.facilities.find((f) => f.id === selected.id) : undefined;
  const result = floor.lastValidation;

  return (
    <div className="editor" onKeyDown={onKeyDown} tabIndex={-1}>
      {/* 左栏：工具与元素库 */}
      <aside className="panel left">
        <div className="crumb">
          <Link to="/">{building?.name ?? '未命名建筑'}</Link> / {floorLabel(floor.level)} 层
        </div>
        <section>
          <h4>工具</h4>
          <div className="toolgrid">
            <button className={tool === 'select' ? 'on' : ''} onClick={() => { setTool('select'); setDraftPoints([]); }}>选择/移动</button>
            <button className={tool === 'pan' ? 'on' : ''} onClick={() => setTool('pan')}>平移</button>
            <button className={tool === 'room' ? 'on' : ''} onClick={() => setTool('room')}>画房间</button>
            <button className={tool === 'corridor' ? 'on' : ''} onClick={() => setTool('corridor')}>画走道</button>
          </div>
          {tool === 'room' && (
            <div className="toolgrid">
              {ROOM_USAGES.map((u) => (
                <button key={u} className={roomUsage === u ? 'on' : ''} onClick={() => setRoomUsage(u)}>
                  <span className="swatch" style={{ background: USAGE_FILLS[u] }} />
                  {USAGE_LABELS[u]}
                </button>
              ))}
            </div>
          )}
          <p className="hint">{tool === 'room' || tool === 'corridor' ? '点击落点，Enter/双击起点闭合，Esc 取消' : '滚轮缩放，拖动空白处平移'}</p>
        </section>
        <section>
          <h4>设施</h4>
          <div className="toolgrid">
            {FAC_KINDS.map((k) => (
              <button key={k} className={tool === k ? 'on' : ''} onClick={() => setTool(k)}>
                <FacilityGlyph kind={k} s={7} />
                {FACILITY_LABELS[k]}
              </button>
            ))}
          </div>
        </section>
        <section>
          <h4>底图</h4>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && importUnderlay(e.target.files[0])} />
          <button onClick={() => fileRef.current?.click()}>导入底图图片</button>
          {floor.underlay && (
            <div className="stack">
              <label className="row">
                <input
                  type="checkbox"
                  checked={floor.underlay.visible}
                  onChange={(e) => floor.underlay && setUnderlay(floorId, { ...floor.underlay, visible: e.target.checked })}
                />
                显示底图
              </label>
              <label className="row">
                不透明度
                <input
                  type="range" min={0.05} max={1} step={0.05}
                  value={floor.underlay.opacity}
                  onChange={(e) => floor.underlay && setUnderlay(floorId, { ...floor.underlay, opacity: Number(e.target.value) })}
                />
              </label>
              <label className="row">
                比例 (mm/px)
                <input
                  type="number" min={0.5} step={0.5} style={{ width: 70 }}
                  value={floor.underlay.scaleMmPerPx}
                  onChange={(e) => floor.underlay && setUnderlay(floorId, { ...floor.underlay, scaleMmPerPx: Math.max(0.1, Number(e.target.value)) })}
                />
              </label>
              <button className="ghost" onClick={() => { if (floor.underlay) setUnderlay(floorId, undefined); }}>移除底图</button>
            </div>
          )}
        </section>
        <section>
          <h4>图例</h4>
          <div className="legend">
            {FAC_KINDS.map((k) => (
              <span key={k} className="legendrow">
                <span className="glyphbox"><FacilityGlyph kind={k} s={6} /></span>
                {FACILITY_LABELS[k]}
              </span>
            ))}
          </div>
        </section>
      </aside>

      {/* 中栏：图纸 */}
      <div className="canvas-wrap">
        <div className="canvas-toolbar">
          <span>{floorLabel(floor.level)} · {floor.rooms.length} 房间 · {floor.facilities.length} 设施</span>
          <button className={coverageCells ? 'on' : ''} onClick={showCoverage}>
            {coverageCells ? '隐藏未覆盖区域' : '显示未覆盖区域'}
          </button>
          <button onClick={() => { setView((v) => ({ ...v, zoom: Math.min(3, v.zoom * 1.3) })) }}>放大</button>
          <button onClick={() => { setView((v) => ({ ...v, zoom: Math.max(0.008, v.zoom / 1.3) })) }}>缩小</button>
          <Link className="btn" to={`/floor/${floorId}/print`}>打印 / 出图</Link>
        </div>
        <svg
          ref={svgRef}
          className="canvas"
          tabIndex={0}
          viewBox={`${view.cx - 500 / view.zoom} ${view.cy - 400 / view.zoom} ${1000 / view.zoom} ${800 / view.zoom}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          onWheel={onWheel}
          onDoubleClick={() => { if (tool === 'room' || tool === 'corridor') commitDraft(); }}
        >
          <FloorPlan
            floor={floor}
            view={view}
            svgRef={svgRef}
            underlayUrl={underlayUrl}
            selected={selected}
            drag={drag}
            dragDelta={dragDelta}
            draftPoints={draftPoints}
            draftCursor={draftCursor}
            coverageCells={coverageCells}
            highlight={highlight}
            markPt={null}
            onRoomPointerDown={onRoomDown}
            onFacilityPointerDown={onFacilityDown}
          />
        </svg>
      </div>

      {/* 右栏：校验与属性 */}
      <aside className="panel right">
        <ValidationPanel
          floorId={floorId}
          result={result ?? null}
          busy={busy}
          rules={rules}
          onLocate={locate}
        />
        {selRoom && (
          <section>
            <h4>房间属性</h4>
            <label className="row">名称 <input value={selRoom.name} onChange={(e) => updateRoom(floorId, selRoom.id, { name: e.target.value })} /></label>
            <label className="row">用途
              <select value={selRoom.usage} onChange={(e) => updateRoom(floorId, selRoom.id, { usage: e.target.value as RoomUsage })}>
                {Object.entries(USAGE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label className="row">人数 <input type="number" min={0} value={selRoom.occupants ?? ''} placeholder="按面积估算" onChange={(e) => updateRoom(floorId, selRoom.id, { occupants: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
            <p className="hint">面积 {selRoom.areaM2.toFixed(1)}㎡（多边形自动计算）</p>
            <button className="danger" onClick={() => { deleteRoom(floorId, selRoom.id); setSelected(null); }}>删除房间</button>
          </section>
        )}
        {selFac && (
          <FacilityInspector floorId={floorId} fac={selFac} onDelete={() => { deleteFacility(floorId, selFac.id); setSelected(null); }} />
        )}
      </aside>
    </div>
  );
}

function FacilityInspector({ floorId, fac, onDelete }: { floorId: string; fac: Facility; onDelete: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const now = Date.now();

  // ---------- 检查表单 ----------
  const [date, setDate] = useState(today);
  const [status, setStatus] = useState<'ok' | 'low_pressure' | 'expired' | 'damaged' | 'missing'>('ok');
  const [pressureMpa, setPressureMpa] = useState('');
  const [appearance, setAppearance] = useState<AppearanceStatus>('intact');
  const [seal, setSeal] = useState<SealStatus>('intact');
  const [note, setNote] = useState('');
  const photoInput = useRef<HTMLInputElement | null>(null);

  // ---------- 维保表单 ----------
  const [svcDate, setSvcDate] = useState(today);
  const [svcType, setSvcType] = useState<ServiceType>('maintenance');
  const [material, setMaterial] = useState('');
  const [labor, setLabor] = useState('');
  const [transport, setTransport] = useState('');
  const [vendor, setVendor] = useState('');
  const [reportNo, setReportNo] = useState('');
  const [newMfg, setNewMfg] = useState('');
  const [partName, setPartName] = useState('');
  const [partNo, setPartNo] = useState('');
  const [parts, setParts] = useState<ReplacedPart[]>([]);
  const [svcNote, setSvcNote] = useState('');
  const [showSvc, setShowSvc] = useState(false);

  const life = fac.kind === 'extinguisher' ? extinguisherLife(fac, now) : null;
  const timeline = useMemo(() => facilityTimeline(fac), [fac]);

  // 履历中照片按 ServiceRecord/检查定位不便于索引，这里直接按 fac.checks 的下标加载
  const [photoUrls, setPhotoUrls] = useState<Record<number, string>>({});
  useEffect(() => {
    let cancelled = false;
    const urls: Record<number, string> = {};
    Promise.all(
      fac.checks.map(async (c, i) => {
        if (!c.photoKey) return;
        const blob = await getBlob(c.photoKey);
        if (blob) urls[i] = URL.createObjectURL(blob);
      }),
    ).then(() => {
      if (!cancelled) setPhotoUrls(urls);
    });
    return () => {
      cancelled = true;
      Object.values(urls).forEach((u) => URL.revokeObjectURL(u));
    };
  }, [fac.checks]);

  const photoUrlByKey = (key?: string) => {
    if (!key) return undefined;
    const idx = fac.checks.findIndex((c) => c.photoKey === key);
    return idx >= 0 ? photoUrls[idx] : undefined;
  };

  const submitCheck = async () => {
    let photoKey: string | undefined;
    const file = photoInput.current?.files?.[0];
    if (file) {
      const { blob } = await compressImage(file, 1600);
      photoKey = `photo/${uid()}`;
      await putBlob(photoKey, blob);
    }
    addCheck(floorId, fac.id, {
      date,
      status,
      pressureMpa: pressureMpa === '' ? undefined : Number(pressureMpa),
      appearance,
      seal,
      note: note || undefined,
      photoKey,
    });
    setNote('');
    setPressureMpa('');
    if (photoInput.current) photoInput.current.value = '';
  };

  const num = (s: string) => (s === '' ? 0 : Number(s) || 0);

  const addPart = () => {
    if (!partName.trim()) return;
    setParts([...parts, { name: partName.trim(), partNo: partNo.trim() || undefined, qty: 1 }]);
    setPartName('');
    setPartNo('');
  };

  const submitService = () => {
    addService(floorId, fac.id, {
      date: svcDate,
      type: svcType,
      cost: { material: num(material), labor: num(labor), transport: num(transport) },
      parts: parts.length ? parts : undefined,
      vendor: vendor.trim() || undefined,
      reportNo: reportNo.trim() || undefined,
      newManufactureDate: svcType === 'replacement' && newMfg ? newMfg : undefined,
      note: svcNote.trim() || undefined,
    });
    setShowSvc(false);
    setMaterial('');
    setLabor('');
    setTransport('');
    setVendor('');
    setReportNo('');
    setNewMfg('');
    setParts([]);
    setSvcNote('');
  };

  return (
    <section>
      <h4>设施 · {fac.code}</h4>
      <p className="hint">坐标 {(fac.x / 1000).toFixed(1)}m, {(fac.y / 1000).toFixed(1)}m</p>
      {fac.kind === 'extinguisher' && (
        <>
          <label className="row">类型
            <select
              value={fac.spec?.extType ?? 'dry_powder'}
              onChange={(e) => updateFacility(floorId, fac.id, { spec: { ...fac.spec, extType: e.target.value as 'dry_powder' | 'co2' | 'water' } })}
            >
              <option value="dry_powder">干粉</option>
              <option value="co2">二氧化碳</option>
              <option value="water">水基</option>
            </select>
          </label>
          <label className="row">规格 (kg)
            <input
              type="number" min={0}
              value={fac.spec?.weightKg ?? ''}
              onChange={(e) => updateFacility(floorId, fac.id, { spec: { ...fac.spec, weightKg: Number(e.target.value) } })}
            />
          </label>
          <label className="row">出厂日期
            <input
              type="date"
              value={fac.manufactureDate ?? ''}
              onChange={(e) => updateFacility(floorId, fac.id, { manufactureDate: e.target.value || undefined })}
            />
          </label>
          {life && (
            <div className={`lifecard ${life.scrapOverdue || life.hydroOverdue ? 'life-bad' : life.scrapSoon || life.hydroSoon ? 'life-soon' : 'life-ok'}`}>
              {!life.basisDate ? (
                <span className="bad">未登记出厂日期，无法判定年限</span>
              ) : (
                <>
                  <div>寿命起点：{life.basisDate}</div>
                  <div>
                    下次水压试验：<b>{life.hydroDueDate ?? '报废前无需再试'}</b>
                    {life.hydroOverdue && <span className="badge act-hydro">已逾期·送检</span>}
                    {!life.hydroOverdue && life.hydroSoon && <span className="badge act-hydro">临近·送检</span>}
                    <span className="hint">（每 {life.hydroIntervalYears} 年，上次 {life.lastHydroDate ?? '未送检'}）</span>
                  </div>
                  <div>
                    报废日期：<b>{life.scrapDate}</b>
                    {life.scrapOverdue && <span className="badge act-replace">已到期·换新</span>}
                    {!life.scrapOverdue && life.scrapSoon && <span className="badge act-replace">临近·换新</span>}
                    <span className="hint">（{life.scrapYears} 年）</span>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}

      {/* 履历时间线（检查 + 维保按时间倒序） */}
      <h4>履历（检查 / 维保）</h4>
      <div className="checks">
        {timeline.map((e) =>
          e.kind === 'check' ? (
            <div key={`c-${e.date}-${e.status}-${e.note ?? ''}`} className="checkrow tl-check">
              <span>{e.date}</span>
              <span className="badge st-ok">检</span>
              <span className={`badge st-${e.status}`}>{CHECK_STATUS_LABELS[e.status as keyof typeof CHECK_STATUS_LABELS] ?? e.status}</span>
              {e.pressureMpa != null && <span className="hint">{e.pressureMpa}MPa</span>}
              {e.appearance && e.appearance !== 'intact' && <span className="hint">外观:{APPEARANCE_LABELS[e.appearance as AppearanceStatus]}</span>}
              {e.seal && e.seal !== 'intact' && <span className="bad">铅封:{SEAL_LABELS[e.seal as SealStatus]}</span>}
              {e.note && <span className="hint">{e.note}</span>}
              {(() => {
                const u = photoUrlByKey(e.photoKey);
                return u ? <img className="thumb" src={u} alt="检查照片" /> : null;
              })()}
              <button className="ghost" onClick={() => deleteCheck(floorId, fac.id, e.checkIndex)}>删</button>
            </div>
          ) : (
            <div key={e.ref.id} className="checkrow tl-service">
              <span>{e.date}</span>
              <span className={`badge svc-${e.serviceType}`}>{SERVICE_TYPE_LABELS[e.serviceType]}</span>
              <span className="hint">¥{e.totalCost.toFixed(2)}</span>
              {e.parts.map((p) => (
                <span key={`${p.name}-${p.partNo ?? ''}`} className="tag" title="已更换配件（含配件号）">
                  {p.name}{p.partNo ? ` ${p.partNo}` : ''}
                </span>
              ))}
              {e.reportNo && <span className="hint">报告号 {e.reportNo}</span>}
              {e.newManufactureDate && <span className="good">新具出厂 {e.newManufactureDate}</span>}
              {e.vendor && <span className="hint">{e.vendor}</span>}
              {e.note && <span className="hint">{e.note}</span>}
              <button className="ghost" onClick={() => deleteService(floorId, fac.id, e.ref.id)}>删</button>
            </div>
          ),
        )}
        {!timeline.length && <p className="hint">暂无记录</p>}
      </div>

      {/* 登记检查：压力 / 外观 / 铅封 / 照片 */}
      <div className="stack">
        <h4>登记检查</h4>
        <label className="row">日期 <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="row">状态
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            {Object.entries(CHECK_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="row">压力表读数 (MPa)
          <input type="number" step="0.01" min={0} placeholder="无压力表留空" value={pressureMpa} onChange={(e) => setPressureMpa(e.target.value)} />
        </label>
        <label className="row">外观
          <select value={appearance} onChange={(e) => setAppearance(e.target.value as AppearanceStatus)}>
            {Object.entries(APPEARANCE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="row">铅封
          <select value={seal} onChange={(e) => setSeal(e.target.value as SealStatus)}>
            {Object.entries(SEAL_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="row">备注 <input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <label className="row">照片 <input ref={photoInput} type="file" accept="image/*" capture="environment" /></label>
        <button onClick={submitCheck}>登记检查</button>
      </div>

      {/* 登记维修 / 送检 / 换新（费用：材料、人工、运输；换配件留配件号） */}
      <div className="stack">
        {!showSvc ? (
          <button onClick={() => setShowSvc(true)}>登记维修 / 送检 / 换新</button>
        ) : (
          <>
            <h4>维保作业</h4>
            <label className="row">日期 <input type="date" value={svcDate} onChange={(e) => setSvcDate(e.target.value)} /></label>
            <label className="row">类型
              <select value={svcType} onChange={(e) => setSvcType(e.target.value as ServiceType)}>
                {Object.entries(SERVICE_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label className="row">材料费 (元) <input type="number" min={0} step="0.01" value={material} onChange={(e) => setMaterial(e.target.value)} /></label>
            <label className="row">人工费 (元) <input type="number" min={0} step="0.01" value={labor} onChange={(e) => setLabor(e.target.value)} /></label>
            <label className="row">运输费 (元) <input type="number" min={0} step="0.01" value={transport} onChange={(e) => setTransport(e.target.value)} /></label>
            <label className="row">承修/送检单位 <input value={vendor} onChange={(e) => setVendor(e.target.value)} /></label>
            <label className="row">报告/证书号 <input value={reportNo} onChange={(e) => setReportNo(e.target.value)} /></label>
            {svcType === 'replacement' && (
              <label className="row">新具出厂日期 <input type="date" value={newMfg} onChange={(e) => setNewMfg(e.target.value)} /></label>
            )}
            <div className="stack">
              <span className="hint">更换的配件（留下配件号）：</span>
              {parts.map((p, i) => (
                <span key={i} className="row">
                  <span className="tag">{p.name}{p.partNo ? ` ${p.partNo}` : ''}</span>
                  <button className="ghost" onClick={() => setParts(parts.filter((_, j) => j !== i))}>移除</button>
                </span>
              ))}
              <label className="row">配件名称 <input value={partName} onChange={(e) => setPartName(e.target.value)} placeholder="如 压力表" /></label>
              <label className="row">配件号/型号 <input value={partNo} onChange={(e) => setPartNo(e.target.value)} placeholder="如 PG-M10-1.6" /></label>
              <button onClick={addPart}>添加配件</button>
            </div>
            <label className="row">备注 <input value={svcNote} onChange={(e) => setSvcNote(e.target.value)} /></label>
            <div className="toolbar">
              <button onClick={submitService}>保存维保记录</button>
              <button className="ghost" onClick={() => setShowSvc(false)}>取消</button>
            </div>
          </>
        )}
      </div>
      <button className="danger" onClick={onDelete}>删除设施</button>
    </section>
  );
}
