<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import { views, conn, rpc, openSession, app, errorText } from '#lib/api.svelte.ts';
  import { emptyState } from '#lib/timeline.ts';
  import type { Item, TextItem, ToolItem } from '#lib/types.ts';
  import { go, toast } from '#lib/ui.svelte.ts';
  import { markdown, basename } from '#lib/format.ts';
  import Icon from './Icon.svelte';
  import ToolCall from './ToolCall.svelte';
  import Permission from './Permission.svelte';
  import SessionControls from './SessionControls.svelte';

  type Steps = { kind: 'steps'; id: string; items: (TextItem | ToolItem)[] };

  let { id }: { id: string } = $props();
  let view = $derived(views[id]);
  const blank = emptyState();
  let st = $derived(view?.state ?? blank);
  let text = $state('');
  let sending = $state(false);
  let controls = $state(false);
  let scroller = $state<HTMLElement>();
  let input = $state<HTMLTextAreaElement>();
  let pinned = $state(true);
  let openGroups = $state<Record<string, boolean>>({});
  let loadError = $state<string | null>(null);

  $effect(() => {
    const sid = id;
    conn.generation;
    if (conn.status !== 'online') return;
    loadError = null;
    untrack(() => {
      const known = app.sessions.find((s) => s.id === sid);
      openSession(sid, known?.cwd).catch((e) => (loadError = errorText(e)));
    });
  });

  // Fold runs of thinking and tool calls into one collapsible "steps" block between messages.
  let blocks = $derived.by(() => {
    const out: (Exclude<Item, ToolItem> | Steps)[] = [];
    for (const it of view?.items ?? []) {
      if (it.kind === 'thought' || it.kind === 'tool') {
        const last = out[out.length - 1];
        if (last?.kind === 'steps') last.items.push(it);
        else out.push({ kind: 'steps', id: 'g' + it.id, items: [it] });
      } else out.push(it);
    }
    return out;
  });
  let busy = $derived(st.status === 'running' || st.status === 'awaiting_permission');
  let mode = $derived((st.modes ?? []).find((m) => m.id === st.mode));
  let suggestions = $derived.by(() => {
    if (!text.startsWith('/') || /\s/.test(text)) return [];
    const q = text.slice(1).toLowerCase();
    return (st.commands ?? []).filter((c) => c.name.toLowerCase().startsWith(q)).slice(0, 6);
  });

  function summary(g: Steps) {
    const tools = g.items.filter((i) => i.kind === 'tool');
    const active = tools.findLast((t) => t.status === 'pending' || t.status === 'in_progress');
    if (active) return active.title;
    if (!tools.length) return 'Thought';
    const failed = tools.filter((t) => t.status === 'failed').length;
    return `${tools.length} step${tools.length > 1 ? 's' : ''}${failed ? ` · ${failed} failed` : ''}`;
  }
  const working = (g: Steps) => g.items.some((i) => i.kind === 'tool' && (i.status === 'pending' || i.status === 'in_progress'));
  const isOpen = (g: Steps, last: boolean) => openGroups[g.id] ?? (last && busy);

  function onScroll() {
    if (scroller) pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  }
  async function toBottom(force = false) {
    await tick();
    if (scroller && (pinned || force)) scroller.scrollTop = scroller.scrollHeight;
  }
  $effect(() => {
    view?.seq;
    st.permissions?.length;
    toBottom();
  });

  function autosize() {
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  }

  type Attachment = { mimeType: string; data: string; name: string; url: string };
  const MAX_IMAGES = 4;
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
  let images = $state<Attachment[]>([]);
  let fileInput = $state<HTMLInputElement>();
  const rawSize = (b64: string) => Math.floor((b64.length * 3) / 4);

  async function onfiles(e: Event) {
    const files = [...((e.target as HTMLInputElement).files ?? [])];
    let total = images.reduce((n, i) => n + rawSize(i.data), 0);
    let skipped = 0;
    for (const f of files) {
      if (images.length >= MAX_IMAGES || !f.type.startsWith('image/') || f.size > MAX_IMAGE_BYTES || total + f.size > MAX_TOTAL_BYTES) {
        skipped++;
        continue;
      }
      total += f.size;
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      images.push({ mimeType: f.type, data: btoa(bin), name: f.name, url: URL.createObjectURL(f) });
    }
    if (skipped) toast(`Up to ${MAX_IMAGES} images, 8 MB each.`, 'error');
    if (fileInput) fileInput.value = '';
  }

  function removeImage(i: number) {
    const [img] = images.splice(i, 1);
    if (img) URL.revokeObjectURL(img.url);
  }

  onDestroy(() => images.forEach((i) => URL.revokeObjectURL(i.url)));

  async function send() {
    const t = text.trim();
    if ((!t && !images.length) || sending) return;
    sending = true;
    const keep = text;
    const keepImages = images;
    images = [];
    text = '';
    await tick();
    autosize();
    pinned = true;
    try {
      await rpc('session.prompt', { id, text: t, images: keepImages.map(({ mimeType, data }) => ({ mimeType, data })) });
      keepImages.forEach((i) => URL.revokeObjectURL(i.url));
      toBottom(true);
    } catch (e) {
      text = keep;
      images = keepImages;
      toast(errorText(e), 'error');
    } finally {
      sending = false;
    }
  }

  async function stop() {
    try {
      await rpc('session.cancel', { id });
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  function keydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      send();
    }
  }

  function copyCode(e: MouseEvent) {
    const btn = (e.target as Element).closest?.('[data-copy]');
    if (!btn) return;
    const code = btn.closest('.codeblock')?.querySelector('code')?.innerText ?? '';
    navigator.clipboard?.writeText(code).then(() => {
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = 'Copy'), 1200);
    });
  }
</script>

<div class="screen">
  <header class="topbar">
    <button class="iconbtn" onclick={() => go('#/')} aria-label="Back to sessions"><Icon name="back" /></button>
    <button class="title" onclick={() => (controls = true)}>
      <b>{st.title || 'New session'}</b>
      <small>
        <span class="dot {st.status}"></span>
        {#if conn.status !== 'online'}Reconnecting…{:else if st.status === 'running'}Working{:else if st.status === 'awaiting_permission'}Needs approval{:else}{basename(view?.cwd)}{/if}
        {#if mode}· {mode.name}{/if}
      </small>
    </button>
    <button class="iconbtn" onclick={() => go('#/s/' + encodeURIComponent(id) + '/changes')} aria-label="Changes"><Icon name="diff" /></button>
    <button class="iconbtn" onclick={() => (controls = true)} aria-label="Session settings"><Icon name="settings" /></button>
  </header>

  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="log" bind:this={scroller} onscroll={onScroll} onclick={copyCode}>
    {#if !view?.ready}
      <div class="empty">
        {#if loadError}<h2>Could not open this session</h2><p>{loadError}</p><button class="btn" onclick={() => go('#/')}>Back</button>
        {:else}<span class="spinner" style="margin:auto"></span>{/if}
      </div>
    {:else if blocks.length === 0}
      <div class="empty">
        <h2>What should Devin do?</h2>
        <p class="mono small">{view.cwd}</p>
      </div>
    {:else}
      {#each blocks as b, i (b.id)}
        {#if b.kind === 'user'}
          <div class="msg user">
            <div class="bubble">
              {#if b.images}
                <div class="pics">
                  {#each b.images as img}<img src={`data:${img.mimeType};base64,${img.data}`} alt="Attachment" />{/each}
                </div>
              {/if}
              {b.text}
            </div>
          </div>
        {:else if b.kind === 'assistant'}
          <div class="msg assistant md">{@html markdown(b.text)}</div>
        {:else if b.kind === 'steps'}
          {@const last = i === blocks.length - 1}
          {@const opened = isOpen(b, last)}
          <div class="steps">
            <button class="shead" onclick={() => (openGroups[b.id] = !opened)} aria-expanded={opened}>
              {#if working(b) || (last && busy)}<span class="spinner sm"></span>{:else}<Icon name="list" size={15} />{/if}
              <span class="stext">{summary(b)}</span>
              <span class="chev" class:open={opened}><Icon name="chevron" size={14} /></span>
            </button>
            {#if opened}
              <div class="sbody">
                {#each b.items as it (it.id)}
                  {#if it.kind === 'thought'}
                    <details class="thought">
                      <summary><Icon name="brain" size={14} /> Thinking <span class="peek">{it.text.slice(0, 80)}</span></summary>
                      <div class="md ttext">{@html markdown(it.text)}</div>
                    </details>
                  {:else if it.kind === 'tool'}
                    <ToolCall item={it} />
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        {:else if b.kind === 'plan'}
          <div class="plan">
            <div class="phead"><Icon name="list" size={15} /> Plan</div>
            {#each b.entries as e}
              <div class="pitem {e.status}"><span class="box">{#if e.status === 'completed'}<Icon name="check" size={12} />{/if}</span><span>{e.content}</span></div>
            {/each}
          </div>
        {:else if b.kind === 'notice'}
          <div class="notice {b.level}">{b.text}</div>
        {/if}
      {/each}
      {#if st.status === 'running' && blocks[blocks.length - 1]?.kind === 'user'}
        <div class="typing"><span></span><span></span><span></span></div>
      {/if}
    {/if}
  </div>

  {#if !pinned}
    <button class="jump" onclick={() => ((pinned = true), toBottom(true))} aria-label="Scroll to latest"><Icon name="down" size={18} /></button>
  {/if}

  {#each st.permissions ?? [] as p (p.reqId)}
    <Permission sessionId={id} request={p} />
  {/each}

  <div class="composer">
    {#if suggestions.length}
      <div class="sugg">
        {#each suggestions as c}
          <button onclick={() => ((text = '/' + c.name + ' '), input?.focus())}><b class="mono">/{c.name}</b><small>{c.description}</small></button>
        {/each}
      </div>
    {/if}
    <div class="box">
      {#if images.length}
        <div class="thumbs">
          {#each images as img, i (img.url)}
            <span class="thumb">
              <img src={img.url} alt={img.name} />
              <button aria-label="Remove image" onclick={() => removeImage(i)}><Icon name="x" size={12} /></button>
            </span>
          {/each}
        </div>
      {/if}
      <textarea
        bind:this={input}
        bind:value={text}
        oninput={autosize}
        onkeydown={keydown}
        rows="1"
        placeholder={busy ? 'Add instructions while Devin works…' : 'Message Devin'}
        aria-label="Message"
        disabled={!view?.ready}
      ></textarea>
      <div class="bar">
        <button class="round attach" onclick={() => fileInput?.click()} disabled={!view?.ready} aria-label="Attach image"><Icon name="plus" size={18} /></button>
        <input bind:this={fileInput} type="file" accept="image/*" multiple hidden onchange={onfiles} />
        <button class="chip" onclick={() => (controls = true)}><Icon name="settings" size={14} /> {mode?.name ?? 'Mode'}</button>
        <span class="grow"></span>
        {#if busy}
          <button class="round stop" onclick={stop} aria-label="Stop"><Icon name="stop" size={16} /></button>
        {/if}
        {#if !busy || text.trim() || images.length}
          <button class="round send" onclick={send} disabled={(!text.trim() && !images.length) || sending || conn.status !== 'online'} aria-label="Send"><Icon name="send" size={18} /></button>
        {/if}
      </div>
    </div>
  </div>
</div>

<SessionControls bind:open={controls} sessionId={id} {view} />

<style>
  button.title {
    text-align: left;
  }
  .log {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    padding: 14px 14px 8px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .small {
    font-size: 12.5px;
    overflow-wrap: anywhere;
  }
  .msg.user {
    display: flex;
    justify-content: flex-end;
  }
  .bubble {
    max-width: 86%;
    padding: 9px 14px;
    border-radius: 18px;
    background: var(--bg-elev2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .msg.assistant {
    font-size: 15.5px;
    line-height: 1.58;
  }
  .steps {
    border-left: 2px solid var(--line);
    padding-left: 10px;
  }
  .shead {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 32px;
    max-width: 100%;
    color: var(--text-2);
    font-size: 13.5px;
  }
  .stext {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chev {
    display: grid;
    transition: transform 0.15s;
    color: var(--text-3);
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .spinner.sm {
    width: 13px;
    height: 13px;
  }
  .sbody {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 4px 0 2px;
  }
  .thought summary {
    display: flex;
    align-items: center;
    gap: 6px;
    list-style: none;
    cursor: pointer;
    color: var(--text-2);
    font-size: 13px;
    min-height: 30px;
  }
  .thought summary::-webkit-details-marker {
    display: none;
  }
  .peek {
    flex: 1;
    min-width: 0;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .thought[open] .peek {
    display: none;
  }
  .ttext {
    color: var(--text-2);
    font-size: 13.5px;
    padding: 2px 0 6px 20px;
  }
  .plan {
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 10px 12px;
    background: var(--bg-elev);
    font-size: 14px;
  }
  .phead {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-2);
    font-size: 13px;
    margin-bottom: 6px;
  }
  .pitem {
    display: flex;
    gap: 8px;
    padding: 3px 0;
  }
  .pitem .box {
    flex: none;
    width: 16px;
    height: 16px;
    margin-top: 3px;
    border-radius: 5px;
    border: 1.5px solid var(--line-strong);
    display: grid;
    place-items: center;
  }
  .pitem.completed {
    color: var(--text-3);
    text-decoration: line-through;
  }
  .pitem.completed .box {
    background: var(--green);
    border-color: var(--green);
    color: var(--bg);
  }
  .pitem.in_progress .box {
    border-color: var(--green);
  }
  .notice {
    font-size: 13.5px;
    padding: 8px 12px;
    border-radius: 10px;
    background: var(--bg-elev);
    color: var(--text-2);
    overflow-wrap: anywhere;
  }
  .notice.error {
    color: var(--red);
    border: 1px solid color-mix(in srgb, var(--red) 40%, transparent);
  }
  .typing {
    display: flex;
    gap: 4px;
    padding: 6px 2px;
  }
  .typing span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-3);
    animation: pulse 1s ease-in-out infinite;
  }
  .typing span:nth-child(2) {
    animation-delay: 0.15s;
  }
  .typing span:nth-child(3) {
    animation-delay: 0.3s;
  }
  .jump {
    position: absolute;
    right: 16px;
    bottom: calc(var(--safe-bottom) + 128px);
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--bg-elev2);
    border: 1px solid var(--line-strong);
    z-index: 5;
  }
  .composer {
    flex: none;
    padding: 4px 12px calc(var(--safe-bottom) + 10px);
  }
  .box {
    border: 1px solid var(--line-strong);
    border-radius: 22px;
    background: var(--bg-input);
    padding: 8px 8px 8px 14px;
  }
  textarea {
    display: block;
    width: 100%;
    border: 0;
    outline: 0;
    resize: none;
    background: none;
    padding: 4px 0 6px;
    max-height: 160px;
    line-height: 1.4;
    font-size: 16px;
  }
  textarea::placeholder {
    color: var(--text-3);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: -6px;
  }
  .thumbs {
    display: flex;
    gap: 8px;
    padding: 4px 0 8px;
    overflow-x: auto;
  }
  .thumb {
    position: relative;
    flex: none;
  }
  .thumb img {
    display: block;
    width: 56px;
    height: 56px;
    object-fit: cover;
    border-radius: 10px;
    border: 1px solid var(--line);
  }
  .thumb button {
    position: absolute;
    top: -5px;
    right: -5px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--text);
    color: var(--bg);
  }
  .pics {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 6px;
  }
  .pics img {
    max-width: 140px;
    max-height: 140px;
    border-radius: 10px;
    display: block;
  }
  .attach {
    background: none;
    color: var(--text-2);
  }
  .grow {
    flex: 1;
  }
  .round {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    flex: none;
  }
  .round.send {
    background: var(--accent);
    color: var(--on-accent);
  }
  .round.stop {
    background: var(--bg-elev2);
    border: 1px solid var(--line-strong);
    color: var(--red);
  }
  .sugg {
    margin-bottom: 6px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--bg-elev);
    overflow: hidden;
  }
  .sugg button {
    display: flex;
    gap: 10px;
    align-items: baseline;
    width: 100%;
    text-align: left;
    padding: 9px 12px;
    border-bottom: 1px solid var(--line);
  }
  .sugg button:last-child {
    border-bottom: 0;
  }
  .sugg b {
    font-size: 13px;
    flex: none;
  }
  .sugg small {
    color: var(--text-2);
    font-size: 12.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
