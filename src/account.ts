// Supabase sign-in and the signed-in account. The session is kept in localStorage, so you stay signed in
// on a device until you sign out. The publishable key is meant to be public; the access rules in
// supabase/setup.sql make sure each account only reaches its own data.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { CloudSync } from './cloud';
import * as store from './store';

export const SUPABASE_URL = 'https://legllfdwjfttagxmclio.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_8JGf4CMSxY9f0NWKqm01Cw_EgYdsog9';

/** The last account signed in on this device, so the app can still open without internet. */
const LAST_ACCOUNT_KEY = 'ecg-analysis-last-account';

export interface Account { id: string; email: string; offline: boolean }

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  client ??= createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'openbeat-auth' },
  });
  return client;
}

/** The signed-in account and its cloud sync, once the app has started. */
export const current: { account: Account | null; cloud: CloudSync | null } = { account: null, cloud: null };

export function rememberAccount(a: Pick<Account, 'id' | 'email'>): void {
  try { localStorage.setItem(LAST_ACCOUNT_KEY, JSON.stringify({ id: a.id, email: a.email })); } catch { /* private mode */ }
}

export function lastAccount(): Pick<Account, 'id' | 'email'> | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(LAST_ACCOUNT_KEY) ?? 'null');
    if (typeof v !== 'object' || v === null) return null;
    const r = v as Record<string, unknown>;
    return typeof r['id'] === 'string' && typeof r['email'] === 'string' ? { id: r['id'], email: r['email'] } : null;
  } catch {
    return null;
  }
}

/** Switches the app's storage to this account and starts its cloud sync (unless offline). */
export function startAccount(a: Account): void {
  store.useAccount(a.id);
  current.account = a;
  current.cloud = a.offline ? null : new CloudSync(supabase());
  if (!a.offline) rememberAccount(a);
}

/** ECG or sleep history changed on this device: sync it shortly. */
export function historyChanged(): void {
  current.cloud?.syncSoon();
}

export async function signOut(): Promise<void> {
  // finish any pending upload first, while still signed in
  try { await current.cloud?.sync(); } catch { /* offline: it syncs next time */ }
  try { await supabase().auth.signOut({ scope: 'local' }); } catch { /* offline: the local session is still cleared */ }
  try { localStorage.removeItem(LAST_ACCOUNT_KEY); } catch { /* private mode */ }
  location.reload();
}
