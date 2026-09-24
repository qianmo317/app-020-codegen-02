import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Cost,
  Facility,
  HydroResult,
  PartRecord,
  PressureZone,
  AppearanceState,
  SealState,
  ServiceKind,
} from '../model';
import {
  APPEARANCE_LABELS,
  HYDRO_RESULT_LABELS,
  PRESSURE_ZONE_LABELS,
  SEAL_LABELS,
  SERVICE_KIND_LABELS,
} from '../model';
import {
  addService,
  addCheck,
  deleteCheck,
  deleteService,
  updateFacility,
} from '../store/store';
import { getBlob, putBlob, compressImage } from '../store/db';
import { uid } from '../store/id';
import { extinguisherLifecycle } from '../lib/serviceLife';
import { facilityTimeline, costTotal } from '../lib/maintenance';

type Props = {
  floorId: string;
  fac: Facility;
  onDelete: () => void;
};

const emptyCost: Cost = { material: 0, labor: 0, transport: 0 };

/** 设施维保检查器：巡检（压力/外观/铅封/照片）+ 送检/维修/换新（费用/配件号）+ 历史时间线 */
export function FacilityInspector({ floorId, fac, onDelete }: Props) {
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});

  // 照片按记录 id 建索引（check 与带照片服务暂只支持巡检照片；key 形如 check:<id>）
  useEffect(() => {
    let cancelled = false;
    const urls: Record<string, string> = {};
    Promise.all(
      fac.checks.map(async (c, i) => {
        if (!c.photoKey) return;
        const blob = await getBlob(c.photoKey);
        if (blob) urls[`c${i}`] = URL.createObjectURL(blob);
      }),
    ).then(() => {
      if (!cancelled) setPhotoUrls(urls);
    });
    return () => {
      cancelled = true;
      Object.values(urls).forEach((u) => URL.revokeObjectURL(u));
    };
  }, [fac.checks]);

  const life = fac.kind === 'extinguisher' ? extinguisherLifecycle(fac) : null;

  return (
    <section>
      <h4>设施 · {fac.code}{fac.retiredDate && <span className="badge st-damaged"> 已换新</span>}</h4>
      <p className="hint">坐标 {(fac.x / 1000).toFixed(1)}m, {(fac.y / 1000).toFixed(1)}m</p>
      {fac.kind === 'extinguisher' && (
        <ExtinguisherFields floorId={floorId} fac={fac} lifeMessage={life?.message ?? null} lifeTodo={life?.todo ?? false} />
      )}
      <CheckForm floorId={floorId} fac={fac} />
      <ServiceForm floorId={floorId} fac={fac} />
      <HistoryTimeline floorId={floorId} fac={fac} photoUrls={photoUrls} />
      <button className="danger" onClick={onDelete}>删除设施</button>
    </section>
  );
}

/** 灭火器专属：规格、出厂日期、水压试验/报废寿命面板 */
function ExtinguisherFields({
  floorId,
  fac,
  lifeMessage,
  lifeTodo,
}: {
  floorId: string;
  fac: Facility;
  lifeMessage: string | null;
  lifeTodo: boolean;
}) {
  return (
    <>
      <label className="row">类型
        <select
          value={fac.spec?.extType ?? 'dry_powder'}
          onChange={(e) =>
            updateFacility(floorId, fac.id, {
              spec: { ...fac.spec, extType: e.target.value as NonNullable<Facility['spec']>['extType'] },
            })
          }
        >
          <option value="dry_powder">干粉（报废 10 年）</option>
          <option value="co2">二氧化碳（报废 12 年）</option>
          <option value="water">水基（报废 6 年）</option>
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
      {lifeMessage && (
        <p className={`hint ${lifeTodo ? 'bad' : ''}`} style={lifeTodo ? { fontWeight: 600 } : undefined}>
          {lifeTodo ? '⏰ ' : ''}{lifeMessage}
        </p>
      )}
    </>
  );
}

/** 巡检登记：压力（读数+表区）、外观、铅封、照片、备注 */
function CheckForm({ floorId, fac }: { floorId: string; fac: Facility }) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [status, setStatus] = useState<'ok' | 'low_pressure' | 'expired' | 'damaged' | 'missing'>('ok');
  const [pressureMpa, setPressureMpa] = useState('');
  const [pressureZone, setPressureZone] = useState<PressureZone>('na');
  const [appearance, setAppearance] = useState<AppearanceState>('intact');
  const [seal, setSeal] = useState<SealState>('intact');
  const [note, setNote] = useState('');
  const photoInput = useRef<HTMLInputElement | null>(null);

  const submit = async () => {
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
      pressureZone: fac.kind === 'extinguisher' ? pressureZone : 'na',
      appearance,
      seal,
      note: note || undefined,
      photoKey,
    });
    setNote('');
    setPressureMpa('');
    if (photoInput.current) photoInput.current.value = '';
  };

  const isExt = fac.kind === 'extinguisher';

  return (
    <>
      <h4>巡检登记</h4>
      <div className="stack">
        <label className="row">日期 <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="row">结论
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="ok">正常</option>
            <option value="low_pressure">压力不足</option>
            <option value="expired">药剂过期</option>
            <option value="damaged">损坏</option>
            <option value="missing">缺失</option>
          </select>
        </label>
        {isExt && (
          <>
            <label className="row">压力表 (MPa)
              <input type="number" step="0.05" min={0} value={pressureMpa} placeholder="如 1.2"
                onChange={(e) => setPressureMpa(e.target.value)} />
            </label>
            <label className="row">表针分区
              <select value={pressureZone} onChange={(e) => setPressureZone(e.target.value as PressureZone)}>
                {Object.entries(PRESSURE_ZONE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
          </>
        )}
        <label className="row">外观
          <select value={appearance} onChange={(e) => setAppearance(e.target.value as AppearanceState)}>
            {Object.entries(APPEARANCE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="row">铅封
          <select value={seal} onChange={(e) => setSeal(e.target.value as SealState)}>
            {Object.entries(SEAL_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="row">备注 <input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <label className="row">照片 <input ref={photoInput} type="file" accept="image/*" capture="environment" /></label>
        <button onClick={submit}>登记巡检</button>
      </div>
    </>
  );
}

/** 维保登记：送检 / 维修 / 换新；费用（材料/人工/运输）；换下配件留配件号 */
function ServiceForm({ floorId, fac }: { floorId: string; fac: Facility }) {
  const [open, setOpen] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [kind, setKind] = useState<ServiceKind>('hydro_test');
  const [hydroResult, setHydroResult] = useState<HydroResult>('pass');
  const [vendor, setVendor] = useState('');
  const [cost, setCost] = useState<Cost>(emptyCost);
  const [parts, setParts] = useState<PartRecord[]>([]);
  const [note, setNote] = useState('');

  const reset = useCallback(() => {
    setDate(today);
    setKind('hydro_test');
    setHydroResult('pass');
    setVendor('');
    setCost(emptyCost);
    setParts([]);
    setNote('');
  }, [today]);

  if (!open) {
    return (
      <div className="stack">
        <button className="ghost" onClick={() => setOpen(true)}>＋ 登记送检 / 维修 / 换新（费用、配件号）</button>
      </div>
    );
  }

  const submit = () => {
    addService(floorId, fac.id, {
      date,
      kind,
      hydroResult: kind === 'hydro_test' ? hydroResult : undefined,
      vendor: vendor || undefined,
      cost,
      parts: parts.filter((p) => p.partNo.trim()).map((p) => ({ ...p, partNo: p.partNo.trim() })),
      note: note || undefined,
    });
    reset();
    setOpen(false);
  };

  const setCostField = (k: keyof Cost, v: string) => setCost((c) => ({ ...c, [k]: v === '' ? 0 : Math.max(0, Number(v)) }));

  return (
    <div className="stack serviceform">
      <h4>维保登记</h4>
      <label className="row">日期 <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <label className="row">类别
        <select value={kind} onChange={(e) => setKind(e.target.value as ServiceKind)}>
          {Object.entries(SERVICE_KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      {kind === 'hydro_test' && (
        <label className="row">试验结论
          <select value={hydroResult} onChange={(e) => setHydroResult(e.target.value as HydroResult)}>
            {Object.entries(HYDRO_RESULT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      )}
      <label className="row">单位 <input value={vendor} placeholder="维修/送检单位" onChange={(e) => setVendor(e.target.value)} /></label>
      <div className="row">
        费用（元）
        <input type="number" min={0} placeholder="材料" title="材料费" value={cost.material || ''} onChange={(e) => setCostField('material', e.target.value)} />
        <input type="number" min={0} placeholder="人工" title="人工费" value={cost.labor || ''} onChange={(e) => setCostField('labor', e.target.value)} />
        <input type="number" min={0} placeholder="运输" title="运输费" value={cost.transport || ''} onChange={(e) => setCostField('transport', e.target.value)} />
        <b className="nowrap">¥{costTotal(cost)}</b>
      </div>
      <div className="stack">
        <span className="hint">换下配件（留配件号）</span>
        {parts.map((p, i) => (
          <div className="row" key={i}>
            <input placeholder="配件号 *" value={p.partNo} onChange={(e) => setParts((ps) => ps.map((x, j) => (j === i ? { ...x, partNo: e.target.value } : x)))} />
            <input placeholder="名称" value={p.name ?? ''} onChange={(e) => setParts((ps) => ps.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            <input type="number" min={1} style={{ maxWidth: 64 }} placeholder="数量" value={p.qty ?? ''} onChange={(e) => setParts((ps) => ps.map((x, j) => (j === i ? { ...x, qty: e.target.value === '' ? undefined : Number(e.target.value) } : x)))} />
            <button className="ghost" onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))}>删</button>
          </div>
        ))}
        <button className="ghost" onClick={() => setParts((ps) => [...ps, { partNo: '', name: '', qty: 1 }])}>＋ 添加配件</button>
      </div>
      <label className="row">备注 <input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <div className="row">
        <button onClick={submit}>保存维保记录</button>
        <button className="ghost" onClick={() => setOpen(false)}>取消</button>
      </div>
    </div>
  );
}

/** 历史时间线：同一具设施的巡检与送检/维修/换新按时间串起来 */
function HistoryTimeline({
  floorId,
  fac,
  photoUrls,
}: {
  floorId: string;
  fac: Facility;
  photoUrls: Record<string, string>;
}) {
  const events = facilityTimeline(fac).slice().reverse(); // 近的在上
  return (
    <>
      <h4>历史记录（{events.length}）</h4>
      <div className="checks">
        {events.map((ev, i) => {
          const realIdx = ev.type === 'check' ? fac.checks.indexOf(ev.check!) : -1;
          return (
            <div key={i} className={`checkrow ev-${ev.type}`}>
              <span className="nowrap">{ev.date}</span>
              <span className={`badge ${ev.type === 'check' ? `st-${ev.check!.status}` : 'st-ok'}`}>
                {ev.type === 'manufacture' ? '出厂' : ev.type === 'retire' ? '退役' : ev.title}
              </span>
              {ev.detail && <span className="hint">{ev.detail}</span>}
              {ev.type === 'check' && photoUrls[`c${realIdx}`] && <img className="thumb" src={photoUrls[`c${realIdx}`]} alt="巡检照片" />}
              {ev.type === 'check' ? (
                <button className="ghost" onClick={() => deleteCheck(floorId, fac.id, realIdx)}>删</button>
              ) : ev.type === 'service' && ev.service ? (
                <button className="ghost" onClick={() => deleteService(floorId, fac.id, ev.service!.id)}>删</button>
              ) : null}
            </div>
          );
        })}
        {!events.length && <p className="hint">暂无记录</p>}
      </div>
    </>
  );
}
