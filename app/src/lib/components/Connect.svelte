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
  <div class="scroller pairing">
    <form class="wrap" onsubmit={submit}>
      <div class="logo" aria-hidden="true">
        <svg viewBox="0 0 512 512" width="64" height="64"><rect width="512" height="512" rx="112" fill="var(--text)" /><path d="M150 190l90 66-90 66" fill="none" stroke="var(--bg)" stroke-width="40" stroke-linecap="round" stroke-linejoin="round" /><path d="M276 330h90" stroke="#3ecf8e" stroke-width="40" stroke-linecap="round" /></svg>
      </div>
      <h1>Devin Mobile</h1>
      <p class="intro">Connect to the gateway running next to Devin CLI on your VM. Get its token with <code>node dist/index.js --print-token</code>.</p>

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

      <button class="btn primary block connect" type="submit" disabled={conn.status === 'connecting' && !conn.error}>
        {#if conn.status === 'connecting'}<span class="spinner"></span> Connecting…{:else}Connect{/if}
      </button>
      <p class="fine">The token stays on this device. Devin credentials never leave the VM{isTauri ? '' : '; this page is served by the gateway itself'}.</p>
    </form>
  </div>
</div>

<style>
  /* No top bar here: the form is centered and scrolls when the keyboard shrinks the viewport. */
  .pairing {
    display: flex;
    flex-direction: column;
    padding: var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left);
  }
  .wrap {
    margin: auto;
    width: 100%;
    max-width: 420px;
    padding: 32px 24px;
  }
  .logo {
    display: flex;
    margin-bottom: 18px;
  }
  .logo svg {
    border-radius: 14px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18), 0 0 0 1px var(--line);
  }
  h1 {
    font-size: 28px;
    font-weight: 700;
    line-height: 1.2;
    letter-spacing: -0.02em;
    margin: 0 0 8px;
  }
  .intro {
    margin: 0 0 26px;
    font-size: 15px;
    color: var(--text-2);
    text-wrap: pretty;
  }
  code {
    font: 0.86em var(--mono);
    color: var(--text);
    background: var(--fill-2);
    padding: 1px 6px;
    border-radius: 6px;
  }
  .err {
    color: var(--red);
    font-size: 14px;
    margin: -2px 4px 14px;
  }
  .connect {
    margin-top: 8px;
  }
  .connect .spinner {
    border-color: color-mix(in srgb, var(--on-accent) 30%, transparent);
    border-top-color: var(--on-accent);
  }
  .fine {
    font-size: 12.5px;
    color: var(--text-3);
    margin: 16px 8px 0;
    text-align: center;
    text-wrap: pretty;
  }
</style>
