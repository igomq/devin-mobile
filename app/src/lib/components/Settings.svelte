<script lang="ts">
  import { conn, forgetConnection, rpc } from '#lib/api.svelte.ts';
  import { go, toast } from '#lib/ui.svelte.ts';
  import BackButton from './BackButton.svelte';
  import ThemePicker from './ThemePicker.svelte';
  import { USAGE_URL } from '#lib/usage.ts';
  import type { Json, NotificationEventType, NotificationPrefs } from '#lib/types.ts';
  import { notif, EVENT_LABELS, savePrefs, sendTest, enablePush, disablePush, enableSystemNotifications, pushUnavailableReason } from '#lib/notifications.svelte.ts';

  let checking = $state(false);
  let testing = $state(false);
  async function testNotification() {
    testing = true;
    try {
      const r = await sendTest();
      if (!r.delivered) toast(r.reason, 'error');
      else toast(r.push?.sent ? `Test sent (also pushed to ${r.push.sent} device${r.push.sent === 1 ? '' : 's'})` : 'Test sent', 'info');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      testing = false;
    }
  }
  async function toggle(patch: Partial<NotificationPrefs>) {
    try {
      await savePrefs(patch);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  }
  const CAP_LABEL: Record<string, string> = { available: 'Available', requires_secure_context: 'Needs HTTPS', requires_external_setup: 'Needs external setup', blocked_by_signing: 'Blocked by signing' };
  const PLATFORMS = [
    ['inApp', 'In-app'],
    ['webPush', 'Web Push (browser / PWA)'],
    ['androidFcm', 'Android native (FCM)'],
    ['iosApns', 'iOS native (APNs)']
  ] as const;

  let agent = $derived(conn.info?.agent ?? null);

  let account = $state<{ loggedIn: boolean; fields: { label: string; value: string }[] } | null>(null);
  let accountError = $state<string | null>(null);
  let loadingAccount = $state(false);
  async function loadAccount(refresh = false) {
    loadingAccount = true;
    try {
      account = (await rpc('agent.account', { refresh })) as Json;
      accountError = null;
    } catch (e) {
      accountError = String((e as Error)?.message ?? e);
    }
    loadingAccount = false;
  }
  $effect(() => {
    if (conn.status === 'online' && !account && !loadingAccount && !accountError) loadAccount();
  });
  async function copyUsageLink() {
    try {
      await navigator.clipboard.writeText(USAGE_URL);
    } catch {
      // The Clipboard API needs a secure context; a plain-HTTP Tailscale address is not one.
      const t = document.createElement('textarea');
      t.value = USAGE_URL;
      t.setAttribute('readonly', '');
      t.style.position = 'fixed';
      t.style.opacity = '0';
      document.body.appendChild(t);
      t.select();
      const ok = document.execCommand('copy');
      t.remove();
      if (!ok) return toast(USAGE_URL);
    }
    toast('Link copied');
  }

  async function recheck() {
    checking = true;
    try {
      const a = await rpc('agent.status');
      if (conn.info) conn.info.agent = a;
    } catch {}
    checking = false;
  }
  $effect(() => {
    if (conn.status === 'online') recheck();
  });
</script>

<div class="screen">
  <header class="topbar">
    <BackButton to="#/" />
    <div class="title"><b>Settings</b></div>
  </header>
  <main class="scroller">
    <div class="column">
      <ThemePicker />

      <div class="label">Notifications</div>
      <div class="card notif">
        {#if notif.prefs}
          {@const p = notif.prefs}
          <label class="kv"><span>Notifications</span><input type="checkbox" checked={p.enabled} onchange={(e) => toggle({ enabled: e.currentTarget.checked })} /></label>
          <label class="kv"><span>In-app banners</span><input type="checkbox" checked={p.inApp} disabled={!p.enabled} onchange={(e) => toggle({ inApp: e.currentTarget.checked })} /></label>
          <label class="kv"><span>Hide details on lock screen</span><input type="checkbox" checked={p.hideSensitiveDetails} onchange={(e) => toggle({ hideSensitiveDetails: e.currentTarget.checked })} /></label>
          <p class="muted detail">When on, push and system notifications only say what kind of event happened. Tokens and passwords are always removed.</p>
          <div class="kv">
            <span>Web Push on this device</span>
            {#if notif.push.state === 'on'}
              <button class="btn turnon" disabled={notif.push.busy} onclick={disablePush}>Turn off</button>
            {:else if notif.push.state === 'off'}
              <button class="btn turnon" disabled={notif.push.busy || !p.enabled} onclick={enablePush}>Turn on</button>
            {:else}
              <b class="bad">Unavailable</b>
            {/if}
          </div>
          {#if pushUnavailableReason()}<p class="muted detail">{pushUnavailableReason()}</p>{/if}
          {#if notif.push.error}<p class="muted detail bad">{notif.push.error}</p>{/if}
          {#if notif.push.state !== 'on' && notif.permission !== 'granted' && typeof Notification !== 'undefined'}
            <div class="kv"><span>Background alerts while connected</span><button class="btn turnon" onclick={enableSystemNotifications}>Allow</button></div>
          {/if}
          <div class="sublabel">Notify me about</div>
          {#each Object.keys(EVENT_LABELS) as NotificationEventType[] as e}
            <label class="kv"><span>{EVENT_LABELS[e]}</span><input type="checkbox" checked={p.events[e]} disabled={!p.enabled} onchange={(ev) => toggle({ events: { ...p.events, [e]: ev.currentTarget.checked } })} /></label>
          {/each}
          <div class="row2"><button class="btn" onclick={testNotification} disabled={testing || !p.enabled}>Send test notification</button></div>
        {:else}
          <p class="muted detail">Connect to a gateway to manage notifications.</p>
        {/if}
      </div>

      {#if notif.capabilities}
        <div class="label">Notification support</div>
        <div class="card">
          {#each PLATFORMS as [key, name]}
            {@const c = notif.capabilities[key]}
            <div class="kv"><span>{name}</span><b class:bad={c.status !== 'available'}>{CAP_LABEL[c.status] ?? c.status}</b></div>
            <p class="muted detail">{c.detail}</p>
          {/each}
        </div>
      {/if}

      <div class="label">Server</div>
      <div class="card">
        <div class="kv"><span>Status</span><b><span class="dot" class:running={conn.status === 'online'} class:error={conn.status !== 'online'}></span> {conn.status === 'online' ? 'Connected' : 'Reconnecting…'}</b></div>
        <div class="kv"><span>Address</span><b class="mono">{conn.url}</b></div>
        <div class="kv"><span>Host</span><b>{conn.info?.host}</b></div>
        <div class="kv"><span>Gateway</span><b>{conn.info?.version}</b></div>
        <div class="kv"><span>Agent</span><b>{agent?.agentInfo?.title ?? agent?.agentInfo?.name ?? 'Devin'} {agent?.agentInfo?.version ?? ''}</b></div>
      </div>

      <div class="label">Devin CLI</div>
      <div class="card">
        <div class="kv">
          <span>Agent process</span>
          <b class:bad={agent && !agent.running}>{!agent ? 'Checking…' : agent.running ? 'Running' : 'Not running'}</b>
        </div>
        {#if agent?.error}<p class="muted detail">{agent.error}</p>{/if}
        <div class="row2">
          <button class="btn" onclick={() => go('#/terminal?login')}>Log in on the VM</button>
          <button class="btn" onclick={recheck} disabled={checking}>Re-check</button>
        </div>
        <p class="muted detail">Login runs <span class="mono">devin auth login</span> in a terminal on the VM. Credentials are stored there, never on this phone.</p>
      </div>

      <div class="label">Devin account</div>
      <div class="card">
        {#if account?.loggedIn}
          {#each account.fields as f}
            <div class="kv"><span>{f.label}</span><b>{f.value}</b></div>
          {/each}
        {:else if account}
          <div class="kv"><span>Status</span><b class="bad">Not logged in</b></div>
        {:else}
          <div class="kv"><span>Status</span><b class:bad={!!accountError}>{accountError ? 'Unavailable' : 'Checking…'}</b></div>
        {/if}
        {#if accountError}<p class="muted detail">{accountError}</p>{/if}
        <p class="muted detail">Devin CLI doesn't report remaining quota or credits. Check them, and when they reset, under Usage &amp; limits on app.devin.ai. Per-session token and context use is in each session's controls.</p>
        <div class="row2">
          <a class="btn" href={USAGE_URL} target="_blank" rel="noreferrer">Usage &amp; limits</a>
          <button class="btn" onclick={copyUsageLink}>Copy link</button>
          <button class="btn" onclick={() => loadAccount(true)} disabled={loadingAccount}>Refresh</button>
        </div>
      </div>

      <button class="btn block danger disconnect" onclick={() => (forgetConnection(), go('#/'))}>Disconnect and forget this server</button>
    </div>
  </main>
</div>

<style>
  .notif input[type='checkbox'] {
    width: 20px;
    height: 20px;
    accent-color: var(--accent-solid, #4c8dff);
  }
  .notif label.kv {
    cursor: pointer;
  }
  .sublabel {
    margin: 12px 0 4px;
    font-size: 0.8em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }
  .column {
    max-width: 640px;
    margin-inline: auto;
    padding: 0 calc(var(--safe-right) + 16px) calc(var(--safe-bottom) + 24px) calc(var(--safe-left) + 16px);
  }
  .card {
    padding: 0 16px;
  }
  .kv {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 48px;
    padding: 12px 0;
    font-size: 15px;
  }
  .kv + .kv {
    border-top: 1px solid var(--line);
  }
  .kv > span {
    color: var(--text-2);
    flex: none;
  }
  .kv b {
    font-weight: 500;
    text-align: right;
    overflow-wrap: anywhere;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .kv b.bad {
    color: var(--amber);
  }
  .detail {
    font-size: 13px;
    line-height: 1.45;
    margin: 0;
    padding: 0 0 14px;
    overflow-wrap: anywhere;
  }
  .row2 {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 2px 0 14px;
  }
  .row2 .btn {
    flex: 1;
    min-height: 42px;
    padding: 0 14px;
    font-size: 14px;
    white-space: nowrap;
  }
  .card .btn {
    background: var(--fill);
  }
  .turnon {
    flex: none;
    min-height: 34px;
    padding: 0 14px;
    font-size: 14px;
  }
  .disconnect {
    margin-top: 28px;
    background: var(--fill);
  }
</style>
