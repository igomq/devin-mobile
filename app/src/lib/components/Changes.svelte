<script lang="ts">
  import { untrack } from 'svelte';
  import { views, conn, rpc, app, onTask, openSession, errorText } from '#lib/api.svelte.ts';
  import type { ChangedFileView, DiffRow, TaskRun, ToolItem } from '#lib/types.ts';
  import { go, toast } from '#lib/ui.svelte.ts';
  import { parseDiff, basename } from '#lib/format.ts';
  import Icon from './Icon.svelte';
  import BackButton from './BackButton.svelte';
  import DiffRows from './DiffRows.svelte';
  import ToolCall from './ToolCall.svelte';

  let { id }: { id: string } = $props();
  let view = $derived(views[id]);
  let cwd = $derived(view?.cwd ?? app.sessions.find((s) => s.id === id)?.cwd);
  let tab = $state<'files' | 'runs'>('files');
  let status = $state<{ repo: boolean; branch: string | null; files: ChangedFileView[] } | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let openFile = $state<string | null>(null);
  let diffs = $state<Record<string, { rows?: DiffRow[]; truncated?: boolean; error?: string }>>({});

  // Commands Devin ran in this session (tests, builds, linters) with their output.
  let runs = $derived((view?.items ?? []).filter((i): i is ToolItem => i.kind === 'tool' && i.toolKind === 'execute').reverse());
  let totals = $derived.by(() => {
    let a = 0;
    let r = 0;
    for (const f of status?.files ?? []) {
      a += f.added ?? 0;
      r += f.removed ?? 0;
    }
    return { a, r };
  });

  async function load() {
    if (!cwd || conn.status !== 'online') return;
    loading = true;
    try {
      status = await rpc('git.status', { cwd });
      error = null;
      diffs = {};
      if (openFile) loadDiff(openFile);
    } catch (e) {
      error = errorText(e);
    } finally {
      loading = false;
    }
  }

  async function loadDiff(path: string) {
    try {
      const r = await rpc('git.diff', { cwd, path });
      diffs[path] = { rows: parseDiff(r.diff), truncated: r.truncated };
    } catch (e) {
      diffs[path] = { error: errorText(e) };
    }
  }

  function toggle(path: string) {
    openFile = openFile === path ? null : path;
    if (openFile && !diffs[path]) loadDiff(path);
  }

  // Opened directly (reload, deep link) the session has no timeline yet; load it for the command history.
  $effect(() => {
    const sid = id;
    conn.generation;
    if (conn.status !== 'online') return;
    untrack(() => {
      if (!views[sid]?.ready) openSession(sid, app.sessions.find((s) => s.id === sid)?.cwd).catch(() => {});
    });
  });

  // Refresh when the screen opens, on reconnect, and whenever the agent finishes a step.
  let toolsDone = $derived((view?.items ?? []).filter((i) => i.kind === 'tool' && (i.status === 'completed' || i.status === 'failed')).length);
  $effect(() => {
    cwd;
    conn.generation;
    toolsDone;
    load();
  });
  // The project's own test command, run by the gateway outside the Devin session.
  let command = $state('');
  let task = $state<TaskRun | null>(null);
  let output = $state('');
  let outEl = $state<HTMLElement>();
  let taskBusy = $derived(task && task.endedAt === null);

  const stripAnsi = (t: string) => t.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  const follow = () => queueMicrotask(() => outEl?.scrollTo({ top: outEl.scrollHeight }));

  async function loadTask() {
    if (!cwd || conn.status !== 'online') return;
    try {
      const [d, list] = await Promise.all([rpc('tasks.detect', { cwd }), rpc('tasks.list', { cwd })]);
      if (!command) command = d.command ?? '';
      const current = task?.taskId;
      const latest: TaskRun | undefined = current ? list.find((t: TaskRun) => t.taskId === current) : list[0];
      if (latest) {
        const full: TaskRun = await rpc('tasks.get', { id: latest.taskId });
        task = full;
        output = stripAnsi(full.output ?? '');
        follow();
      }
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  async function runTask() {
    try {
      task = await rpc('tasks.run', { cwd, command });
      output = '';
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  function sendToDevin() {
    if (!task) return;
    const text = `I ran \`${task.command}\` and it exited with code ${task.exitCode}. Please fix the failures.\n\n\`\`\`\n${output.slice(-6000)}\n\`\`\``;
    rpc('session.prompt', { id, text })
      .then(() => go('#/s/' + encodeURIComponent(id)))
      .catch((e) => toast(errorText(e), 'error'));
  }

  $effect(() => {
    cwd;
    conn.generation;
    untrack(loadTask);
  });
  $effect(() =>
    onTask((msg) => {
      if (msg.type === 'task_output' && msg.taskId === task?.taskId) {
        const pinned = !outEl || outEl.scrollHeight - outEl.scrollTop - outEl.clientHeight < 60;
        output += stripAnsi(msg.chunk);
        if (pinned) follow();
      } else if (msg.type === 'task_done' && msg.task.taskId === task?.taskId) task = { ...task, ...msg.task };
    })
  );

  const ext = (p: string) => (p?.split('.').pop() ?? '').toLowerCase();
  const letter: Record<string, string> = { added: 'A', deleted: 'D', renamed: 'R', conflict: 'U', modified: 'M' };
</script>

<div class="screen">
  <header class="topbar">
    <BackButton to={'#/s/' + encodeURIComponent(id)} label="Back to chat" />
    <div class="title">
      <b>Changes</b>
      <small>
        {#if status?.repo}<Icon name="git" size={13} /> {status.branch ?? 'detached'} · {status.files.length} file{status.files.length === 1 ? '' : 's'}
          {#if totals.a || totals.r}<span class="plus">+{totals.a}</span> <span class="minus">−{totals.r}</span>{/if}
        {:else}{basename(cwd)}{/if}
      </small>
    </div>
    <button class="iconbtn glass" onclick={load} aria-label="Refresh">{#if loading}<span class="spinner"></span>{:else}<Icon name="refresh" />{/if}</button>
  </header>

  <main class="scroller">
    <div class="column">
      <div class="segmented tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'files'} class:on={tab === 'files'} onclick={() => (tab = 'files')}>Files{status?.files?.length ? ` ${status.files.length}` : ''}</button>
        <button role="tab" aria-selected={tab === 'runs'} class:on={tab === 'runs'} onclick={() => (tab = 'runs')}>Test &amp; command output{runs.length ? ` ${runs.length}` : ''}</button>
      </div>

      {#if tab === 'files'}
        {#if error}
          <div class="empty"><h2>Could not read changes</h2><p>{error}</p></div>
        {:else if !status}
          <div class="empty"><span class="spinner" style="margin:auto"></span></div>
        {:else if !status.repo}
          <div class="empty"><h2>Not a git repository</h2><p>Changes are shown for projects tracked with git. File edits still appear inline in the chat.</p></div>
        {:else if status.files.length === 0}
          <div class="empty"><h2>No changes</h2><p>The working tree matches the last commit.</p></div>
        {:else}
          <div class="card files">
            {#each status.files as f (f.path)}
              <div class="file">
                <button class="fhead" onclick={() => toggle(f.path)} aria-expanded={openFile === f.path}>
                  <span class="k {f.kind}">{letter[f.kind] ?? 'M'}</span>
                  <span class="fp"><b>{basename(f.path)}</b><small class="mono"><bdi>{f.path}</bdi></small></span>
                  <span class="nums">{#if f.added != null}<span class="plus">+{f.added}</span> <span class="minus">−{f.removed}</span>{/if}</span>
                  <span class="chev" class:open={openFile === f.path}><Icon name="chevron" size={16} /></span>
                </button>
                {#if openFile === f.path}
                  <div class="fbody">
                    {#if !diffs[f.path]}<div class="pad"><span class="spinner"></span></div>
                    {:else if diffs[f.path].error}<div class="pad err">{diffs[f.path].error}</div>
                    {:else if !diffs[f.path].rows?.length}<div class="pad muted">No text changes to show.</div>
                    {:else}
                      <DiffRows rows={diffs[f.path].rows ?? []} lang={ext(f.path)} />
                      {#if diffs[f.path].truncated}<div class="pad muted">Diff truncated. Open the terminal for the full output.</div>{/if}
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      {:else}
        <form class="runner" onsubmit={(e) => (e.preventDefault(), taskBusy ? rpc('tasks.stop', { id: task?.taskId }).catch(() => {}) : runTask())}>
          <input class="mono" bind:value={command} placeholder="Test command, e.g. npm test" aria-label="Test command" autocapitalize="off" autocorrect="off" spellcheck="false" disabled={taskBusy} />
          <button class="btn" class:primary={!taskBusy} class:danger={taskBusy} type="submit" disabled={!taskBusy && !command.trim()}>
            <Icon name={taskBusy ? 'stop' : 'play'} size={16} /> {taskBusy ? 'Stop' : 'Run'}
          </button>
        </form>
        {#if task}
          <div class="card result">
            <div class="rhead">
              {#if taskBusy}<span class="spinner"></span> Running
              {:else if task.exitCode === 0}<span class="ok"><Icon name="check" size={15} /> Passed</span>
              {:else}<span class="bad"><Icon name="x" size={15} /> Exit {task.exitCode ?? 'signal'}</span>{/if}
              <code class="mono">{task.command}</code>
            </div>
            <pre class="out mono" bind:this={outEl}>{output || (taskBusy ? '' : 'No output.')}</pre>
            {#if task.truncated}<div class="pad muted">Output truncated. Open the terminal for the full run.</div>{/if}
            {#if !taskBusy && task.exitCode !== 0}
              <button class="btn block fix" onclick={sendToDevin}>Ask Devin to fix this</button>
            {/if}
          </div>
        {/if}
        <div class="label">Run by Devin in this session</div>
        <div class="runs">
          {#each runs as r (r.id)}<ToolCall item={r} open={r.status === 'failed'} />{:else}
            <p class="muted none">Tests, builds and other commands Devin runs show up here with their output.</p>
          {/each}
        </div>
      {/if}
    </div>
  </main>
</div>

<style>
  .column {
    display: flex;
    flex-direction: column;
    min-height: 100%;
    max-width: var(--column);
    margin-inline: auto;
    padding: 8px calc(var(--safe-right) + 16px) calc(var(--safe-bottom) + 24px) calc(var(--safe-left) + 16px);
  }
  .tabs {
    flex: none;
    margin-bottom: 16px;
  }
  .tabs button {
    flex: 1 1 auto;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
  .plus {
    color: var(--green);
  }
  .minus {
    color: var(--red);
  }
  .files {
    overflow: hidden;
  }
  .file {
    position: relative;
  }
  /* Inset hairline between files, starting at the file name. */
  .file + .file::before {
    content: '';
    position: absolute;
    top: 0;
    left: 50px;
    right: 0;
    height: 1px;
    background: var(--line);
  }
  .fhead {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 56px;
    padding: 8px 14px 8px 16px;
    text-align: left;
  }
  .k {
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 7px;
    display: grid;
    place-items: center;
    font: 600 11px var(--mono);
    background: var(--fill-2);
    color: var(--amber);
  }
  .k.added {
    color: var(--green);
  }
  .k.deleted,
  .k.conflict {
    color: var(--red);
  }
  .fp {
    flex: 1;
    min-width: 0;
  }
  .fp b {
    display: block;
    font-weight: 600;
    font-size: 15px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fp small {
    display: block;
    font-size: 11.5px;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }
  .nums {
    flex: none;
    font: 12px var(--mono);
    font-variant-numeric: tabular-nums;
  }
  .chev {
    display: grid;
    color: var(--text-3);
    transition: transform 0.2s var(--ease-out);
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .fbody {
    margin: 0 10px 10px;
    border-radius: var(--r-md);
    background: var(--bg);
    overflow: hidden;
  }
  .pad {
    padding: 14px 16px;
    font-size: 13.5px;
  }
  .err {
    color: var(--red);
  }
  .runs {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .none {
    font-size: 13.5px;
    margin: 0;
    padding: 4px 6px;
  }
  .runner {
    display: flex;
    gap: 8px;
  }
  .runner input {
    flex: 1;
    min-width: 0;
    min-height: 46px;
    padding: 0 18px;
    border-radius: 999px;
    border: 0;
    background: var(--fill);
    font-size: 16px;
    outline: none;
    transition: box-shadow 0.18s ease;
  }
  .runner input:focus {
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .runner .btn {
    flex: none;
  }
  .runner .btn:not(.primary) {
    background: var(--fill);
  }
  .result {
    flex: none;
    margin-top: 12px;
    overflow: hidden;
  }
  .rhead {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 48px;
    padding: 10px 16px;
    font-size: 14px;
    font-weight: 600;
    border-bottom: 1px solid var(--line);
  }
  .rhead span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: none;
  }
  .rhead code {
    font-size: 12px;
    font-weight: 400;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ok {
    color: var(--green);
  }
  .bad {
    color: var(--red);
  }
  .out {
    margin: 0;
    padding: 12px 16px;
    max-height: 42vh;
    overflow: auto;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--text-2);
  }
  .fix {
    margin: 0 12px 12px;
    width: calc(100% - 24px);
    background: var(--fill);
  }
</style>
