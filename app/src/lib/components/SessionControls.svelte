<script lang="ts">
  import { rpc, conn, errorText, app } from '#lib/api.svelte.ts';
  import type { ConfigOption, ConfigOptionValue, Json, SessionView } from '#lib/types.ts';
  import { go, toast } from '#lib/ui.svelte.ts';
  import { shortPath } from '#lib/format.ts';
  import Sheet from './Sheet.svelte';
  import Icon from './Icon.svelte';
  import ModelPicker from './ModelPicker.svelte';
  import { isModelOption } from '#lib/models.ts';
  import { compact, USAGE_URL } from '#lib/usage.ts';

  let { open = $bindable(false), sessionId, view }: { open?: boolean; sessionId: string; view: SessionView | undefined } = $props();
  let busy = $state<string | null>(null);
  let confirmDelete = $state(false);
  $effect(() => {
    if (!open) confirmDelete = false;
  });

  let modes = $derived(view?.state.modes ?? []);
  // Every option the agent exposes (model, reasoning level, …). Mode is left out when it has its own picker above.
  let options = $derived((view?.state.configOptions ?? []).filter((o) => !modes.length || (o.category !== 'mode' && o.id !== 'mode')));
  const flat = (o: ConfigOption): ConfigOptionValue[] => (o.options ?? []).flatMap((x) => ('options' in x ? x.options : [x]));

  let ctx = $derived(view?.state.context ?? null);
  let ctxPct = $derived(ctx ? Math.min(100, Math.round((ctx.used / ctx.size) * 100)) : 0);
  let tokens = $derived(view?.state.tokens ?? null);
  let stats = $derived(view?.state.turnStats ?? []);

  let currentHarness = $derived(sessionId.includes(':') ? sessionId.slice(0, sessionId.indexOf(':')) : 'devin');
  let targets = $derived(app.harnesses.filter((h) => h.enabled && (h.installed || h.id === 'devin')));
  let target = $state('');
  let instruction = $state('');
  let worktree = $state(false);
  let links = $derived(app.links.filter((l) => l.parentSessionId === sessionId));
  $effect(() => {
    if (open) rpc('orchestration.list', { id: sessionId }).catch(() => {});
  });
  $effect(() => {
    if (targets.length && !targets.some((h) => h.id === target)) target = (targets.find((h) => h.id !== currentHarness) ?? targets[0]).id;
  });
  const harnessName = (id: string) => app.harnesses.find((h) => h.id === id)?.name ?? id;

  async function handoff() {
    busy = 'handoff';
    try {
      const link = await rpc('session.handoff', { id: sessionId, harnessId: target, instruction });
      instruction = '';
      open = false;
      go('#/s/' + encodeURIComponent(link.childSessionId));
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      busy = null;
    }
  }

  async function delegate() {
    if (!instruction.trim()) return toast('Describe the task for the subagent', 'error');
    busy = 'delegate';
    try {
      await rpc('orchestration.delegate', { id: sessionId, harnessId: target, task: instruction, worktree, includeContext: true });
      instruction = '';
      toast(`Subagent started on ${harnessName(target)}`);
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      busy = null;
    }
  }

  async function run(key: string, m: string, p: Json, done?: () => void) {
    busy = key;
    try {
      await rpc(m, { id: sessionId, ...p });
      done?.();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      busy = null;
    }
  }
</script>

<Sheet bind:open title="Session">
  {#if modes.length}
  <div class="label">Mode</div>
  <div class="group">
    {#each modes as m}
      <button class="opt" class:on={view?.state.mode === m.id} disabled={busy !== null} onclick={() => run('mode', 'session.setMode', { modeId: m.id })}>
        <b>{m.name}</b>
        {#if m.description}<small>{m.description}</small>{/if}
        {#if view?.state.mode === m.id}<span class="tick"><Icon name="check" size={18} /></span>{/if}
      </button>
    {/each}
  </div>
  {/if}

  {#each options as o}
    <div class="label">{o.name}</div>
    {#if isModelOption(o) && flat(o).length}
      <ModelPicker option={o} disabled={busy !== null} onpick={(value) => run(o.id, 'session.setConfig', { configId: o.id, value })} />
    {:else if flat(o).length}
      <div class="selwrap">
        <select value={o.currentValue} disabled={busy !== null} onchange={(e) => run(o.id, 'session.setConfig', { configId: o.id, value: e.currentTarget.value })}>
          {#each flat(o) as x}<option value={x.value}>{x.name}</option>{/each}
        </select>
        <Icon name="down" size={16} />
      </div>
    {:else}
      <p class="muted note">Current: <span class="mono">{o.currentValue ?? 'default'}</span>. The CLI lists choices here once it is logged in; you can also type <span class="mono">/model</span> in the chat.</p>
    {/if}
  {/each}

  <div class="label">Usage</div>
  <div class="usage">
    {#if ctx}
      <div class="ctx">
        <span>Context</span><b>{compact(ctx.used)} / {compact(ctx.size)} · {ctxPct}%</b>
      </div>
      <div class="bar" class:warn={ctxPct >= 80}><i style="width: {ctxPct}%"></i></div>
    {/if}
    {#if stats.length}
      {#each stats as s (s.id)}
        <div class="ctx"><span>{s.label}</span><b>{typeof s.value === 'number' ? compact(s.value) : s.value}</b></div>
      {/each}
    {:else if tokens && tokens.turns}
      <div class="ctx"><span>Turns</span><b>{tokens.turns}</b></div>
      <div class="ctx"><span>Input tokens</span><b>{compact(tokens.inputTokens)}</b></div>
      <div class="ctx"><span>Output tokens</span><b>{compact(tokens.outputTokens)}</b></div>
      <div class="ctx"><span>Cached reads</span><b>{compact(tokens.cachedReadTokens)}</b></div>
    {:else if !ctx}
      <p class="muted note">Shown after the first reply in this session.</p>
    {/if}
    <a class="more" href={USAGE_URL} target="_blank" rel="noreferrer">Plan quota and credits <Icon name="chevron" size={14} /></a>
  </div>

  {#if targets.length > 1}
    <div class="label">Other harnesses</div>
    <div class="orch">
      <select bind:value={target} aria-label="Target harness">
        {#each targets as h (h.id)}<option value={h.id}>{h.name}</option>{/each}
      </select>
      <textarea rows="2" bind:value={instruction} placeholder="Instruction or subagent task"></textarea>
      <label class="check"><input type="checkbox" bind:checked={worktree} /> Run subagent in a separate git worktree</label>
      <div class="row2">
        <button class="btn" disabled={busy !== null} onclick={handoff}>Hand off session</button>
        <button class="btn" disabled={busy !== null || !instruction.trim()} onclick={delegate}>Run as subagent</button>
      </div>
      {#each links as l (l.id)}
        <button class="link press" onclick={() => ((open = false), go('#/s/' + encodeURIComponent(l.childSessionId)))}>
          <span class="st {l.status}">{l.status}</span>
          <span class="lt"><b>{harnessName(l.harnessId)}</b> · {l.kind === 'handoff' ? 'handoff' : l.task}{#if l.branch}<small class="mono">{l.branch}</small>{/if}</span>
        </button>
      {/each}
    </div>
  {/if}

  <div class="label">Project</div>
  <p class="mono path">{shortPath(view?.cwd, conn.info?.home)}</p>
  <p class="mono path muted">{sessionId}</p>

  <div class="actions">
    <button class="btn block" onclick={() => ((open = false), go('#/s/' + encodeURIComponent(sessionId) + '/terminal'))}><Icon name="terminal" size={18} /> Open terminal here</button>
    <button class="btn block" disabled={busy !== null} onclick={() => run('close', 'session.close', {}, () => ((open = false), go('#/')))}>End session</button>
    {#if confirmDelete}
      <button class="btn block danger" disabled={busy !== null} onclick={() => run('delete', 'session.delete', {}, () => ((open = false), go('#/')))}>Delete permanently</button>
      <button class="btn block" disabled={busy !== null} onclick={() => (confirmDelete = false)}>Keep session</button>
    {:else}
      <button class="btn block danger" disabled={busy !== null} onclick={() => (confirmDelete = true)}>Delete session</button>
    {/if}
  </div>
</Sheet>

<style>
  .label:first-child {
    margin-top: 4px;
  }
  .group {
    border-radius: var(--r-lg);
    overflow: hidden;
    background: var(--fill);
  }
  .opt {
    display: block;
    position: relative;
    width: 100%;
    min-height: 52px;
    text-align: left;
    padding: 12px 48px 12px 16px;
    transition: background-color 0.2s ease;
  }
  .opt:active:not(:disabled) {
    background: var(--fill);
  }
  /* Inset hairline between options. */
  .opt + .opt::before {
    content: '';
    position: absolute;
    top: 0;
    left: 16px;
    right: 0;
    height: 1px;
    background: var(--line);
  }
  .opt b {
    font-weight: 500;
    font-size: 15px;
  }
  .opt small {
    display: block;
    color: var(--text-2);
    font-size: 13px;
    line-height: 1.35;
    margin-top: 1px;
  }
  .opt.on b {
    font-weight: 650;
  }
  .tick {
    position: absolute;
    right: 16px;
    top: 50%;
    transform: translateY(-50%);
    display: grid;
    color: var(--accent-text);
  }
  .selwrap {
    position: relative;
    display: flex;
    align-items: center;
  }
  .selwrap select {
    appearance: none;
    width: 100%;
    min-height: 48px;
    padding: 0 42px 0 16px;
    border: 0;
    border-radius: var(--r-md);
    background: var(--fill);
    font-size: 16px;
    outline: none;
  }
  .selwrap select:focus-visible {
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .selwrap option {
    background: var(--bg-elev);
    color: var(--text);
  }
  .selwrap :global(svg) {
    position: absolute;
    right: 16px;
    pointer-events: none;
    color: var(--text-2);
  }
  .note {
    font-size: 13.5px;
    margin: 0;
  }
  .path {
    font-size: 12.5px;
    margin: 0 6px 2px;
    overflow-wrap: anywhere;
  }
  .usage {
    border-radius: var(--r-lg);
    background: var(--fill);
    padding: 14px 16px;
    display: grid;
    gap: 8px;
  }
  .ctx {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    font-size: 14px;
  }
  .ctx span {
    color: var(--text-2);
  }
  .ctx b {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .bar {
    height: 6px;
    border-radius: 99px;
    background: var(--fill-2);
    overflow: hidden;
  }
  .bar i {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: inherit;
    transition: width 0.4s var(--ease-out);
  }
  .bar.warn i {
    background: var(--amber);
  }
  .more {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    justify-self: start;
    min-height: 32px;
    font-size: 14px;
    font-weight: 500;
    color: var(--accent-text);
    text-decoration: none;
  }
  .actions {
    display: grid;
    gap: 10px;
    margin-top: 24px;
  }
  .actions .btn {
    background: var(--fill);
  }
  .orch {
    display: grid;
    gap: 8px;
  }
  .orch select,
  .orch textarea {
    width: 100%;
    padding: 10px 12px;
    border-radius: 12px;
    border: 0;
    background: var(--fill);
    color: var(--text);
    font: inherit;
    resize: vertical;
  }
  .orch .check {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 14px;
  }
  .orch .row2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .orch .btn {
    background: var(--fill);
  }
  .orch .link {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    text-align: left;
    padding: 8px 10px;
    border-radius: 10px;
    background: var(--fill);
    border: 0;
    color: var(--text);
    font: inherit;
    font-size: 14px;
  }
  .orch .lt {
    display: grid;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .orch .st {
    font-size: 11px;
    text-transform: uppercase;
    padding: 2px 6px;
    border-radius: 6px;
    background: var(--bg, transparent);
  }
  .orch .st.error {
    color: var(--danger, #e5484d);
  }
</style>
