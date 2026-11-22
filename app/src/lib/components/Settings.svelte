<script lang="ts">
  import { conn, forgetConnection, rpc } from '#lib/api.svelte.ts';
  import { go, prefs, setTheme, setAccent, THEMES, ACCENTS, toast } from '#lib/ui.svelte.ts';
  import Icon from './Icon.svelte';
  import { USAGE_URL } from '#lib/usage.ts';
  import type { Json } from '#lib/types.ts';

  let checking = $state(false);
  const canNotify = typeof Notification !== 'undefined';
  let notifications = $state(canNotify ? Notification.permission : 'denied');

  async function enableNotifications() {
    notifications = await Notification.requestPermission();
    toast(notifications === 'granted' ? 'Notifications enabled' : 'Notifications are blocked for this app', notifications === 'granted' ? 'info' : 'error');
  }
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
      toast('Link copied');
    } catch {
      toast(USAGE_URL);
    }
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
    <button class="iconbtn" onclick={() => go('#/')} aria-label="Back"><Icon name="back" /></button>
    <div class="title"><b>Settings</b></div>
  </header>
  <main>
    <div class="label">Appearance</div>
    <div class="seg3">
      {#each THEMES as t}
        <button class:on={prefs.theme === t} onclick={() => setTheme(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
      {/each}
    </div>
    <div class="label">Accent</div>
    <div class="accents">
      {#each ACCENTS as a}
        <button class="swatch" class:on={prefs.accent === a.id} style:--sw={a.color} onclick={() => setAccent(a.id)} aria-label={a.id} title={a.id}></button>
      {/each}
    </div>

    {#if canNotify}
      <div class="label">Notifications</div>
      <div class="card">
        <div class="kv">
          <span>Approvals and finished work</span>
          {#if notifications === 'granted'}<b>On</b>{:else}<button class="btn turnon" onclick={enableNotifications}>Turn on</button>{/if}
        </div>
        <p class="muted detail">Sent while the app is in the background and still connected.</p>
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

    <button class="btn block danger" onclick={() => (forgetConnection(), go('#/'))}>Disconnect and forget this server</button>
  </main>
</div>

<style>
  .turnon {
    min-height: 32px;
    padding: 0 12px;
    font-size: 14px;
  }
  main {
    flex: 1;
    overflow-y: auto;
    padding: 6px 16px calc(var(--safe-bottom) + 24px);
  }
  .label {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-3);
    margin: 16px 2px 6px;
  }
  .accents {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    padding: 12px 14px;
    border-radius: 12px;
    background: var(--bg-elev);
    border: 1px solid var(--line);
  }
  .swatch {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--sw);
    box-shadow: 0 0 0 2px var(--bg-elev), 0 0 0 2px transparent;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }
  .swatch.on {
    box-shadow: 0 0 0 2px var(--bg-elev), 0 0 0 4px var(--sw);
    transform: scale(1.06);
  }
  .seg3 {
    display: flex;
    gap: 4px;
    padding: 4px;
    border-radius: 12px;
    background: var(--bg-elev);
    border: 1px solid var(--line);
  }
  .seg3 button {
    flex: 1;
    min-height: 36px;
    border-radius: 9px;
    font-size: 14px;
    color: var(--text-2);
  }
  .seg3 button.on {
    background: var(--bg-elev2);
    color: var(--text);
    font-weight: 600;
  }
  .card {
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--bg-elev);
    padding: 4px 14px 12px;
    margin-bottom: 8px;
  }
  .kv {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    padding: 9px 0;
    border-bottom: 1px solid var(--line);
    font-size: 14.5px;
  }
  .kv span {
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
  }
  .kv b.bad {
    color: var(--amber);
  }
  .detail {
    font-size: 12.5px;
    margin: 8px 0 0;
    overflow-wrap: anywhere;
  }
  .row2 {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }
  .row2 .btn {
    flex: 1;
    font-size: 14px;
    white-space: nowrap;
  }
  a.btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    text-decoration: none;
    color: inherit;
  }
  .btn.block {
    margin-top: 18px;
  }
</style>
