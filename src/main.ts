// Entry point: sign in first (or reuse the saved session), then start the app for that account.

import { supabase, startAccount, lastAccount, current, signOut, type Account } from './account';
import { $, $button, $input, byId } from './ui';
import { errorMessage } from './util';
import { versionText } from './version';
import { applyLayout, applyTheme, initTopbar, loadLayout, loadTheme } from './topbar';
import * as store from './store';

const isNetworkError = (msg: string): boolean => /failed to fetch|network|load failed|fetch failed/i.test(msg);

function friendly(msg: string): string {
  if (isNetworkError(msg)) return 'Cannot reach the sign-in service. Check your internet connection and try again.';
  if (/invalid login credentials/i.test(msg)) return 'Email or password is incorrect.';
  if (/email not confirmed/i.test(msg)) return 'This project still requires email confirmation. Turn off “Confirm email” in Supabase (Authentication → Sign In / Providers → Email).';
  if (/already registered|already exists/i.test(msg)) return 'An account with this email already exists. Sign in instead.';
  return msg || 'Sign-in failed. Please try again.';
}

function showStep(id: 'authChecking' | 'loginStep' | 'registerStep'): void {
  for (const el of document.querySelectorAll('.auth-step')) el.classList.toggle('active', el.id === id);
  for (const el of document.querySelectorAll('.auth-message')) { el.textContent = ''; el.className = 'auth-message'; }
}

function message(id: string, text: string, type: '' | 'error' = ''): void {
  const el = $(id);
  el.textContent = text;
  el.className = `auth-message ${type}`;
}

/** Adds a Show/Hide button to a password field. */
function passwordToggle(input: HTMLInputElement): void {
  const wrap = document.createElement('span');
  wrap.className = 'pw-wrap';
  input.replaceWith(wrap);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pw-toggle';
  btn.textContent = 'Show';
  btn.setAttribute('aria-label', 'Show password');
  btn.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Hide' : 'Show';
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
  wrap.append(input, btn);
}

/** The saved session's account, the offline fallback, or null when someone has to sign in. */
async function existingAccount(): Promise<Account | null> {
  try {
    const { data, error } = await supabase().auth.getSession();
    if (error) throw new Error(error.message);
    const user = data.session?.user;
    if (user) return { id: user.id, email: user.email ?? '', offline: false };
    return null;
  } catch (err) {
    // no internet: open the account last signed in on this device; syncing waits until it's back
    const last = lastAccount();
    if (last && isNetworkError(errorMessage(err))) return { ...last, offline: true };
    message('loginMessage', friendly(errorMessage(err)), 'error');
    return null;
  }
}

function waitForSignIn(): Promise<Account> {
  showStep('loginStep');
  return new Promise((resolve) => {
    const run = (form: HTMLFormElement, messageId: string, action: () => Promise<Account>): void => {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
        if (button?.disabled) return;
        if (button) button.disabled = true;
        message(messageId, 'Please wait…');
        action().then(resolve, (err: unknown) => message(messageId, friendly(errorMessage(err)), 'error'))
          .finally(() => { if (button) button.disabled = false; });
      });
    };
    run(byId('loginForm', HTMLFormElement), 'loginMessage', async () => {
      const email = $input('loginEmail').value.trim().toLowerCase();
      const { data, error } = await supabase().auth.signInWithPassword({ email, password: $input('loginPassword').value });
      if (error) throw new Error(error.message);
      if (!data.session) throw new Error('Sign-in did not return a session. Please try again.');
      return { id: data.user.id, email: data.user.email ?? email, offline: false };
    });
    run(byId('registerForm', HTMLFormElement), 'registerMessage', async () => {
      const email = $input('registerEmail').value.trim().toLowerCase();
      const password = $input('registerPassword').value;
      if (password !== $input('registerPassword2').value) throw new Error('Passwords do not match.');
      if (password.length < 8) throw new Error('Password must contain at least 8 characters.');
      const { data, error } = await supabase().auth.signUp({ email, password });
      if (error) throw new Error(error.message);
      if (!data.session || !data.user) throw new Error('email not confirmed'); // project still asks for confirmation
      return { id: data.user.id, email: data.user.email ?? email, offline: false };
    });
  });
}

/** The sync status in the top bar: a short line with a coloured dot, and the full message on hover (e.g. why it failed). */
function showSyncStatus(): void {
  const a = current.account, c = current.cloud;
  if (!a) return;
  const show = (text: string, state: 'ok' | 'busy' | 'off' | 'fail', full = text): void => {
    $('topSync').textContent = text;
    $('topSync').title = full;
    $('topSyncDot').className = `nav-sync-dot ${state}`;
  };
  if (a.offline || !c) { show('Offline', 'off', 'Offline: your history will sync when you’re back online and reopen the app.'); return; }
  const r = c.lastResult;
  if (!r) { show('Syncing…', 'busy'); return; }
  if (!r.ok) { show('Sync failed', 'fail', `Sync failed: ${r.reason ?? 'unknown error'}.`); return; }
  const parts = [r.uploaded && `${r.uploaded} uploaded`, r.downloaded && `${r.downloaded} downloaded`, r.deleted && `${r.deleted} removed`].filter(Boolean);
  const at = new Date(c.lastSyncAt ?? Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  show(`Synced ${at}`, 'ok', `Synced at ${at}${parts.length ? ` (${parts.join(', ')})` : ''}.`);
}

/** Account menu → "Reset my account data": the cloud copy first (so a failure leaves everything as it was), then this device. */
async function resetAccount(account: Account): Promise<void> {
  if (account.offline) throw new Error('you are offline: the cloud copy can’t be reached, so nothing was deleted');
  const db = supabase();
  for (const table of ['ecg_sessions', 'sleep_nights', 'd2_nights', 'user_data']) {
    const { error } = await db.from(table).delete().not('id', 'is', null); // the access rules limit this to this account's rows
    if (error && !/does not exist|could not find the table/i.test(error.message)) throw new Error(error.message);
  }
  await store.wipeAccountData(account.id);
}

async function boot(): Promise<void> {
  // the theme and layout chosen in the Account menu, before anything is shown
  applyTheme(loadTheme());
  applyLayout(loadLayout());
  $('appVersion').textContent = ` · Version ${versionText()}`;
  for (const id of ['loginPassword', 'registerPassword', 'registerPassword2']) passwordToggle($input(id));
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-show-step]')) {
    btn.addEventListener('click', () => { const step = btn.dataset['showStep']; if (step === 'loginStep' || step === 'registerStep') showStep(step); });
  }
  showStep('authChecking');
  const account = (await existingAccount()) ?? (await waitForSignIn());
  for (const el of document.querySelectorAll<HTMLInputElement>('input[type="password"], input[type="text"].pw')) el.value = '';
  startAccount(account);

  $('authOverlay').hidden = true;
  $('appShell').hidden = false;
  $('navVersion').textContent = `Version ${versionText()}`;
  await import('./app'); // the app reads this account's storage, so it starts only now

  initTopbar({ email: account.email, user: () => store.loadCurrentUser(), signOut: () => void signOut(), reset: () => resetAccount(account) });
  const sync = current.cloud;
  const syncNow = (): void => { $('topSync').textContent = 'Syncing…'; void sync?.sync(); };
  $button('btnTopSync').disabled = !sync;
  $button('btnTopSync').addEventListener('click', syncNow);
  sync?.addEventListener('synced', showSyncStatus);
  showSyncStatus();
  void sync?.sync();
  // signed out elsewhere (e.g. the session was revoked): back to the sign-in screen
  supabase().auth.onAuthStateChange((event) => {
    if (event !== 'SIGNED_OUT' || account.offline) return;
    // a sign-in that lapses overnight mustn't end a recording: the page reloads once it has stopped
    if (store.sleepRecording()) window.addEventListener('openbeat-sleep-stopped', () => location.reload(), { once: true });
    else location.reload();
  });
}

void boot();
