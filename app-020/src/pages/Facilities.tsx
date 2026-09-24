import { useState } from 'react';
import { useStore } from '../store/store';
import { TodosTab } from './maintenance/TodosTab';
import { LedgerTab } from './maintenance/LedgerTab';
import { CostTab } from './maintenance/CostTab';
import { ReconcileTab } from './maintenance/ReconcileTab';

function download(name: string, content: string, mime = 'text/csv') {
  const blob = new Blob([`﻿${content}`], { type: `${mime};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

type Tab = 'todos' | 'ledger' | 'cost' | 'reconcile';

const TABS: { key: Tab; label: string }[] = [
  { key: 'todos', label: '待办（送检/换新）' },
  { key: 'ledger', label: '设施台账与历史' },
  { key: 'cost', label: '费用汇总' },
  { key: 'reconcile', label: '账实对账' },
];

/** 消防设施维保账：一本账管巡检、送检/换新、费用与账实核对 */
export function FacilitiesPage() {
  const buildings = useStore((s) => s.buildings);
  const floors = useStore((s) => s.floors);
  const [tab, setTab] = useState<Tab>('todos');

  return (
    <div className="page wide">
      <h2>消防设施维保账</h2>
      <div className="ruletabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'todos' && <TodosTab buildings={buildings} floors={floors} />}
      {tab === 'ledger' && <LedgerTab buildings={buildings} floors={floors} />}
      {tab === 'cost' && <CostTab buildings={buildings} floors={floors} />}
      {tab === 'reconcile' && <ReconcileTab buildings={buildings} floors={floors} />}
    </div>
  );
}

export { download };
