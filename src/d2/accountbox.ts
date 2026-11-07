// SPDX-License-Identifier: AGPL-3.0-or-later
// D2 Link — the "Watch account ID (optional)" box, shared by D2 Link, Synchronised Tracking and Synchronised Sleep Tracking.
// Part of D2 Link (GNU AGPL v3 or later); see index.ts and LICENSE-D2-LINK.txt.

import * as store from './store';
import { button, el } from './dom';

const boxes = new Set<() => void>(); // every page's box shows the same saved ID

/**
 * The watch account ID, hidden like a password: "View" shows it. It is used only to link with the watch:
 * kept on this device, never synced, and left out of reports, PDFs and backups.
 */
export function accountBox(account: string): HTMLDetailsElement {
  store.useAccount(account);
  const box = el('details', 'd2-acct');
  box.appendChild(el('summary', '', 'Watch account ID (optional)'));
  const input = el('input');
  Object.assign(input, { type: 'password', inputMode: 'numeric', autocomplete: 'off', spellcheck: false, placeholder: '17 digits', maxLength: 30 });
  input.setAttribute('aria-label', 'Watch account ID');
  input.setAttribute('data-lpignore', 'true'); // not a password: password managers shouldn't offer to save it
  input.setAttribute('data-1p-ignore', '');
  const view = button('View');
  view.setAttribute('aria-pressed', 'false');
  const hide = (): void => { input.type = 'password'; view.textContent = 'View'; view.setAttribute('aria-pressed', 'false'); };
  view.addEventListener('click', () => {
    if (input.type === 'password') { input.type = 'text'; view.textContent = 'Hide'; view.setAttribute('aria-pressed', 'true'); } else hide();
  });
  const save = button('Save');
  const note = el('p', 'note');
  const row = el('div', 'row wrap');
  row.append(input, view, save);
  box.append(
    el('p', 'note', 'The watch may only share live heartbeats, blood pressure, stress, workouts and measurements with its own account. If you use it with its phone app, enter that account’s ID (a 17-digit number, not a password). One way to find it: sign in to the cloud website of the watch’s phone app in Chrome on a computer, press F12, open Application → Cookies → that website, and copy the value of “userId”.'),
    row, note,
    el('p', 'note', 'It is used only to link with the watch: it stays on this device, isn’t synced to the cloud, and isn’t included in any report, PDF or backup.'),
  );
  const show = (): void => {
    store.useAccount(account);
    const id = store.loadWatchAccount();
    input.value = id;
    hide();
    note.textContent = id ? 'Saved on this device.' : 'Not set: the account step is skipped.';
  };
  save.addEventListener('click', () => {
    const id = input.value.replace(/\s/g, '');
    if (id && !/^\d{5,30}$/.test(id)) { note.textContent = 'The ID is digits only (usually 17).'; return; }
    store.useAccount(account);
    store.saveWatchAccount(id);
    for (const fn of boxes) fn();
  });
  box.addEventListener('toggle', () => { if (!box.open) hide(); });
  boxes.add(show);
  show();
  return box;
}

/** The watch's saved pairing: whether there is one, and forgetting it (the next connection pairs again). */
export const pairing = {
  saved: (account: string): boolean => { store.useAccount(account); return store.loadPairing() != null; },
  forget: (account: string): void => { store.useAccount(account); store.savePairing(null); },
};
