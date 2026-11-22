# Themes

uniharn themes are design tokens applied as CSS custom properties. `app/src/lib/themes.ts` holds every variant. Each one defines surfaces, text, accent, status colors, Liquid Glass materials, 16 ANSI terminal colors and highlight.js syntax colors. `applyTheme()` in `app/src/lib/ui.svelte.ts` writes them to `:root`, so a change applies at once with no reload. `static/theme-boot.js` reapplies the last theme before the app loads, so the default theme does not flash first.

Settings → Appearance has these controls:

- **Match system appearance**: switches between a chosen light theme and a chosen dark theme.
- **Theme list**: searchable by family, variant or light/dark, with an `Aa` preview drawn in each theme's own colors.
- **Accent**: the theme's own accent, a preset, or any custom color. The text color on the accent is picked automatically so it stays readable.

Reduce Transparency, Reduce Motion and Increase Contrast follow the system settings.

## Families and sources

| Family | Variants | Source | License |
| --- | --- | --- | --- |
| uniharn | Dark, Dim, Light | This repository (the original palettes) | MIT |
| Absolutely | Light, Dark | Built-in theme of the Codex desktop app ([settings](https://developers.openai.com/codex/app/settings)); seed colors as published by the Codex theme catalog | No license published; see below |
| Ayu | Light, Dark, Mirage | [ayu-theme/vscode-ayu](https://github.com/ayu-theme/vscode-ayu) | MIT |
| Catppuccin | Latte, Frappé, Macchiato, Mocha | [catppuccin/palette](https://github.com/catppuccin/palette) | MIT |
| Dracula | Dark | [Dracula spec](https://draculatheme.com/spec), ANSI from [dracula/dracula-theme](https://github.com/dracula/dracula-theme) | MIT |
| Everforest | Light, Dark (medium) | [sainnhe/everforest](https://github.com/sainnhe/everforest) | MIT |
| GitHub | Light, Dark (default) | [primer/github-vscode-theme](https://github.com/primer/github-vscode-theme) | MIT |
| Gruvbox | Light, Dark (medium) | [morhetz/gruvbox](https://github.com/morhetz/gruvbox) | MIT/X11 |
| Linear | Light, Dark | [linear/linear-vscode-theme](https://github.com/linear/linear-vscode-theme) (official) | MIT-style |

Absolutely is a palette, not code. Only its published seed colors are used: surface, sidebar, code surface, ink, accent `#cc7d5e`, diff added/removed and the syntax seeds. The remaining tokens and the ANSI colors are derived from them. No Codex code or assets are included.

## Readability

`app/test/themes.test.ts` checks every variant on every run. Each pair below must meet the minimum WCAG contrast ratio:

| Pair | Minimum ratio |
| --- | --- |
| Text on the background | 7 |
| Secondary text | 4.5 |
| Tertiary text | 3 |
| Text on the accent | 4.5 |
| Status colors | 3 |
| Syntax colors on the code surface | 3 |
| Terminal foreground | 4.5 |

A few official colors were darkened slightly where they missed a minimum, for example Catppuccin Latte's green, yellow and peach. Glass materials use the same opacity as the original uniharn themes, tinted with each theme's surface.

## Adding a theme

Add a `theme(...)` entry to `THEMES` with colors from the theme's official source, and put its URL in `source`. Then run `npm test` in `app/`. The tests fail on missing tokens, invalid colors or low contrast.
