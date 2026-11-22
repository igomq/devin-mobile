<script lang="ts">
  import { untrack } from 'svelte';
  import { conn, rpc, onTask, errorText } from '#lib/api.svelte.ts';
  import type { TaskRun, ToolItem } from '#lib/types.ts';
  import { go, toast } from '#lib/ui.svelte.ts';
  import Icon from '../Icon.svelte';
  import ToolCall from '../ToolCall.svelte';

  let { id, cwd, runs }: { id: string; cwd: string | null | undefined; runs: ToolItem[] } = $props();

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
</script>

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

<style>
  .pad {
    padding: 14px 16px;
    font-size: 13.5px;
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
