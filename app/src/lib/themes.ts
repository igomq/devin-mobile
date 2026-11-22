export type Appearance = 'light' | 'dark';

type ThemeColors = {
  bg: string;
  bgElev: string;
  bgElev2: string;
  bgInput: string;
  sidebar: string;
  codeBg: string;
  text: string;
  text2: string;
  text3: string;
  accent: string;
  green: string;
  red: string;
  amber: string;
  blue: string;
};

export type ThemeTokens = ThemeColors & {
  onAccent: string;
  line: string;
  lineStrong: string;
  addBg: string;
  delBg: string;
  glass: string;
  glassHeavy: string;
  glassSolid: string;
  glassRim: string;
  glassHi: string;
  glassShadow: string;
  scrim: string;
};

const ansiKeys = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'
] as const;
type ColorTuple<T extends readonly string[]> = { [Index in keyof T]: string };
type AnsiColors = ColorTuple<typeof ansiKeys>;
type Ansi = Record<typeof ansiKeys[number] | 'foreground' | 'background' | 'cursor' | 'selectionBackground', string>;
type Syntax = Record<'comment' | 'keyword' | 'string' | 'number' | 'title' | 'type' | 'variable' | 'attr' | 'meta', string>;

export interface Theme {
  id: string;
  family: string;
  name: string;
  appearance: Appearance;
  source: string;
  tokens: ThemeTokens;
  ansi: Ansi;
  syntax: Syntax;
}

export const ACCENTS = [
  { id: 'blue', name: 'Blue', color: '#4c8dff' },
  { id: 'violet', name: 'Violet', color: '#8b6cff' },
  { id: 'teal', name: 'Teal', color: '#1fb5b0' },
  { id: 'green', name: 'Green', color: '#2fbf71' },
  { id: 'orange', name: 'Orange', color: '#ff8a3d' },
  { id: 'pink', name: 'Pink', color: '#ff5c9a' }
] as const;
export type Accent = 'theme' | typeof ACCENTS[number]['id'] | `#${string}`;
export const isCustomAccent = (value: string): value is `#${string}` => /^#[\da-f]{6}$/i.test(value);

export interface ThemePrefs {
  theme: string;
  followSystem: boolean;
  lightTheme: string;
  darkTheme: string;
  accent: Accent;
}

export const DEFAULT_THEME_PREFS: Readonly<ThemePrefs> = {
  theme: 'uniharn-dark',
  followSystem: true,
  lightTheme: 'uniharn-light',
  darkTheme: 'uniharn-dark',
  accent: 'theme'
};

const black = '#000000';
const white = '#ffffff';

function channels(color: string) {
  if (color.startsWith('#')) return [
    parseInt(color.slice(1, 3), 16),
    parseInt(color.slice(3, 5), 16),
    parseInt(color.slice(5, 7), 16),
    color.length === 9 ? parseInt(color.slice(7, 9), 16) / 255 : 1
  ];
  const [r, g, b, alpha = 1] = color.match(/[\d.]+/g)!.map(Number);
  return [r, g, b, alpha];
}

function hex(rgb: number[]) {
  return '#' + rgb.map((n) => Math.round(n).toString(16).padStart(2, '0')).join('');
}

function mix(a: string, b: string, weight: number) {
  const other = channels(b);
  return channels(a).slice(0, 3).map((n, i) => n * weight + other[i] * (1 - weight));
}

function alpha(color: string, opacity: number) {
  return `rgba(${channels(color).slice(0, 3).join(', ')}, ${opacity})`;
}

function luminance(rgb: number[]) {
  const [r, g, b] = rgb.map((n) => {
    const s = n / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast of a foreground against an opaque background. */
export function contrast(a: string, b: string) {
  const aL = luminance(mix(a, b, channels(a)[3]));
  const bL = luminance(channels(b).slice(0, 3));
  return (Math.max(aL, bL) + 0.05) / (Math.min(aL, bL) + 0.05);
}

function onAccent(colors: Pick<ThemeColors, 'bg' | 'text'>, accent: string) {
  const preferred = [colors.bg, colors.text, white].find((ink) => contrast(ink, accent) >= 4.5);
  return preferred ?? black;
}

type ColorSeed = Omit<ThemeColors, 'sidebar' | 'codeBg'> & Partial<ThemeTokens>;
type AnsiDetails = Partial<Pick<Ansi, 'foreground' | 'background' | 'cursor' | 'selectionBackground'>>;

function theme(
  id: string, family: string, name: string, appearance: Appearance, source: string,
  colors: ColorSeed, syntax: Syntax, palette: AnsiColors, terminal: AnsiDetails = {}
): Theme {
  const light = appearance === 'light';
  const tokens: ThemeTokens = {
    codeBg: colors.bgElev,
    sidebar: colors.bgElev,
    onAccent: onAccent(colors, colors.accent),
    line: alpha(colors.text, 0.08),
    lineStrong: alpha(colors.text, 0.15),
    addBg: alpha(colors.green, light ? 0.12 : 0.13),
    delBg: alpha(colors.red, light ? 0.1 : 0.13),
    glass: alpha(colors.bgElev, light ? 0.62 : 0.56),
    glassHeavy: alpha(colors.bgElev, light ? 0.86 : 0.8),
    glassSolid: colors.bgElev,
    glassRim: alpha(colors.text, light ? 0.07 : 0.1),
    glassHi: alpha(light ? colors.bgElev : colors.text, light ? 0.95 : 0.16),
    glassShadow: alpha(black, light ? 0.06 : 0.24),
    scrim: alpha(black, light ? 0.22 : 0.46),
    ...colors
  };
  const ansi: Ansi = {
    ...Object.fromEntries(ansiKeys.map((key, index) => [key, palette[index]])) as Record<typeof ansiKeys[number], string>,
    foreground: colors.text,
    background: colors.bg,
    cursor: colors.text,
    selectionBackground: alpha(colors.text, 0.24),
    ...terminal
  };
  return { id, family, name, appearance, source, tokens, ansi, syntax };
}

const uniharnSource = 'https://github.com/igomq/uniharn';
const uniharnDarkColors = {
  bg: '#111214', bgElev: '#1b1c1f', bgElev2: '#26272b', bgInput: '#1d1e22',
  text: '#f2f2f4', text2: '#abadb4', text3: '#767980', accent: '#f2f2f4',
  green: '#3ecf8e', red: '#ff6b6b', amber: '#f5b73d', blue: '#6ea8fe',
  line: 'rgba(255, 255, 255, 0.08)', lineStrong: 'rgba(255, 255, 255, 0.15)',
  glass: 'rgba(36, 37, 42, 0.56)', glassHeavy: 'rgba(30, 31, 35, 0.8)', glassSolid: '#24252a',
  glassRim: 'rgba(255, 255, 255, 0.1)', glassHi: 'rgba(255, 255, 255, 0.16)'
};
const uniharnLightColors = {
  bg: '#f2f2f6', bgElev: '#ffffff', bgElev2: '#e8e8ed', bgInput: '#ffffff',
  text: '#111113', text2: '#5b5c62', text3: '#8a8b91', accent: '#111113', onAccent: white,
  green: '#12925b', red: '#d63b3b', amber: '#b27500', blue: '#2a6fdb',
  line: 'rgba(0, 0, 0, 0.08)', lineStrong: 'rgba(0, 0, 0, 0.15)',
  glassHeavy: 'rgba(250, 250, 252, 0.86)',
  glassRim: 'rgba(0, 0, 0, 0.07)'
};

function uniharn(name: string, colors: typeof uniharnDarkColors | typeof uniharnLightColors): Theme {
  const light = name === 'Light';
  const violet = light ? '#8a3fc7' : '#c792ea';
  const { bg, bgElev2, text, text2, text3, red, green, amber, blue, lineStrong } = colors;
  return theme(`uniharn-${name.toLowerCase()}`, 'uniharn', name, light ? 'light' : 'dark', uniharnSource, colors, {
    comment: text3, keyword: violet, string: green, number: amber, title: blue,
    type: violet, variable: red, attr: green, meta: text
  }, [
    light ? text : bgElev2, red, green, amber, blue, violet, '#1fb5b0', text2,
    text3, red, green, amber, blue, violet, '#1fb5b0', light ? bg : text
  ], { background: bg, selectionBackground: lineStrong });
}

const absolutelySource = 'https://developers.openai.com/codex/app/settings';
function absolutely(
  appearance: Appearance, colors: ColorSeed, syntax: Syntax
) {
  const { bg, codeBg = bg, text, text2, red, green, amber, blue, accent } = colors;
  // Absolutely publishes editor seeds only. The ANSI slots use those seeds and
  // muted blends. Bright slots move toward the ink for the selected appearance.
  const magenta = hex(mix(syntax.type, syntax.keyword, 0.8));
  const cyan = hex(mix(blue, green, 0.7));
  const bright = (color: string) => hex(mix(color, text, 0.8));
  return theme(`absolutely-${appearance}`, 'Absolutely', appearance === 'light' ? 'Light' : 'Dark', appearance,
    absolutelySource, colors, syntax, [
      appearance === 'light' ? text : codeBg, red, green, amber, blue, magenta, cyan, text2,
      text2, bright(red), bright(green), bright(amber), bright(blue), bright(magenta), bright(cyan), text
    ], { background: codeBg, selectionBackground: alpha(accent, 0.28), cursor: text });
}

const ayuSource = 'https://github.com/ayu-theme/vscode-ayu';

// Only the named entries used from catppuccin/palette's palette.json.
type CatppuccinColors = {
  base: string; mantle: string; crust: string; surface0: string; surface1: string;
  text: string; subtext1: string; subtext0: string; overlay2: string;
  red: string; maroon: string; green: string; yellow: string; blue: string; mauve: string;
  teal: string; sky: string; rosewater: string; peach: string; lavender: string;
};
const catppuccinSource = 'https://github.com/catppuccin/palette';
function catppuccin(id: string, name: string, p: CatppuccinColors) {
  const light = id === 'latte';
  // Latte's green, yellow and peach need more contrast against its base.
  const green = light ? '#3f9e2b' : p.green;
  const yellow = light ? '#c07a19' : p.yellow;
  const peach = light ? '#ec5d0a' : p.peach;
  return theme(`catppuccin-${id}`, 'Catppuccin', name, light ? 'light' : 'dark', catppuccinSource, {
    bg: p.base, bgElev: p.mantle, bgElev2: p.surface0, bgInput: p.crust, sidebar: p.mantle, codeBg: p.base,
    text: p.text, text2: p.subtext1, text3: p.subtext0, accent: p.mauve,
    green, red: p.red, amber: yellow, blue: p.blue
  }, {
    comment: light ? p.subtext0 : p.overlay2, keyword: p.mauve, string: green,
    number: peach, title: p.blue, type: yellow, variable: p.red,
    attr: p.teal, meta: p.subtext1
  }, [
    light ? p.subtext1 : p.surface1, p.red, p.green, p.yellow, p.blue, p.mauve, p.teal, p.subtext0,
    p.overlay2, p.maroon, p.green, p.yellow, p.blue, p.lavender, p.sky, p.text
  ], { cursor: p.rosewater, selectionBackground: p.surface1 });
}

const everforestSource = 'https://github.com/sainnhe/everforest';
const githubSource = 'https://github.com/primer/github-vscode-theme';
const gruvboxSource = 'https://github.com/morhetz/gruvbox';
const linearSource = 'https://github.com/linear/linear-vscode-theme';

export const THEMES: readonly Theme[] = [
  uniharn('Dark', uniharnDarkColors),
  uniharn('Dim', {
    ...uniharnDarkColors,
    bg: '#161b26', bgElev: '#1f2534', bgElev2: '#2a3244', bgInput: '#1c2230',
    text: '#e8ecf4', text2: '#aab3c5', text3: '#7b8499', accent: '#e8ecf4',
    line: 'rgba(200, 215, 255, 0.09)', lineStrong: 'rgba(200, 215, 255, 0.16)',
    glass: 'rgba(34, 41, 56, 0.58)', glassHeavy: 'rgba(29, 35, 48, 0.82)', glassSolid: '#222a3a',
    glassRim: 'rgba(200, 215, 255, 0.1)', glassHi: 'rgba(220, 230, 255, 0.16)'
  }),
  uniharn('Light', uniharnLightColors),
  absolutely('light', {
    bg: '#f9f9f7', bgElev: '#f4f4f2', bgElev2: '#f0f0ee', bgInput: '#ededed', sidebar: '#f0f0ee', codeBg: '#ededed',
    text: '#2d2d2b', text2: '#5b5b59', text3: '#90908e', accent: '#cc7d5e',
    green: '#00a240', red: '#ba2623', amber: '#a46037', blue: '#546f83'
  }, {
    comment: '#878785', keyword: '#eb5734', string: '#009e42', number: '#eb5734', title: '#2d2d2b',
    type: '#bc7559', variable: '#ba2623', attr: '#bc7559', meta: '#5b5b59'
  }),
  absolutely('dark', {
    bg: '#2d2d2b', bgElev: '#383836', bgElev2: '#444442', bgInput: '#222220', sidebar: '#242422', codeBg: '#222220',
    text: '#f9f9f7', text2: '#b2b2b0', text3: '#929290', accent: '#cc7d5e',
    green: '#40c977', red: '#fa423e', amber: '#dda366', blue: '#85a1b5'
  }, {
    comment: '#b2b2b0', keyword: '#ff5f38', string: '#00c853', number: '#ff5f38', title: '#f9f9f7',
    type: '#d28e73', variable: '#fa423e', attr: '#d28e73', meta: '#b2b2b0'
  }),
  // VS Code's editor foregrounds can be translucent. Opaque derivatives retain their hue in UI text and xterm.
  theme('ayu-light', 'Ayu', 'Light', 'light', ayuSource, {
    bg: '#fcfcfc', bgElev: '#fafafa', bgElev2: '#f8f9fa', bgInput: '#fcfcfc', sidebar: '#f8f9fa', codeBg: '#fcfcfc',
    text: '#53575c', text2: '#5c6166', text3: '#8490a0', accent: '#f29718',
    green: '#5ca239', red: '#e65050', amber: '#c28700', blue: '#478acc',
    addBg: '#6cbf431f', delBg: '#ff73831f'
  }, {
    comment: '#919295', keyword: '#df762d', string: '#779f00', number: '#a37acc', title: '#c18600',
    type: '#209ad8', variable: '#e66c6c', attr: '#c18600', meta: '#5c6166'
  }, [
    '#000000', '#f06b6c', '#6cbf43', '#e7a100', '#21a1e2', '#a176cb', '#4abc96', '#c7c7c7',
    '#686868', '#f07171', '#86b300', '#eba400', '#22a4e6', '#a37acc', '#4cbf99', '#d1d1d1'
  ], { background: '#f8f9fa', foreground: '#5b6066', cursor: '#f29718', selectionBackground: '#035bd626' }),
  theme('ayu-dark', 'Ayu', 'Dark', 'dark', ayuSource, {
    bg: '#10141c', bgElev: '#141821', bgElev2: '#1b1f29', bgInput: '#10141c', sidebar: '#0d1017', codeBg: '#10141c',
    text: '#bfbdb6', text2: '#777e8f', text3: '#5a6673', accent: '#e6b450',
    green: '#70bf56', red: '#f26d78', amber: '#fdb04c', blue: '#4fbfff',
    addBg: '#70bf561f', delBg: '#f26d781f'
  }, {
    comment: '#5a6673', keyword: '#ff8f40', string: '#aad94c', number: '#d2a6ff', title: '#ffb454',
    type: '#59c2ff', variable: '#f07178', attr: '#ffb454', meta: '#bfbdb6'
  }, [
    '#1b1f29', '#f06b73', '#70bf56', '#fdb04c', '#4fbfff', '#d0a1ff', '#93e2c8', '#c7c7c7',
    '#686868', '#f07178', '#aad94c', '#ffb454', '#59c2ff', '#d2a6ff', '#95e6cb', '#ffffff'
  ], { background: '#0d1017', foreground: '#bebcb5', cursor: '#e6b450', selectionBackground: '#3388ff40' }),
  theme('ayu-mirage', 'Ayu', 'Mirage', 'dark', ayuSource, {
    bg: '#242936', bgElev: '#282e3b', bgElev2: '#1a1f29', bgInput: '#242936', sidebar: '#1f2430', codeBg: '#242936',
    text: '#cccac2', text2: '#8690a0', text3: '#6e7c8f', accent: '#ffcc66',
    green: '#87d96c', red: '#f27983', amber: '#fcca60', blue: '#6acdff',
    addBg: '#87d96c1f', delBg: '#f279831f'
  }, {
    comment: '#6e7c8f', keyword: '#ffa659', string: '#d5ff80', number: '#dfbfff', title: '#ffcd66',
    type: '#73d0ff', variable: '#f28779', attr: '#ffcd66', meta: '#cccac2'
  }, [
    '#171b24', '#f28273', '#87d96c', '#fcca60', '#6acdff', '#ddbbff', '#93e2c8', '#c7c7c7',
    '#686868', '#f28779', '#d5ff80', '#ffcd66', '#73d0ff', '#dfbfff', '#95e6cb', '#ffffff'
  ], { background: '#1f2430', foreground: '#cac8c1', cursor: '#ffcc66', selectionBackground: '#409fff40' }),
  catppuccin('latte', 'Latte', {
    base: '#eff1f5', mantle: '#e6e9ef', crust: '#dce0e8', surface0: '#ccd0da', surface1: '#bcc0cc',
    text: '#4c4f69', subtext1: '#5c5f77', subtext0: '#6c6f85', overlay2: '#7c7f93',
    red: '#d20f39', maroon: '#e64553', green: '#40a02b', yellow: '#df8e1d', blue: '#1e66f5', mauve: '#8839ef',
    teal: '#179299', sky: '#04a5e5', rosewater: '#dc8a78', peach: '#fe640b', lavender: '#7287fd'
  }),
  catppuccin('frappe', 'Frappé', {
    base: '#303446', mantle: '#292c3c', crust: '#232634', surface0: '#414559', surface1: '#51576d',
    text: '#c6d0f5', subtext1: '#b5bfe2', subtext0: '#a5adce', overlay2: '#949cbb',
    red: '#e78284', maroon: '#ea999c', green: '#a6d189', yellow: '#e5c890', blue: '#8caaee', mauve: '#ca9ee6',
    teal: '#81c8be', sky: '#99d1db', rosewater: '#f2d5cf', peach: '#ef9f76', lavender: '#babbf1'
  }),
  catppuccin('macchiato', 'Macchiato', {
    base: '#24273a', mantle: '#1e2030', crust: '#181926', surface0: '#363a4f', surface1: '#494d64',
    text: '#cad3f5', subtext1: '#b8c0e0', subtext0: '#a5adcb', overlay2: '#939ab7',
    red: '#ed8796', maroon: '#ee99a0', green: '#a6da95', yellow: '#eed49f', blue: '#8aadf4', mauve: '#c6a0f6',
    teal: '#8bd5ca', sky: '#91d7e3', rosewater: '#f4dbd6', peach: '#f5a97f', lavender: '#b7bdf8'
  }),
  catppuccin('mocha', 'Mocha', {
    base: '#1e1e2e', mantle: '#181825', crust: '#11111b', surface0: '#313244', surface1: '#45475a',
    text: '#cdd6f4', subtext1: '#bac2de', subtext0: '#a6adc8', overlay2: '#9399b2',
    red: '#f38ba8', maroon: '#eba0ac', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', mauve: '#cba6f7',
    teal: '#94e2d5', sky: '#89dceb', rosewater: '#f5e0dc', peach: '#fab387', lavender: '#b4befe'
  }),
  // Editor palette from the Dracula spec and ANSI slots from its Kitty port.
  theme('dracula-dark', 'Dracula', 'Dark', 'dark', 'https://draculatheme.com/spec', {
    bg: '#282a36', bgElev: '#44475a', bgElev2: '#44475a', bgInput: '#21222c', sidebar: '#21222c', codeBg: '#282a36',
    text: '#f8f8f2', text2: '#f8f8f2', text3: '#6272a4', accent: '#bd93f9',
    green: '#50fa7b', red: '#ff5555', amber: '#ffb86c', blue: '#8be9fd'
  }, {
    comment: '#6272a4', keyword: '#ff79c6', string: '#f1fa8c', number: '#bd93f9', title: '#50fa7b',
    type: '#8be9fd', variable: '#ff5555', attr: '#50fa7b', meta: '#f8f8f2'
  }, [
    '#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2',
    '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff'
  ], { selectionBackground: '#44475a' }),
  // Everforest medium, using the normal and bright slots as defined in colors/everforest.vim.
  theme('everforest-light', 'Everforest', 'Light', 'light', everforestSource, {
    bg: '#fdf6e3', bgElev: '#f4f0d9', bgElev2: '#efebd4', bgInput: '#fdf6e3', sidebar: '#efebd4', codeBg: '#fdf6e3',
    text: '#4a555b', text2: '#5c6a72', text3: '#829181', accent: '#8da101',
    green: '#859701', red: '#f85552', amber: '#b98500', blue: '#3a94c5',
    addBg: '#f0f1d2', delBg: '#fde3da'
  }, {
    comment: '#829181', keyword: '#f85552', string: '#33a077', number: '#d866b4', title: '#859701',
    type: '#b98500', variable: '#3a94c5', attr: '#33a077', meta: '#5c6a72'
  }, [
    '#5c6a72', '#f85552', '#8da101', '#dfa000', '#3a94c5', '#df69ba', '#35a77c', '#e6e2cc',
    '#5c6a72', '#f85552', '#8da101', '#dfa000', '#3a94c5', '#df69ba', '#35a77c', '#e6e2cc'
  ], { foreground: '#5c6a72', selectionBackground: '#eaedc8' }),
  theme('everforest-dark', 'Everforest', 'Dark', 'dark', everforestSource, {
    bg: '#2d353b', bgElev: '#343f44', bgElev2: '#3d484d', bgInput: '#232a2e', sidebar: '#232a2e', codeBg: '#2d353b',
    text: '#d3c6aa', text2: '#9da9a0', text3: '#859289', accent: '#a7c080',
    green: '#a7c080', red: '#e67e80', amber: '#dbbc7f', blue: '#7fbbb3',
    addBg: '#425047', delBg: '#514045'
  }, {
    comment: '#859289', keyword: '#e67e80', string: '#83c092', number: '#d699b6', title: '#a7c080',
    type: '#dbbc7f', variable: '#7fbbb3', attr: '#83c092', meta: '#d3c6aa'
  }, [
    '#475258', '#e67e80', '#a7c080', '#dbbc7f', '#7fbbb3', '#d699b6', '#83c092', '#d3c6aa',
    '#475258', '#e67e80', '#a7c080', '#dbbc7f', '#7fbbb3', '#d699b6', '#83c092', '#d3c6aa'
  ], { selectionBackground: '#543a48' }),
  // GitHub Default via src/theme.js and its pinned @primer/primitives 7.10.0.
  theme('github-light', 'GitHub', 'Light', 'light', githubSource, {
    bg: '#ffffff', bgElev: '#f6f8fa', bgElev2: '#eaeef2', bgInput: '#ffffff', sidebar: '#f6f8fa', codeBg: '#ffffff',
    text: '#1f2328', text2: '#656d76', text3: '#6e7781', accent: '#0969da',
    green: '#1a7f37', red: '#cf222e', amber: '#9a6700', blue: '#0969da',
    line: '#d0d7de', lineStrong: '#afb8c1', addBg: 'rgba(172, 238, 187, 0.3)', delBg: 'rgba(255, 206, 203, 0.3)'
  }, {
    comment: '#6e7781', keyword: '#cf222e', string: '#0a3069', number: '#0550ae', title: '#8250df',
    type: '#116329', variable: '#953800', attr: '#0550ae', meta: '#1f2328'
  }, [
    '#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781',
    '#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f'
  ], { selectionBackground: '#0969da33' }),
  theme('github-dark', 'GitHub', 'Dark', 'dark', githubSource, {
    bg: '#0d1117', bgElev: '#161b22', bgElev2: '#21262d', bgInput: '#0d1117', sidebar: '#010409', codeBg: '#0d1117',
    text: '#e6edf3', text2: '#8b949e', text3: '#6e7681', accent: '#2f81f7',
    green: '#3fb950', red: '#f85149', amber: '#d29922', blue: '#58a6ff',
    line: '#21262d', lineStrong: '#30363d', addBg: 'rgba(35, 134, 54, 0.15)', delBg: 'rgba(218, 54, 51, 0.15)'
  }, {
    comment: '#8b949e', keyword: '#ff7b72', string: '#a5d6ff', number: '#79c0ff', title: '#d2a8ff',
    type: '#7ee787', variable: '#ffa657', attr: '#79c0ff', meta: '#e6edf3'
  }, [
    '#484f58', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4',
    '#6e7681', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#ffffff'
  ], { selectionBackground: '#2f81f733' }),
  // Gruvbox uses neutral ANSI colors and switches the brights between faded and bright.
  theme('gruvbox-light', 'Gruvbox', 'Light', 'light', gruvboxSource, {
    bg: '#fbf1c7', bgElev: '#ebdbb2', bgElev2: '#d5c4a1', bgInput: '#f2e5bc', sidebar: '#ebdbb2', codeBg: '#fbf1c7',
    text: '#3c3836', text2: '#665c54', text3: '#7c6f64', accent: '#b57614',
    green: '#79740e', red: '#9d0006', amber: '#b57614', blue: '#076678'
  }, {
    comment: '#928374', keyword: '#9d0006', string: '#79740e', number: '#8f3f71', title: '#79740e',
    type: '#b57614', variable: '#076678', attr: '#076678', meta: '#427b58'
  }, [
    '#fbf1c7', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#7c6f64',
    '#928374', '#9d0006', '#79740e', '#b57614', '#076678', '#8f3f71', '#427b58', '#3c3836'
  ], { selectionBackground: '#bdae93' }),
  theme('gruvbox-dark', 'Gruvbox', 'Dark', 'dark', gruvboxSource, {
    bg: '#282828', bgElev: '#3c3836', bgElev2: '#504945', bgInput: '#32302f', sidebar: '#3c3836', codeBg: '#282828',
    text: '#ebdbb2', text2: '#bdae93', text3: '#928374', accent: '#fabd2f',
    green: '#b8bb26', red: '#fb4934', amber: '#fabd2f', blue: '#83a598'
  }, {
    comment: '#928374', keyword: '#fb4934', string: '#b8bb26', number: '#d3869b', title: '#b8bb26',
    type: '#fabd2f', variable: '#83a598', attr: '#83a598', meta: '#8ec07c'
  }, [
    '#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984',
    '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2'
  ], { selectionBackground: '#665c54' }),
  theme('linear-light', 'Linear', 'Light', 'light', linearSource, {
    bg: '#f8f8f9', bgElev: '#ffffff', bgElev2: '#eeeeef', bgInput: '#f8f8f9', sidebar: '#eeeeef', codeBg: '#f8f8f9',
    text: '#2f2f31', text2: '#5b5c5e', text3: '#909091', accent: '#6d78d5',
    green: '#1d832e', red: '#c2454d', amber: '#8a6d00', blue: '#506cdd',
    addBg: '#42bc5719', delBg: '#f24e5119'
  }, {
    comment: '#5b5c5e', keyword: '#c92da3', string: '#2f2f31', number: '#057f7f', title: '#057f7f',
    type: '#1196d0', variable: '#c45f00', attr: '#c45f00', meta: '#5b5c5e'
  }, [
    '#1b1b1b', '#c2454d', '#1d832e', '#8a6d00', '#506cdd', '#c92da3', '#057f7f', '#5b5c5e',
    '#5b5c5e', '#aa2f3b', '#006e1a', '#745a00', '#3558c6', '#b1008d', '#006a6a', '#2f2f31'
  ], { cursor: '#1b1b1b', selectionBackground: '#5a5c5d33' }),
  theme('linear-dark', 'Linear', 'Dark', 'dark', linearSource, {
    bg: '#111212', bgElev: '#202022', bgElev2: '#27282a', bgInput: '#111212', sidebar: '#09090a', codeBg: '#111212',
    text: '#e2e3e5', text2: '#949597', text3: '#626264', accent: '#5e69d1',
    green: '#81cb81', red: '#fe5c6b', amber: '#fede9e', blue: '#8ea5ff',
    addBg: '#25a54321', delBg: '#f24e512d'
  }, {
    comment: '#949597', keyword: '#f79ce0', string: '#fede9e', number: '#82dbdb', title: '#82dbdb',
    type: '#76cff6', variable: '#f6be8b', attr: '#f6be8b', meta: '#949597'
  }, [
    '#27282a', '#fe5c6b', '#81cb81', '#fede9e', '#8ea5ff', '#f79ce0', '#82dbdb', '#e2e3e5',
    '#949597', '#ff737f', '#97e296', '#fff4b3', '#a4baff', '#ffb2f6', '#98f1f1', '#ffffff'
  ], { cursor: '#ffffff', selectionBackground: '#93959633' })
];

export const FAMILIES = [...new Set(THEMES.map((theme) => theme.family))].map((name) => ({
  name, variants: THEMES.filter((theme) => theme.family === name)
}));
const themesById = new Map(THEMES.map((theme) => [theme.id, theme]));

export function getTheme(id: string) {
  return themesById.get(id) ?? THEMES[0];
}

export function resolveThemeId(prefs: ThemePrefs, systemDark: boolean) {
  if (!prefs.followSystem) return getTheme(prefs.theme).id;
  const appearance = systemDark ? 'dark' : 'light';
  const selected = themesById.get(systemDark ? prefs.darkTheme : prefs.lightTheme);
  return selected?.appearance === appearance ? selected.id : `uniharn-${appearance}`;
}

function kebab(key: string) {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

export function themeVars(theme: Theme, accent: Accent = 'theme'): Record<string, string> {
  const { tokens, ansi, syntax } = theme;
  const fill = accent === 'theme' ? tokens.accent
    : isCustomAccent(accent) ? accent
    : ACCENTS.find(({ id }) => id === accent)?.color ?? tokens.accent;
  const mono = accent === 'theme' && tokens.accent === tokens.text;
  const softWeight = mono ? 0.09 : 0.14;
  const surfaces = [tokens.bg, tokens.bgElev, tokens.bgElev2, tokens.bgInput, tokens.glassSolid];
  const backgrounds = surfaces.flatMap((surface) => [surface, hex(mix(fill, surface, softWeight))]);
  let textWeight = mono ? 0 : 80;
  while (textWeight > 0 && backgrounds.some((bg) => contrast(hex(mix(fill, tokens.text, textWeight / 100)), bg) < 4.5)) {
    textWeight -= 5;
  }

  return {
    ...Object.fromEntries(Object.entries(tokens).map(([key, color]) => [
      key === 'text2' ? '--text-2' : key === 'text3' ? '--text-3' : `--${kebab(key)}`, color
    ])),
    ...Object.fromEntries(Object.entries(ansi).map(([key, color]) => [`--ansi-${kebab(key)}`, color])),
    ...Object.fromEntries(Object.entries(syntax).map(([key, color]) => [`--syn-${key}`, color])),
    '--accent': fill,
    '--on-accent': accent === 'theme' ? tokens.onAccent : onAccent(tokens, fill),
    '--accent-soft-weight': `${softWeight * 100}%`,
    '--accent-text-weight': `${textWeight}%`
  };
}
