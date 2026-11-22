<script lang="ts">
  import { untrack } from 'svelte';
  import { conn, rpc, errorText } from '#lib/api.svelte.ts';
  import { copyText, toast } from '#lib/ui.svelte.ts';
  import { ago } from '#lib/format.ts';
  import type { DeviceInfo, PairingCode, PairingCodeRow } from '#lib/types.ts';
  import Sheet from './Sheet.svelte';
  import Icon from './Icon.svelte';

  let devices = $state<DeviceInfo[] | null>(null);
  let loadError = $state<string | null>(null);
  let loading = $state(false);

  async function load() {
    loading = true;
    try {
      const list = (await rpc('devices.list')) as DeviceInfo[];
      // This device first, then active ones by recent use, revoked ones last.
      devices = [...list].sort((a, b) => Number(b.current) - Number(a.current) || Number(!!a.revokedAt) - Number(!!b.revokedAt) || b.lastSeenAt - a.lastSeenAt);
      loadError = null;
    } catch (e) {
      loadError = errorText(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (conn.status === 'online' && conn.generation) untrack(load);
  });

  const PLATFORM: Record<string, string> = { ios: 'iOS', android: 'Android', desktop: 'Desktop' };
  const KIND: Record<string, string> = { app: 'app', browser: 'browser', pwa: 'home-screen app' };
  function platformLabel(p: string | null) {
    if (!p) return '';
    const [os, kind] = p.split('-');
    return PLATFORM[os] ? `${PLATFORM[os]}${KIND[kind] ? ' ' + KIND[kind] : ''}` : p;
  }
  function seen(d: DeviceInfo) {
    const a = ago(d.lastSeenAt);
    return a === 'now' ? 'Active now' : `Last seen ${a} ago`;
  }

  // Rename this device.
  let editing = $state(false);
  let newName = $state('');
  let saving = $state(false);
  function startRename(d: DeviceInfo) {
    newName = d.name;
    editing = true;
  }
  async function rename(e: SubmitEvent, d: DeviceInfo) {
    e.preventDefault();
    const name = newName.trim();
    if (!name || name === d.name) return (editing = false);
    saving = true;
    try {
      const updated = (await rpc('devices.rename', { deviceId: d.deviceId, name })) as DeviceInfo;
      d.name = updated?.name ?? name;
      editing = false;
      toast('Device renamed');
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      saving = false;
    }
  }

  // Revoke another device, after confirmation.
  let revokeTarget = $state<DeviceInfo | null>(null);
  let confirmOpen = $state(false);
  let revoking = $state(false);
  function askRevoke(d: DeviceInfo) {
    revokeTarget = d;
    confirmOpen = true;
  }
  async function revoke() {
    const d = revokeTarget;
    if (!d) return;
    revoking = true;
    try {
      await rpc('devices.revoke', { deviceId: d.deviceId });
      confirmOpen = false;
      toast(`${d.name} was revoked`);
      await load();
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      revoking = false;
    }
  }

  let rotating = $state(false);
  async function rotate() {
    rotating = true;
    try {
      await rpc('devices.rotate');
      toast("This device's token was rotated");
      await load();
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      rotating = false;
    }
  }

  // Pair another device: a one-time code with QR, shown until it is used, cancelled or expires.
  let pairOpen = $state(false);
  let pending = $state<PairingCode | null>(null);
  let pairState = $state<'idle' | 'creating' | 'ready' | 'used' | 'expired' | 'cancelled' | 'error'>('idle');
  let pairError = $state<string | null>(null);
  let now = $state(Date.now());

  function safeQr(svg: string | undefined): string | null {
    if (!svg) return null;
    const s = svg.trim();
    if (!s.startsWith('<svg') || /<script/i.test(s)) return null;
    try {
      let bin = '';
      for (const byte of new TextEncoder().encode(s)) bin += String.fromCharCode(byte);
      return 'data:image/svg+xml;base64,' + btoa(bin);
    } catch {
      return null;
    }
  }
  let qrSrc = $derived(safeQr(pending?.qrSvg));
  let remaining = $derived(pending ? Math.max(0, Math.ceil((pending.expiresAt - now) / 1000)) : 0);
  let countdown = $derived(`${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`);

  async function createCode() {
    pairState = 'creating';
    pairError = null;
    pending = null;
    try {
      pending = (await rpc('pairing.create')) as PairingCode;
      now = Date.now();
      pairState = 'ready';
    } catch (err) {
      pairError = errorText(err);
      pairState = 'error';
    }
  }
  function openPair() {
    pairOpen = true;
    createCode();
  }
  async function cancelCode() {
    const p = pending;
    if (!p) return;
    try {
      await rpc('pairing.revoke', { codeId: p.codeId });
      pairState = 'cancelled';
      pending = null;
      toast('Pairing code cancelled');
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  // While the sheet is open: tick the countdown, and notice when the code gets used.
  $effect(() => {
    if (!pairOpen || pairState !== 'ready') return;
    const tick = setInterval(() => {
      now = Date.now();
      if (pending && now >= pending.expiresAt) pairState = 'expired';
    }, 1000);
    const poll = setInterval(async () => {
      const p = pending;
      if (!p || conn.status !== 'online') return;
      try {
        const codes = (await rpc('pairing.list')) as PairingCodeRow[];
        if (pending === p && pairState === 'ready' && Date.now() < p.expiresAt && !codes.some((c) => c.codeId === p.codeId)) {
          pairState = 'used';
          untrack(load);
        }
      } catch {
        // Older gateways or a dropped connection: the countdown still works.
      }
    }, 3000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  });
  $effect(() => {
    if (!pairOpen && pairState !== 'idle') {
      pairState = 'idle';
      pending = null;
      untrack(load);
    }
  });

  async function copyLink() {
    if (!pending) return;
    toast((await copyText(pending.pairingUri)) ? 'Link copied' : 'Could not copy the link', 'info');
  }
</script>

<div class="label">Devices</div>
<div class="card devices">
  {#if devices === null}
    <div class="kv"><span>Paired devices</span><b class:bad={!!loadError}>{loadError ? 'Unavailable' : 'Loading…'}</b></div>
    {#if loadError}<p class="muted detail">{loadError}</p>{/if}
  {:else if devices.length === 0}
    <p class="muted detail empty">No paired devices yet. This connection uses the gateway's access token.</p>
  {:else}
    {#each devices as d (d.deviceId)}
      <div class="device" class:revoked={!!d.revokedAt}>
        <span class="icon"><Icon name="device" size={20} /></span>
        <div class="info">
          {#if d.current && editing}
            <form class="rename" onsubmit={(e) => rename(e, d)}>
              <!-- svelte-ignore a11y_autofocus -->
              <input bind:value={newName} maxlength="128" aria-label="Device name" autofocus onkeydown={(e) => e.key === 'Escape' && (editing = false)} />
              <button class="btn small" type="submit" disabled={saving}>Save</button>
              <button class="btn small" type="button" onclick={() => (editing = false)}>Cancel</button>
            </form>
          {:else}
            <div class="name">
              <b>{d.name}</b>
              {#if d.current}<span class="badge">This device</span>{/if}
              {#if d.revokedAt}<span class="badge">Revoked</span>{/if}
            </div>
          {/if}
          <div class="meta muted">
            {platformLabel(d.platform)}{d.platform ? ' · ' : ''}{d.revokedAt ? `Revoked ${ago(d.revokedAt)} ago` : seen(d)}
          </div>
        </div>
        {#if d.current && !d.revokedAt && !editing}
          <button class="iconbtn" aria-label="Rename this device" onclick={() => startRename(d)}><Icon name="edit" size={18} /></button>
        {:else if !d.current && !d.revokedAt}
          <button class="btn small danger" onclick={() => askRevoke(d)}>Revoke</button>
        {/if}
      </div>
    {/each}
  {/if}
  <div class="row2">
    <button class="btn" onclick={openPair} disabled={conn.status !== 'online'}><Icon name="qr" size={18} /> Pair another device</button>
    {#if conn.info?.authKind === 'device'}
      <button class="btn" onclick={rotate} disabled={rotating || conn.status !== 'online'}>Rotate this device's token</button>
    {/if}
    <button class="btn" onclick={load} disabled={loading || conn.status !== 'online'}>Refresh</button>
  </div>
</div>

<Sheet bind:open={confirmOpen} title="Revoke device">
  {#if revokeTarget}
    <p class="confirm">Revoke {revokeTarget.name}? It will be disconnected immediately and must pair again.</p>
    <div class="actions">
      <button class="btn" onclick={() => (confirmOpen = false)}>Cancel</button>
      <button class="btn danger" onclick={revoke} disabled={revoking}>{revoking ? 'Revoking…' : 'Revoke'}</button>
    </div>
  {/if}
</Sheet>

<Sheet bind:open={pairOpen} title="Pair another device">
  <div class="pair">
    {#if pairState === 'creating'}
      <div class="center"><span class="spinner"></span></div>
    {:else if pairState === 'error'}
      <p class="msg bad">{pairError}</p>
      <button class="btn" onclick={createCode}>Try again</button>
    {:else if pairState === 'used'}
      <p class="msg ok"><Icon name="check" size={20} /> The new device is paired.</p>
    {:else if pairState === 'expired' || pairState === 'cancelled'}
      <p class="msg">{pairState === 'expired' ? 'This code has expired.' : 'The code was cancelled.'}</p>
      <button class="btn" onclick={createCode}>Create a new code</button>
    {:else if pending}
      <p class="muted lead">On the other device, scan this code with the uniharn app or the camera, or open uniharn and enter the code.</p>
      {#if qrSrc}
        <img class="qr" src={qrSrc} alt="Pairing QR code" width="240" height="240" />
      {/if}
      <div class="code mono" aria-label="Pairing code">{pending.code}</div>
      <p class="countdown muted" aria-live="off">Expires in <b class="mono">{countdown}</b> · works once</p>
      <div class="linkrow">
        <span class="mono link">{pending.pairingUri}</span>
        <button class="btn small" onclick={copyLink}><Icon name="copy" size={16} /> Copy</button>
      </div>
      <button class="btn danger cancel" onclick={cancelCode}>Cancel code</button>
    {/if}
  </div>
</Sheet>

<style>
  .card.devices {
    padding: 0 16px;
  }
  .device {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 60px;
    padding: 10px 0;
  }
  .device + .device {
    border-top: 1px solid var(--line);
  }
  .device.revoked {
    opacity: 0.5;
  }
  .icon {
    flex: none;
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: var(--r-sm);
    background: var(--fill);
    color: var(--text-2);
  }
  .info {
    flex: 1;
    min-width: 0;
  }
  .name {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    font-size: 15px;
  }
  .name b {
    font-weight: 550;
    overflow-wrap: anywhere;
  }
  .badge {
    font-size: 11.5px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent-text);
  }
  .revoked .badge {
    background: var(--fill-2);
    color: var(--text-2);
  }
  .meta {
    font-size: 13px;
    margin-top: 2px;
  }
  .rename {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .rename input {
    flex: 1;
    min-width: 0;
    min-height: 36px;
    padding: 0 12px;
    border-radius: var(--r-sm);
    border: 1px solid var(--line);
    background: var(--bg-input);
    font-size: 15px;
    outline: none;
  }
  .rename input:focus {
    border-color: color-mix(in srgb, var(--accent) 55%, var(--line-strong));
  }
  .btn.small {
    flex: none;
    min-height: 34px;
    padding: 0 14px;
    font-size: 14px;
  }
  .card .btn {
    background: var(--fill);
  }
  .row2 {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 6px 0 14px;
    border-top: 1px solid var(--line);
    padding-top: 14px;
  }
  .row2 .btn {
    flex: 1;
    min-height: 42px;
    padding: 0 14px;
    font-size: 14px;
    white-space: nowrap;
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
  .kv > span {
    color: var(--text-2);
  }
  .kv b {
    font-weight: 500;
  }
  .bad {
    color: var(--amber);
  }
  .detail {
    font-size: 13px;
    line-height: 1.45;
    margin: 0;
    padding: 0 0 14px;
  }
  .detail.empty {
    padding-top: 14px;
  }
  .confirm {
    margin: 4px 4px 18px;
    font-size: 15px;
    line-height: 1.45;
    text-wrap: pretty;
  }
  .actions {
    display: flex;
    gap: 10px;
  }
  .actions .btn {
    flex: 1;
  }
  .actions .btn.danger,
  .cancel {
    background: color-mix(in srgb, var(--red) 14%, transparent);
  }
  .pair {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 4px 0 8px;
    text-align: center;
  }
  .center {
    padding: 48px 0;
  }
  .lead {
    margin: 0;
    font-size: 14px;
    line-height: 1.45;
    text-wrap: pretty;
  }
  .qr {
    width: 220px;
    height: 220px;
    border-radius: var(--r-md);
    box-shadow: 0 0 0 1px var(--line);
  }
  .code {
    font-size: 32px;
    font-weight: 600;
    letter-spacing: 0.14em;
    user-select: all;
  }
  .countdown {
    margin: -6px 0 0;
    font-size: 13px;
  }
  .countdown b {
    font-weight: 600;
    color: var(--text);
  }
  .linkrow {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 8px 8px 14px;
    border-radius: var(--r-md);
    background: var(--fill);
  }
  .link {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-2);
  }
  .msg {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin: 20px 0 4px;
    font-size: 15px;
  }
  .msg.ok {
    color: var(--green);
  }
  .msg.bad {
    color: var(--red);
  }
  .pair > .btn {
    min-width: 200px;
    background: var(--fill);
  }
  .pair > .btn.cancel {
    background: color-mix(in srgb, var(--red) 14%, transparent);
  }
</style>
