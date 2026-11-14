// A table whose columns the person chooses, as in Stock Portfolio Optimizer: each column header has sort (⇅, ▲, ▼; a
// third press clears it), move left and right (< >), remove (×), and a "−" in its corner that folds the column away
// for now ("+" opens it again). Above the table, a tick for every column chooses which are shown. The choices are kept
// on this device.

import { make } from './ui';

export interface Column<R> {
  id: string;
  label: string;
  /** What the column sorts by; null sorts last. */
  value: (row: R) => number | string | null;
  /** What the cell shows; "--" where there is no value. */
  text: (row: R) => string;
  /** The cell's contents when more than text (for example two devices' values, one above the other). */
  cell?: (row: R) => Node;
}

export interface TableChoices { cols: string[]; sort: { id: string; dir: 'asc' | 'desc' } | null; folded: string[] }

export interface ColTable<R> {
  el: HTMLElement;
  /** The rows to show, and which one is picked (its key). */
  set(rows: readonly R[], picked?: string | null): void;
}

export function colTable<R>(o: {
  columns: readonly Column<R>[];
  defaults: TableChoices;
  storageKey: string;
  rowKey: (row: R) => string;
  /** Rows in their order when no column is sorted. */
  baseOrder: (a: R, b: R) => number;
  onPick?: (row: R) => void;
  empty: string;
}): ColTable<R> {
  const byId = new Map(o.columns.map((c) => [c.id, c]));
  const choices = load();
  let rows: readonly R[] = [], picked: string | null = null;

  const el = make('div', 'coltable');
  const tools = make('div', 'coltable-tools');
  const ticks = make('div', 'trend-ticks');
  const resetBtn = make('button', 'small', 'Reset columns');
  const head = make('div', 'row wrap between');
  head.append(make('span', 'muted', 'Columns shown in the table:'), resetBtn);
  tools.append(head, ticks);
  const wrap = make('div', 'table-container');
  const table = make('table', 'data-table');
  wrap.appendChild(table);
  el.append(tools, wrap);

  resetBtn.addEventListener('click', () => {
    Object.assign(choices, structuredClone(o.defaults));
    save(); render();
  });

  function load(): TableChoices {
    const d = structuredClone(o.defaults);
    try {
      const v = JSON.parse(localStorage.getItem(o.storageKey) ?? 'null') as Partial<TableChoices> | null;
      if (!v) return d;
      const cols = Array.isArray(v.cols) ? v.cols.filter((id) => byId.has(id)) : d.cols;
      const sort = v.sort && byId.has(v.sort.id) && (v.sort.dir === 'asc' || v.sort.dir === 'desc') ? v.sort : v.sort === null ? null : d.sort;
      return { cols, sort, folded: Array.isArray(v.folded) ? v.folded.filter((id) => byId.has(id)) : [] };
    } catch { return d; }
  }
  function save(): void { try { localStorage.setItem(o.storageKey, JSON.stringify(choices)); } catch { /* not kept */ } }

  const ctrl = (text: string, title: string, cls = ''): HTMLButtonElement => {
    const b = make('button', `col-ctrl-btn ${cls}`.trim(), text) as HTMLButtonElement;
    b.type = 'button'; b.title = title; b.setAttribute('aria-label', title);
    return b;
  };

  function sorted(): R[] {
    const s = choices.sort, col = s ? byId.get(s.id) : null;
    const out = [...rows].sort(o.baseOrder);
    if (!s || !col) return out;
    const k = s.dir === 'asc' ? 1 : -1;
    return out.sort((a, b) => {
      const x = col.value(a), y = col.value(b);
      if (x == null || y == null) return x == null && y == null ? 0 : x == null ? 1 : -1; // no value: last either way
      return (x < y ? -1 : x > y ? 1 : 0) * k;
    });
  }

  function render(): void {
    // a tick for every column: ticked ones are shown (a newly ticked one goes at the end)
    ticks.replaceChildren(...o.columns.map((c) => {
      const box = make('input'), l = make('label');
      box.type = 'checkbox';
      box.checked = choices.cols.includes(c.id);
      box.addEventListener('change', () => {
        choices.cols = box.checked ? [...choices.cols, c.id] : choices.cols.filter((x) => x !== c.id);
        if (!box.checked && choices.sort?.id === c.id) choices.sort = null;
        save(); render();
      });
      l.append(box, ` ${c.label}`);
      return l;
    }));

    const cols = choices.cols.map((id) => byId.get(id)!).filter(Boolean);
    const head = make('tr');
    cols.forEach((c, i) => {
      const th = make('th', 'col-collapsible');
      const folded = choices.folded.includes(c.id);
      th.classList.toggle('col-collapsed', folded);
      const fold = make('button', 'col-collapse-btn', folded ? '+' : '−') as HTMLButtonElement;
      fold.type = 'button';
      fold.title = folded ? `Show the "${c.label}" column again` : `Fold the "${c.label}" column away for now`;
      fold.setAttribute('aria-label', fold.title);
      fold.addEventListener('click', (e) => {
        e.stopPropagation();
        choices.folded = folded ? choices.folded.filter((x) => x !== c.id) : [...choices.folded, c.id];
        save(); render();
      });
      const sortOn = choices.sort?.id === c.id;
      const sort = ctrl(sortOn ? (choices.sort!.dir === 'asc' ? '▲' : '▼') : '⇅', 'Sort by this column', sortOn ? 'col-ctrl-sort-active' : '');
      sort.addEventListener('click', () => {
        choices.sort = !sortOn ? { id: c.id, dir: 'asc' } : choices.sort!.dir === 'asc' ? { id: c.id, dir: 'desc' } : null;
        save(); render();
      });
      const left = ctrl('<', 'Move left'), right = ctrl('>', 'Move right');
      left.disabled = i === 0; right.disabled = i === cols.length - 1;
      const move = (d: number): void => {
        const at = choices.cols.indexOf(c.id), to = at + d;
        if (to < 0 || to >= choices.cols.length) return;
        [choices.cols[at], choices.cols[to]] = [choices.cols[to]!, choices.cols[at]!];
        save(); render();
      };
      left.addEventListener('click', () => move(-1));
      right.addEventListener('click', () => move(1));
      const remove = ctrl('×', `Remove the "${c.label}" column (tick it above to show it again)`, 'col-ctrl-remove');
      remove.addEventListener('click', () => {
        choices.cols = choices.cols.filter((x) => x !== c.id);
        if (choices.sort?.id === c.id) choices.sort = null;
        save(); render();
      });
      const controls = make('div', 'col-header-controls');
      controls.append(sort, left, right, remove);
      th.append(make('div', '', c.label), controls, fold);
      head.appendChild(th);
    });
    const body = make('tbody');
    const list = sorted();
    for (const r of list) {
      const tr = make('tr');
      const key = o.rowKey(r);
      if (key === picked) tr.classList.add('picked');
      if (o.onPick) {
        tr.tabIndex = 0;
        tr.addEventListener('click', () => o.onPick!(r));
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') o.onPick!(r); });
      }
      for (const c of cols) {
        const td = make('td');
        td.append(c.cell ? c.cell(r) : c.text(r));
        td.classList.toggle('col-collapsed', choices.folded.includes(c.id));
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    if (!list.length) {
      const tr = make('tr'), td = make('td', 'muted', o.empty);
      td.colSpan = Math.max(1, cols.length);
      tr.appendChild(td);
      body.appendChild(tr);
    }
    const thead = make('thead');
    thead.appendChild(head);
    table.replaceChildren(thead, body);
  }

  render();
  return {
    el,
    set(next, pick = picked) { rows = next; picked = pick ?? null; render(); },
  };
}
