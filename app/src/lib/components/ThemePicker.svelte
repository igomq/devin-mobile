<script lang="ts">
  import { ACCENTS, FAMILIES, getTheme, isCustomAccent } from '#lib/themes.ts';
  import type { Theme } from '#lib/themes.ts';
  import { activeTheme, prefs, setAccent, setFollowSystem, setTheme } from '#lib/ui.svelte.ts';
  import Icon from './Icon.svelte';

  let query = $state('');
  const fold = (value: string) => value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  const families = $derived.by(() => {
    const words = fold(query).trim().split(/\s+/).filter(Boolean);
    return FAMILIES.map(({ name, variants }) => ({
      name,
      variants: variants.filter((variant) => {
        const searchable = fold(`${name} ${variant.name} ${variant.appearance}`);
        return words.every((word) => searchable.includes(word));
      })
    })).filter(({ variants }) => variants.length);
  });

  function selected(theme: Theme) {
    if (!prefs.followSystem) return theme.id === prefs.theme;
    return theme.id === (theme.appearance === 'light' ? prefs.lightTheme : prefs.darkTheme);
  }

  function themeName(id: string) {
    const { family, name } = getTheme(id);
    return `${family} ${name}`;
  }

  const custom = $derived(isCustomAccent(prefs.accent));
  const themeAccent = $derived(activeTheme().tokens.accent);
</script>

<div class="label appearance-label">Appearance</div>
<div class="card appearance">
  <label class="row">
    <span>Match system appearance</span>
    <input type="checkbox" role="switch" checked={prefs.followSystem}
      onchange={(event) => setFollowSystem(event.currentTarget.checked)} />
  </label>
  {#if prefs.followSystem}
    <div class="row slot"><span>Light</span><span>{themeName(prefs.lightTheme)}</span></div>
    <div class="row slot"><span>Dark</span><span>{themeName(prefs.darkTheme)}</span></div>
  {/if}
</div>
<p class="muted system-note">Reduce Transparency, Reduce Motion, and Increase Contrast follow your system settings.</p>

<div class="label">Accent</div>
<div class="card accents" role="group" aria-label="Accent">
  <button class="accent-option" aria-pressed={prefs.accent === 'theme'} onclick={() => setAccent('theme')}>
    <span class="swatch" style:--swatch={themeAccent} aria-hidden="true"></span> Theme
  </button>
  {#each ACCENTS as { id, name, color } (id)}
    <button class="accent-option" aria-pressed={prefs.accent === id} onclick={() => setAccent(id)}
      aria-label={name} title={name}>
      <span class="swatch" style:--swatch={color} aria-hidden="true"></span>
    </button>
  {/each}
  <label class="accent-option custom" class:chosen={custom}>
    <input type="color" aria-label={custom ? 'Custom accent (selected)' : 'Custom accent'}
      value={custom ? prefs.accent : themeAccent} oninput={(event) => setAccent(event.currentTarget.value)} />
    <span class="swatch" style:--swatch={custom ? prefs.accent : 'var(--fill-2)'} aria-hidden="true">
      {#if !custom}<Icon name="plus" size={15} />{/if}
    </span>
    Custom
  </label>
</div>

<div class="label">Themes</div>
<label class="search">
  <Icon name="search" size={19} />
  <input type="search" placeholder="Search themes" aria-label="Search themes" bind:value={query} />
</label>
{#each families as { name, variants } (name)}
  <h3 class="label family">{name}</h3>
  <div class="card family-card" role="group" aria-label={name}>
    {#each variants as theme (theme.id)}
      <button class="row theme" aria-pressed={selected(theme)}
        aria-label={`${theme.family} ${theme.name}${theme.name.toLowerCase() === theme.appearance ? '' : `, ${theme.appearance}`}`}
        onclick={() => setTheme(theme.id)}>
        <span class="preview" aria-hidden="true"
          style:--preview-bg={theme.tokens.bg} style:--preview-text={theme.tokens.text} style:--preview-accent={theme.tokens.accent}>
          Aa
        </span>
        <span class="variant">{theme.name}</span>
        <span class="kind">{theme.appearance}</span>
        <span class="check" aria-hidden="true">
          {#if selected(theme)}<Icon name="check" size={18} />{/if}
        </span>
      </button>
    {/each}
  </div>
{:else}
  <p class="muted no-results" role="status">No themes match “{query.trim()}”.</p>
{/each}

<style>
  .appearance-label {
    margin-top: 8px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 48px;
    padding: 8px 14px;
    text-align: left;
    font-size: 15px;
  }
  .row + .row {
    border-top: 1px solid var(--line);
  }
  .appearance > .row {
    justify-content: space-between;
  }
  .appearance > label {
    cursor: pointer;
    border-radius: var(--r-lg);
  }
  .slot {
    color: var(--text-2);
  }
  .slot > :last-child {
    color: var(--text);
    text-align: right;
  }
  input[type='checkbox'] {
    appearance: none;
    position: relative;
    flex: none;
    width: 46px;
    height: 28px;
    margin: 0;
    cursor: pointer;
    border: 1px solid var(--line-strong);
    border-radius: 999px;
    background: var(--bg-elev2);
    color: var(--text);
  }
  input[type='checkbox']::after {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 20px;
    height: 20px;
    border-radius: inherit;
    background: currentColor;
    transition: transform 0.2s var(--ease-out);
  }
  input[type='checkbox']:checked {
    background: var(--accent);
    color: var(--on-accent);
  }
  input[type='checkbox']:checked::after {
    transform: translateX(18px);
  }
  .system-note {
    margin: 8px 6px 0;
    font-size: 13px;
  }
  .accents {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    padding: 5px 8px;
  }
  .accent-option {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-width: 44px;
    min-height: 44px;
    padding: 0 8px;
    border-radius: var(--r-sm);
    font-size: 14px;
    cursor: pointer;
  }
  .swatch {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border: 1px solid var(--line-strong);
    border-radius: 50%;
    background: var(--swatch);
  }
  .accent-option[aria-pressed='true'] .swatch,
  .chosen .swatch {
    outline: 2px solid var(--accent-text);
    outline-offset: 2px;
  }
  .accent-option:active {
    background: var(--accent-soft);
  }
  .custom input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }
  .custom:has(:focus-visible) {
    outline: 2px solid var(--accent-text);
    outline-offset: 2px;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 48px;
    padding: 0 14px;
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    background: var(--bg-input);
    color: var(--text-2);
  }
  .search:focus-within {
    outline: 2px solid var(--accent-text);
    outline-offset: 2px;
  }
  .search input {
    flex: 1;
    min-width: 0;
    min-height: 46px;
    background: transparent;
    color: var(--text);
    border: 0;
    padding: 0;
    outline: none;
    font-size: 16px;
  }
  .search input::placeholder {
    color: var(--text-2);
  }
  .family {
    margin-top: 16px;
  }
  .theme {
    min-height: 48px;
  }
  .theme:first-child {
    border-top-left-radius: inherit;
    border-top-right-radius: inherit;
  }
  .theme:last-child {
    border-bottom-left-radius: inherit;
    border-bottom-right-radius: inherit;
  }
  .theme:active {
    background: var(--accent-soft);
  }
  .theme:focus-visible {
    outline-offset: -2px;
  }
  .preview {
    flex: none;
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    border: 1px solid var(--line-strong);
    background: var(--preview-bg);
    color: var(--preview-text);
    font: 600 11px var(--mono);
    text-decoration: underline 2px var(--preview-accent);
    text-underline-offset: 3px;
  }
  .variant {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .kind {
    color: var(--text-2);
    font-size: 13px;
    text-transform: capitalize;
  }
  .check {
    display: grid;
    place-items: center;
    flex: 0 0 18px;
    color: var(--accent-text);
  }
  .no-results {
    margin: 16px 6px 0;
    overflow-wrap: anywhere;
    font-size: 14px;
  }
</style>
