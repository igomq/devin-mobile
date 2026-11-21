<script lang="ts">
  import { conn, saveConnection, isTauri } from '#lib/api.svelte.ts';
  let url = $state(conn.url || '');
  let token = $state(conn.token || '');

  function submit(e: SubmitEvent) {
    e.preventDefault();
    let u = url.trim();
    let t = token.trim();
    // Accept the whole pairing link in either field.
    const pairing = /^((?:https?|wss?):\/\/[^#\s]+?)\/?#token=([^&\s]+)/;
    const link = pairing.exec(u) || pairing.exec(t);
    if (link) {
      u = link[1];
      t = decodeURIComponent(link[2]);
    }
    if (!u || !t) return;
    saveConnection(u, t);
  }
</script>

<div class="screen">
  <form class="wrap" onsubmit={submit}>
    <div class="logo" aria-hidden="true">
      <svg viewBox="0 0 512 512" width="56" height="56"><rect width="512" height="512" rx="112" fill="var(--text)" /><path d="M150 190l90 66-90 66" fill="none" stroke="var(--bg)" stroke-width="40" stroke-linecap="round" stroke-linejoin="round" /><path d="M276 330h90" stroke="#3ecf8e" stroke-width="40" stroke-linecap="round" /></svg>
    </div>
    <h1>Devin Mobile</h1>
    <p class="muted">Connect to the gateway running next to Devin CLI on your VM. Get its token with <code>node dist/index.js --print-token</code>.</p>

    <label class="field">
      <span>Gateway address</span>
      <input bind:value={url} placeholder="100.x.y.z:8787" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="url" />
    </label>
    <label class="field">
      <span>Access token</span>
      <input bind:value={token} type="password" placeholder="Token from the VM" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off" />
    </label>

    {#if conn.status === 'unauthorized'}
      <p class="err">{conn.error || 'The server rejected this token.'}</p>
    {:else if conn.error && conn.status !== 'online'}
      <p class="err">{conn.error} Check that Tailscale is connected on this phone.</p>
    {/if}

    <button class="btn primary block" type="submit" disabled={conn.status === 'connecting' && !conn.error}>
      {#if conn.status === 'connecting'}<span class="spinner"></span> Connecting…{:else}Connect{/if}
    </button>
    <p class="fine muted">The token stays on this device. Devin credentials never leave the VM{isTauri ? '' : '; this page is served by the gateway itself'}.</p>
  </form>
</div>

<style>
  .wrap {
    margin: auto;
    width: 100%;
    max-width: 420px;
    padding: calc(var(--safe-top) + 24px) 22px calc(var(--safe-bottom) + 24px);
    overflow-y: auto;
  }
  .logo {
    margin-bottom: 14px;
  }
  h1 {
    font-size: 26px;
    margin: 0 0 6px;
    letter-spacing: -0.02em;
  }
  p {
    margin: 0 0 22px;
    font-size: 15px;
  }
  code {
    font: 0.88em var(--mono);
    background: var(--bg-elev2);
    padding: 1px 5px;
    border-radius: 5px;
  }
  .err {
    color: var(--red);
    font-size: 14px;
    margin: -2px 0 14px;
  }
  .fine {
    font-size: 12.5px;
    margin: 14px 0 0;
    text-align: center;
  }
</style>
