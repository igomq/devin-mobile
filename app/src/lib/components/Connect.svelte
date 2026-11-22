<script lang="ts">
  import { conn, saveConnection, pairWithCode, isTauri } from '#lib/api.svelte.ts';
  import { isCompleteCode, normalizeCode, pageOrigin, parsePairingInput } from '#lib/pairing.ts';
  import Sheet from './Sheet.svelte';
  import QrScanner from './QrScanner.svelte';
  import Icon from './Icon.svelte';

  // The web app served by the gateway already knows the gateway's address.
  const servedByGateway = !isTauri && /^https?:$/.test(location.protocol) && location.port !== '5173';

  let mode = $state<'pair' | 'token'>('pair');
  let url = $state(conn.url || (servedByGateway ? pageOrigin() : ''));
  let code = $state('');
  let token = $state(conn.token || '');
  let scanning = $state(false);
  let localError = $state<string | null>(null);

  const looksLikeLink = (v: string) => /:\/\/|[#&?]pair=|[#&]token=/i.test(v);

  /** Fills the form from a pasted or scanned link. Returns what it found. */
  function applyLink(text: string) {
    const found = parsePairingInput(text);
    if (found.url) url = found.url;
    if (found.code) {
      code = found.code;
      mode = 'pair';
    } else if (found.token) {
      token = found.token;
      mode = 'token';
    }
    return found;
  }

  function onUrlInput(e: Event & { currentTarget: HTMLInputElement }) {
    const v = e.currentTarget.value;
    localError = null;
    if (looksLikeLink(v) && /[#&?](pair|token)=/i.test(v)) {
      applyLink(v);
      e.currentTarget.value = url;
    } else url = v;
  }

  function onCodeInput(e: Event & { currentTarget: HTMLInputElement }) {
    const v = e.currentTarget.value;
    localError = null;
    if (looksLikeLink(v)) applyLink(v);
    else code = normalizeCode(v);
    e.currentTarget.value = code;
  }

  function onTokenInput(e: Event & { currentTarget: HTMLInputElement }) {
    const v = e.currentTarget.value;
    localError = null;
    // Accept the whole legacy `#token=` link in the token field too.
    if (/[#&]token=/.test(v)) {
      applyLink(v);
      e.currentTarget.value = token;
    } else token = v;
  }

  async function pair(e?: SubmitEvent) {
    e?.preventDefault();
    localError = null;
    const u = url.trim();
    if (!u) return (localError = 'Enter the gateway address.');
    if (!isCompleteCode(code)) return (localError = 'Enter the 8-character pairing code, like ABCD-EFGH.');
    await pairWithCode(u, code);
  }

  function useToken(e: SubmitEvent) {
    e.preventDefault();
    localError = null;
    let u = url.trim();
    let t = token.trim();
    for (const v of [u, t]) {
      if (/[#&]token=/.test(v)) {
        const found = parsePairingInput(v);
        if (found.url) u = found.url;
        if (found.token) t = found.token;
      }
    }
    if (!u || !t) return (localError = 'Enter the gateway address and access token.');
    saveConnection(u, t);
  }

  function scanned(text: string): boolean {
    const found = parsePairingInput(text);
    if (!found.code && !found.token) return false;
    scanning = false;
    applyLink(text);
    if (found.code) {
      if (url.trim()) pair();
      else localError = 'Enter the gateway address, then tap Pair this device.';
    } else if (found.token && url.trim()) saveConnection(url, found.token);
    return true;
  }

  function switchMode(next: 'pair' | 'token') {
    mode = next;
    localError = null;
  }

  let busy = $derived(conn.pairing || (conn.status === 'connecting' && !conn.error));
  let shownError = $derived.by(() => {
    if (localError) return localError;
    if (conn.pairing) return null;
    if (conn.status === 'unauthorized') return conn.error || 'The gateway rejected this token.';
    if (conn.error && conn.status !== 'online') return conn.error === 'Cannot reach the server.' ? `${conn.error} Check that Tailscale is connected on this device.` : conn.error;
    return null;
  });
</script>

<div class="screen">
  <div class="scroller pairing">
    <div class="wrap">
      <div class="logo" aria-hidden="true">
        <svg viewBox="0 0 512 512" width="64" height="64"><rect width="512" height="512" rx="112" fill="var(--text)" /><path d="M150 190l90 66-90 66" fill="none" stroke="var(--bg)" stroke-width="40" stroke-linecap="round" stroke-linejoin="round" /><path d="M276 330h90" stroke="var(--green)" stroke-width="40" stroke-linecap="round" /></svg>
      </div>
      <h1>uniharn</h1>

      {#if mode === 'pair'}
        <ol class="steps">
          <li>On your VM run <code>uniharn pair</code>.</li>
          <li>Scan its QR code, or enter the address and code below.</li>
        </ol>

        <button class="btn block scan" type="button" onclick={() => ((localError = null), (scanning = true))} disabled={busy}>
          <Icon name="qr" size={20} /> Scan QR code
        </button>

        <form onsubmit={pair}>
          <label class="field">
            <span>Gateway address</span>
            <input value={url} oninput={onUrlInput} placeholder="my-vm.tailnet.ts.net or 100.x.y.z" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="url" autocomplete="url" />
          </label>
          <label class="field">
            <span>Pairing code</span>
            <input class="code" value={code} oninput={onCodeInput} placeholder="ABCD-EFGH" autocapitalize="characters" autocorrect="off" spellcheck="false" autocomplete="one-time-code" enterkeyhint="go" />
          </label>

          {#if shownError}<p class="err" role="alert">{shownError}</p>{/if}

          <button class="btn primary block go" type="submit" disabled={busy}>
            {#if conn.pairing}<span class="spinner"></span> Pairing…{:else if busy}<span class="spinner"></span> Connecting…{:else}Pair this device{/if}
          </button>
        </form>
        <button class="link" type="button" onclick={() => switchMode('token')}>Use an access token instead</button>
        <p class="fine">Codes work once and expire in a few minutes. This device gets its own token, which you can revoke from any other device{isTauri ? '' : '; this page is served by the gateway itself'}.</p>
      {:else}
        <p class="intro">Connect with the gateway's access token. Get it with <code>uniharn gateway --print-token</code>.</p>
        <form onsubmit={useToken}>
          <label class="field">
            <span>Gateway address</span>
            <input value={url} oninput={onUrlInput} placeholder="my-vm.tailnet.ts.net or 100.x.y.z" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="url" />
          </label>
          <label class="field">
            <span>Access token</span>
            <input value={token} oninput={onTokenInput} type="password" placeholder="Token from the VM" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off" />
          </label>

          {#if shownError}<p class="err" role="alert">{shownError}</p>{/if}

          <button class="btn primary block go" type="submit" disabled={busy}>
            {#if busy}<span class="spinner"></span> Connecting…{:else}Connect{/if}
          </button>
        </form>
        <button class="link" type="button" onclick={() => switchMode('pair')}>Pair with a code instead</button>
        <p class="fine">The token stays on this device. Agent credentials never leave the VM{isTauri ? '' : '; this page is served by the gateway itself'}.</p>
      {/if}
    </div>
  </div>
</div>

<Sheet bind:open={scanning} title="Scan pairing QR code" tall>
  {#if scanning}<QrScanner ondecode={scanned} />{/if}
</Sheet>

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
    box-shadow: 0 0 0 1px var(--line);
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
  .steps {
    margin: 0 0 20px;
    padding-left: 20px;
    font-size: 15px;
    line-height: 1.5;
    color: var(--text-2);
    text-wrap: pretty;
  }
  .steps li + li {
    margin-top: 4px;
  }
  code {
    font: 0.86em var(--mono);
    color: var(--text);
    background: var(--fill-2);
    padding: 1px 6px;
    border-radius: 6px;
  }
  .scan {
    margin-bottom: 20px;
    background: var(--fill-2);
  }
  .field input.code {
    font-family: var(--mono);
    font-size: 20px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .field input.code::placeholder {
    letter-spacing: 0.12em;
  }
  .err {
    color: var(--red);
    font-size: 14px;
    margin: -2px 4px 14px;
    text-wrap: pretty;
  }
  .go {
    margin-top: 8px;
  }
  .go .spinner {
    border-color: color-mix(in srgb, var(--on-accent) 30%, transparent);
    border-top-color: var(--on-accent);
  }
  .link {
    display: block;
    margin: 14px auto 0;
    padding: 8px 12px;
    font-size: 14px;
    font-weight: 500;
    color: var(--accent-text);
    background: none;
  }
  .fine {
    font-size: 12.5px;
    color: var(--text-3);
    margin: 12px 8px 0;
    text-align: center;
    text-wrap: pretty;
  }
</style>
