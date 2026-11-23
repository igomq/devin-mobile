<script lang="ts">
  import { ACCENTS, FAMILIES, isCustomAccent } from '#lib/themes.ts';
  import type { Appearance, Theme } from '#lib/themes.ts';
  import { activeTheme, prefs, setAccent, setFollowSystem, setTheme } from '#lib/ui.svelte.ts';
  import Icon from './Icon.svelte';

  function groups(appearance?: Appearance) {
    return FAMILIES.map(({ name, variants }) => ({
      name, variants: variants.filter((theme) => !appearance || theme.appearance === appearance)
    })).filter(({ variants }) => variants.length);
  }

  function optionName(theme: Theme, appearance?: Appearance) {
    const name = `${theme.family} ${theme.name}`;
    return appearance || theme.name.toLowerCase() === theme.appearance ? name : `${name} (${theme.appearance})`;
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
    {@render picker('Light theme', prefs.lightTheme, 'light')}
    {@render picker('Dark theme', prefs.darkTheme, 'dark')}
  {:else}
    {@render picker('Theme', prefs.theme)}
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

{#snippet picker(label: string, value: string, appearance?: Appearance)}
  <label class="row slot">
    <span>{label}</span>
    <select {value} aria-label={label} onchange={(event) => setTheme(event.currentTarget.value)}>
      {#each groups(appearance) as { name, variants } (name)}
        <optgroup label={name}>
          {#each variants as theme (theme.id)}
            <option value={theme.id}>{optionName(theme, appearance)}</option>
          {/each}
        </optgroup>
      {/each}
    </select>
  </label>
{/snippet}

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
  select {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 60%;
    min-height: 36px;
    padding: 4px 28px 4px 10px;
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
    background: var(--bg-input);
    color: var(--text);
    font-size: 15px;
    text-overflow: ellipsis;
  }
  select:focus-visible {
    outline: 2px solid var(--accent-text);
    outline-offset: 2px;
  }
</style>
