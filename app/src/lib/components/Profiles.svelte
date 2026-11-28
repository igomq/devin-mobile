<script lang="ts">
  import { untrack } from 'svelte';
  import { app, conn, errorText, ops, rpc } from '#lib/api.svelte.ts';
  import { route, toast } from '#lib/ui.svelte.ts';
  import { outdatedGateway } from '#lib/accounts.ts';
  import { shortHarnessName } from '#lib/labels.ts';
  import { cleanProfileInput, teamsUsingProfile, type Profile, type ProfileInput } from '#lib/operations.ts';
  import BackButton from './BackButton.svelte';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';

  let loadError = $state<string | null>(null);
  let loading = $state(false);

  async function load() {
    loading = true;
    try {
      await Promise.all([rpc('profiles.list'), rpc('teams.list')]);
      loadError = null;
    } catch (e) {
      loadError = errorText(e);
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    if (route.name === 'profiles' && conn.status === 'online' && conn.generation) untrack(load);
  });

  let usableHarnesses = $derived(app.harnesses.filter((h) => h.enabled && (h.installed || h.id === 'devin')));
  let harnessName = (id: string) => app.harnesses.find((h) => h.id === id)?.name ?? id;
  let profiles = $derived([...ops.profiles].sort((a, b) => a.name.localeCompare(b.name)));

  // The profile being edited; editingId is null for a new one.
  let sheetOpen = $state(false);
  let editingId = $state<string | null>(null);
  let draft = $state<ProfileInput>(blank());
  let saving = $state(false);
  let confirmDelete = $state(false);

  function blank(): ProfileInput {
    return { name: '', harnessId: usableHarnesses[0]?.id ?? 'devin', model: null, mode: null, effort: null, instructions: null };
  }
  function openNew() {
    editingId = null;
    draft = blank();
    confirmDelete = false;
    sheetOpen = true;
  }
  function openEdit(p: Profile) {
    editingId = p.id;
    draft = { name: p.name, harnessId: p.harnessId, model: p.model, mode: p.mode, effort: p.effort, instructions: p.instructions };
    confirmDelete = false;
    sheetOpen = true;
  }

  let harness = $derived(app.harnesses.find((h) => h.id === draft.harnessId));
  let models = $derived(harness?.models ?? []);
  let efforts = $derived(models.find((m) => m.id === draft.model)?.reasoningLevels ?? []);
  let affectedTeams = $derived(editingId ? teamsUsingProfile(editingId, ops.teams) : []);

  function pickHarness(id: string) {
    // Model and effort belong to the harness they were chosen for.
    draft.harnessId = id;
    draft.model = null;
    draft.effort = null;
  }
  function pickModel(id: string) {
    draft.model = id || null;
    const levels = models.find((m) => m.id === id)?.reasoningLevels ?? [];
    if (draft.effort && !levels.includes(draft.effort)) draft.effort = null;
  }

  async function save() {
    const profile = cleanProfileInput(draft);
    if (!profile.name) return toast('Give the profile a name.', 'error');
    saving = true;
    try {
      if (editingId) await rpc('profiles.update', { profileId: editingId, patch: profile });
      else await rpc('profiles.create', { profile });
      sheetOpen = false;
      toast(editingId ? 'Profile saved' : 'Profile created');
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      saving = false;
    }
  }

  async function remove() {
    if (!editingId) return;
    saving = true;
    try {
      await rpc('profiles.delete', { profileId: editingId });
      sheetOpen = false;
      toast('Profile deleted');
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      saving = false;
    }
  }

  function summary(p: Profile) {
    return [shortHarnessName(harnessName(p.harnessId)), p.model, p.effort].filter(Boolean).join(' · ');
  }
</script>

<div class="screen">
  <header class="topbar">
    <BackButton to="#/settings" />
    <div class="title"><b>Profiles</b></div>
    <button class="iconbtn" onclick={openNew} disabled={conn.status !== 'online' || !!loadError} aria-label="New profile" title="New profile"><Icon name="plus" /></button>
  </header>
  <main class="scroller">
    <div class="column">
      {#if loadError}
        <p class="muted detail bad">{outdatedGateway(conn.info, loadError) ?? loadError}</p>
      {:else if loading && !profiles.length}
        <div class="empty"><span class="spinner" style="margin:auto"></span></div>
      {:else if !profiles.length}
        <div class="empty">
          <h2>No profiles yet</h2>
          <p>A profile saves a harness, model, effort and standing instructions. Pick it when you start a session or build a team.</p>
          <button class="btn primary" onclick={openNew} disabled={conn.status !== 'online'}><Icon name="plus" size={18} /> New profile</button>
        </div>
      {:else}
        <div class="card list">
          {#each profiles as p (p.id)}
            <button class="prow press" onclick={() => openEdit(p)}>
              <span class="ptext">
                <b>{p.name}</b>
                <small>{summary(p)}</small>
              </span>
              <Icon name="chevron" size={16} />
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </main>
</div>

<Sheet bind:open={sheetOpen} title={editingId ? 'Edit profile' : 'New profile'} tall>
  <form class="form" onsubmit={(e) => (e.preventDefault(), save())}>
    <label class="field">
      <span>Name</span>
      <input bind:value={draft.name} placeholder="Reviewer" autocomplete="off" />
    </label>
    <label class="field">
      <span>Harness</span>
      <select value={draft.harnessId} onchange={(e) => pickHarness(e.currentTarget.value)}>
        {#each usableHarnesses as h (h.id)}<option value={h.id}>{h.name}</option>{/each}
        {#if !usableHarnesses.some((h) => h.id === draft.harnessId)}<option value={draft.harnessId}>{harnessName(draft.harnessId)} (unavailable)</option>{/if}
      </select>
    </label>
    <label class="field">
      <span>Model</span>
      {#if models.length}
        <select value={draft.model ?? ''} onchange={(e) => pickModel(e.currentTarget.value)}>
          <option value="">Harness default</option>
          {#each models as m (m.id)}<option value={m.id}>{m.name}</option>{/each}
          {#if draft.model && !models.some((m) => m.id === draft.model)}<option value={draft.model}>{draft.model}</option>{/if}
        </select>
      {:else}
        <input value={draft.model ?? ''} oninput={(e) => (draft.model = e.currentTarget.value)} placeholder="Harness default" autocapitalize="off" autocorrect="off" spellcheck="false" />
      {/if}
    </label>
    {#if efforts.length}
      <label class="field">
        <span>Effort</span>
        <select value={draft.effort ?? ''} onchange={(e) => (draft.effort = e.currentTarget.value || null)}>
          <option value="">Model default</option>
          {#each efforts as level (level)}<option value={level}>{level}</option>{/each}
        </select>
      </label>
    {/if}
    <label class="field">
      <span>Instructions</span>
      <textarea value={draft.instructions ?? ''} oninput={(e) => (draft.instructions = e.currentTarget.value)} rows="5" placeholder="Sent at the start of every session that uses this profile"></textarea>
    </label>
    <button class="btn primary block" type="submit" disabled={saving}>
      {#if saving}<span class="spinner"></span>{/if}{editingId ? 'Save' : 'Create profile'}
    </button>
    {#if editingId}
      {#if confirmDelete}
        {#if affectedTeams.length}<p class="muted detail bad">Used by {affectedTeams.map((t) => t.name).join(', ')}. Those teams stop working until you pick another profile for them.</p>{/if}
        <button class="btn block danger" type="button" onclick={remove} disabled={saving}>Delete permanently</button>
        <button class="btn block" type="button" onclick={() => (confirmDelete = false)}>Keep profile</button>
      {:else}
        <button class="btn block danger" type="button" onclick={() => (confirmDelete = true)}>Delete profile</button>
      {/if}
    {/if}
  </form>
</Sheet>

<style>
  .column {
    max-width: 640px;
    margin-inline: auto;
    padding: 0 calc(var(--safe-right) + 16px) calc(var(--safe-bottom) + 24px) calc(var(--safe-left) + 16px);
  }
  .list {
    margin-top: 12px;
    overflow: hidden;
  }
  .prow {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 60px;
    padding: 8px 16px;
    text-align: left;
    color: var(--text);
  }
  .prow + .prow {
    border-top: 1px solid var(--line);
  }
  .prow :global(svg) {
    flex: none;
    color: var(--text-3);
  }
  .ptext {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .ptext b {
    font-size: 15.5px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ptext small {
    font-size: 12.5px;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty .btn {
    margin-top: 16px;
  }
  .form {
    display: grid;
    gap: 2px;
  }
  .form .btn {
    margin-top: 8px;
    background: var(--fill);
  }
  .form .btn.primary {
    background: var(--accent);
  }
  .field select,
  .field textarea {
    width: 100%;
    min-height: 48px;
    padding: 0 16px;
    border-radius: var(--r-md);
    border: 1px solid var(--line);
    background: var(--bg-input);
    font-size: 16px;
  }
  .field textarea {
    padding: 12px 16px;
    resize: vertical;
    line-height: 1.45;
  }
  .detail {
    font-size: 13px;
    line-height: 1.45;
    margin: 8px 4px 0;
  }
  .bad {
    color: var(--amber);
  }
</style>
