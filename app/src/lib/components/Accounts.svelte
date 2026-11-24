<script lang="ts">
  import { untrack } from 'svelte';
  import { app, conn, errorText, rpc } from '#lib/api.svelte.ts';
  import { copyText, go, route, toast } from '#lib/ui.svelte.ts';
  import { AUTH_LABEL, authOf, outdatedGateway, usageLine } from '#lib/accounts.ts';
  import { USAGE_URL } from '#lib/usage.ts';
  import type { HarnessAccounts } from '#lib/types.ts';
  import BackButton from './BackButton.svelte';
  import Icon from './Icon.svelte';

  let data = $state<HarnessAccounts | null>(null);
  let loadError = $state<string | null>(null);
  let loading = $state(false);

  async function load(refresh = false) {
    loading = true;
    try {
      const r = (await rpc('harnesses.accounts', { refresh })) as HarnessAccounts;
      data = r;
      app.harnesses = r.harnesses;
      loadError = null;
    } catch (e) {
      loadError = errorText(e);
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    if (route.name === 'accounts' && conn.status === 'online' && conn.generation) untrack(() => load());
  });

  // Built-ins first, then custom agents; harnesses that are neither installed nor enabled go last.
  let harnesses = $derived(
    [...(data?.harnesses ?? app.harnesses)].sort((a, b) => Number(a.custom) - Number(b.custom) || Number(!a.installed) - Number(!b.installed))
  );
  const RUN_LABEL: Record<string, string> = { running: 'Running', idle: 'Not running', error: 'Error', unavailable: 'Not installed' };
</script>

<div class="screen">
  <header class="topbar">
    <BackButton to="#/settings" />
    <div class="title"><b>Harness accounts</b></div>
    <button class="iconbtn" onclick={() => load(true)} disabled={loading} aria-label="Check again" title="Check again"><Icon name="refresh" /></button>
  </header>
  <main class="scroller">
    <div class="column">
      <p class="muted intro">Logins are checked with each CLI on the gateway host. Credentials stay there, never on this device.</p>
      {#if outdatedGateway(conn.info, loadError)}<p class="muted detail bad">{outdatedGateway(conn.info, loadError)}</p>
      {:else if loadError}<p class="muted detail bad">{loadError}</p>{/if}

      {#each harnesses as h (h.id)}
        {@const auth = authOf(h)}
        <div class="label">{h.name}</div>
        <div class="card">
          <div class="kv">
            <span>Login</span>
            <b class="status {auth.status}"><span class="dot" class:running={auth.status === 'authenticated'} class:error={auth.status === 'unauthenticated' || auth.status === 'expired' || auth.status === 'error'}></span> {AUTH_LABEL[auth.status]}{auth.method && auth.status !== 'not_installed' ? ` · ${auth.method}` : ''}</b>
          </div>
          {#each auth.account as f}
            <div class="kv"><span>{f.label}</span><b>{f.value}</b></div>
          {/each}
          {#if auth.expiresAt}<div class="kv"><span>Login expires</span><b>{new Date(auth.expiresAt).toLocaleDateString()}</b></div>{/if}
          {#if h.id === 'devin' && data?.devinUsage}
            {#each data.devinUsage.windows as w (w.id)}
              <div class="kv usage">
                <span>{w.label} quota</span>
                <b class:bad={w.remainingPercent <= 10}>{usageLine(w)}</b>
              </div>
              <div class="bar" class:warn={w.remainingPercent <= 20}><i style="width: {Math.max(0, Math.min(100, w.remainingPercent))}%"></i></div>
            {:else}
              <div class="kv"><span>Quota</span><b>Not reported for this plan</b></div>
            {/each}
          {/if}
          <div class="kv"><span>Agent process</span><b class:bad={h.status === 'error'}>{RUN_LABEL[h.status] ?? h.status}{h.version ? ` · ${h.version}` : ''}</b></div>
          {#if auth.detail && auth.status !== 'authenticated'}<p class="muted detail">{auth.detail}</p>{/if}
          {#if h.id === 'devin' && data?.devinUsageError}<p class="muted detail">Quota unavailable: {data.devinUsageError}</p>{/if}
          {#if h.error && h.status === 'error'}<p class="muted detail bad">{h.error}</p>{/if}
          <div class="row2">
            {#if auth.status === 'not_installed' && h.installHint}
              {#if /^https?:\/\//.test(h.installHint!.trim())}
                <button class="btn" onclick={() => copyText(h.installHint!).then(() => toast('Install link copied', 'info'))}>Copy install link</button>
              {:else}
                <button class="btn" onclick={() => go(`#/terminal?install=${encodeURIComponent(h.id)}`)}>Install &amp; setup</button>
              {/if}
            {:else if h.id === 'devin'}
              <button class="btn" onclick={() => go('#/terminal?login')}>{auth.status === 'authenticated' ? 'Log in again' : 'Log in on the VM'}</button>
              <a class="btn" href={USAGE_URL} target="_blank" rel="noreferrer">Usage &amp; limits</a>
            {:else if h.authMethod}
              <button class="btn" onclick={() => copyText(h.authMethod!).then(() => toast(`Copied: ${h.authMethod}`, 'info'))}>Copy login command</button>
              <button class="btn" onclick={() => go('#/terminal')}>Open terminal</button>
            {/if}
          </div>
          {#if h.authMethod && auth.status !== 'authenticated' && auth.status !== 'not_installed' && h.id !== 'devin'}
            <p class="muted detail">Log in by running <span class="mono">{h.authMethod}</span> in the terminal, then check again.</p>
          {/if}
        </div>
      {/each}
    </div>
  </main>
</div>

<style>
  .column {
    max-width: 640px;
    margin-inline: auto;
    padding: 0 calc(var(--safe-right) + 16px) calc(var(--safe-bottom) + 24px) calc(var(--safe-left) + 16px);
  }
  .intro {
    font-size: 13px;
    margin: 4px 0 0;
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
  .kv b.bad,
  .status.unauthenticated,
  .status.expired,
  .status.error {
    color: var(--amber);
  }
  .kv.usage {
    padding-bottom: 6px;
  }
  .bar {
    height: 6px;
    border-radius: 3px;
    background: var(--fill);
    overflow: hidden;
    margin-bottom: 12px;
  }
  .bar i {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .bar.warn i {
    background: var(--amber);
  }
  .detail {
    font-size: 13px;
    line-height: 1.45;
    margin: 0;
    padding: 0 0 14px;
    overflow-wrap: anywhere;
  }
  .detail.bad {
    color: var(--amber);
  }
  .row2 {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 2px 0 14px;
  }
  .row2:empty {
    display: none;
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
</style>
