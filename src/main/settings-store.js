/**
 * settings-store.js - Preferências de aparência e comportamento do terminal.
 *
 * As preferências vêm da interface, são gravadas em disco e depois alimentam
 * diretamente as opções do xterm.js. Isso faz delas entrada não confiável em
 * dois sentidos: o arquivo pode ser editado à mão ou corromper, e um valor
 * inválido chegando ao xterm.js quebra a renderização. Por isso tudo passa por
 * `sanitize()`, que descarta o que não reconhece em vez de propagar.
 *
 * Sem dependência do Electron de propósito: recebe o caminho do arquivo por
 * parâmetro, o que o torna testável fora do app.
 */
const fs = require('fs/promises');
const path = require('path');

const CURSOR_STYLES = ['block', 'underline', 'bar'];
const INACTIVE_CURSOR_STYLES = ['outline', 'block', 'bar', 'underline', 'none'];
const FONT_WEIGHTS = ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900'];

// Chaves de cor que o xterm.js reconhece no objeto `theme`.
const THEME_KEYS = [
  'background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
];

/**
 * Paletas prontas. As quatro últimas são paletas abertas e amplamente
 * reimplementadas em emuladores de terminal; "Padrão" é a do protótipo.
 */
const THEME_PRESETS = {
  'Padrão': {
    background: '#181a1f', foreground: '#abb2bf', cursor: '#528bff',
    cursorAccent: '#181a1f', selectionBackground: '#3e4451',
    black: '#1e1f29', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
    blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94',
    brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df',
    brightCyan: '#a4ffff', brightWhite: '#ffffff',
  },
  'Dracula': {
    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2',
    cursorAccent: '#282a36', selectionBackground: '#44475a',
    black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
    blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94',
    brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df',
    brightCyan: '#a4ffff', brightWhite: '#ffffff',
  },
  'One Dark': {
    background: '#282c34', foreground: '#abb2bf', cursor: '#528bff',
    cursorAccent: '#282c34', selectionBackground: '#3e4451',
    black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
    blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
    brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379',
    brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd',
    brightCyan: '#56b6c2', brightWhite: '#ffffff',
  },
  'Solarized Dark': {
    background: '#002b36', foreground: '#839496', cursor: '#93a1a1',
    cursorAccent: '#002b36', selectionBackground: '#073642',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
    blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75',
    brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
  'Gruvbox Dark': {
    background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2',
    cursorAccent: '#282828', selectionBackground: '#504945',
    black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921',
    blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
    brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26',
    brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b',
    brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
  },
  'Solarized Light': {
    background: '#fdf6e3', foreground: '#657b83', cursor: '#586e75',
    cursorAccent: '#fdf6e3', selectionBackground: '#eee8d5',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
    blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75',
    brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
};

const DEFAULTS = Object.freeze({
  version: 1,
  themeName: 'Padrão',
  theme: { ...THEME_PRESETS['Padrão'] },
  font: {
    family: '"Fira Code", "Cascadia Code", Consolas, monospace',
    size: 14,
    weight: 'normal',
    weightBold: 'bold',
    lineHeight: 1,
    letterSpacing: 0,
  },
  cursor: {
    style: 'block',
    blink: true,
    inactiveStyle: 'outline',
    width: 1,
  },
  behavior: {
    scrollback: 1000,
    tabStopWidth: 8,
    scrollSensitivity: 1,
    rightClickSelectsWord: false,
    drawBoldTextInBrightColors: true,
    minimumContrastRatio: 1,
  },
});

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function isHexColor(v) {
  return typeof v === 'string' && HEX_COLOR.test(v);
}

/** Número dentro de um intervalo, ou o padrão. Rejeita NaN e Infinity. */
function num(v, { min, max, fallback, integer = false }) {
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    return fallback;
  }
  return integer ? Math.round(n) : n;
}

function oneOf(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}

function bool(v, fallback) {
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * Normaliza qualquer entrada em um objeto de preferências válido.
 *
 * Nunca lança: o que não é reconhecido volta ao padrão. Isso é deliberado —
 * um arquivo corrompido ou um campo novo de uma versão futura deve degradar
 * para o padrão, não impedir o app de abrir.
 *
 * @param {unknown} input
 * @returns {object} preferências completas e válidas
 */
function sanitize(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const rawFont = raw.font && typeof raw.font === 'object' ? raw.font : {};
  const rawCursor = raw.cursor && typeof raw.cursor === 'object' ? raw.cursor : {};
  const rawBehavior = raw.behavior && typeof raw.behavior === 'object' ? raw.behavior : {};
  const rawTheme = raw.theme && typeof raw.theme === 'object' ? raw.theme : {};

  const themeName = typeof raw.themeName === 'string' && raw.themeName in THEME_PRESETS
    ? raw.themeName
    : (typeof raw.themeName === 'string' && raw.themeName === 'Personalizado'
      ? 'Personalizado'
      : DEFAULTS.themeName);

  // O tema parte sempre de uma base completa: o xterm.js SUBSTITUI o objeto
  // theme em vez de mesclar, então um tema parcial apagaria as demais cores.
  const base = THEME_PRESETS[themeName] || THEME_PRESETS[DEFAULTS.themeName];
  const theme = {};
  for (const key of THEME_KEYS) {
    theme[key] = isHexColor(rawTheme[key]) ? rawTheme[key] : base[key];
  }

  // A família da fonte vai para dentro de CSS, então limita-se o conteúdo a
  // caracteres de nome de fonte: letras, dígitos, espaço, aspas, vírgula e
  // hífen. Chaves, ponto e vírgula ou parênteses não têm lugar aqui.
  const family = typeof rawFont.family === 'string'
    && rawFont.family.trim().length > 0
    && rawFont.family.length <= 200
    && /^[\w\s"',\-.]+$/.test(rawFont.family)
    ? rawFont.family.trim()
    : DEFAULTS.font.family;

  return {
    version: 1,
    themeName,
    theme,
    font: {
      family,
      size: num(rawFont.size, { min: 6, max: 48, fallback: DEFAULTS.font.size, integer: true }),
      weight: oneOf(rawFont.weight, FONT_WEIGHTS, DEFAULTS.font.weight),
      weightBold: oneOf(rawFont.weightBold, FONT_WEIGHTS, DEFAULTS.font.weightBold),
      lineHeight: num(rawFont.lineHeight, { min: 0.8, max: 3, fallback: DEFAULTS.font.lineHeight }),
      letterSpacing: num(rawFont.letterSpacing, { min: -2, max: 10, fallback: DEFAULTS.font.letterSpacing }),
    },
    cursor: {
      style: oneOf(rawCursor.style, CURSOR_STYLES, DEFAULTS.cursor.style),
      blink: bool(rawCursor.blink, DEFAULTS.cursor.blink),
      inactiveStyle: oneOf(rawCursor.inactiveStyle, INACTIVE_CURSOR_STYLES, DEFAULTS.cursor.inactiveStyle),
      width: num(rawCursor.width, { min: 1, max: 5, fallback: DEFAULTS.cursor.width, integer: true }),
    },
    behavior: {
      scrollback: num(rawBehavior.scrollback, { min: 0, max: 100000, fallback: DEFAULTS.behavior.scrollback, integer: true }),
      tabStopWidth: num(rawBehavior.tabStopWidth, { min: 1, max: 16, fallback: DEFAULTS.behavior.tabStopWidth, integer: true }),
      scrollSensitivity: num(rawBehavior.scrollSensitivity, { min: 0.1, max: 10, fallback: DEFAULTS.behavior.scrollSensitivity }),
      rightClickSelectsWord: bool(rawBehavior.rightClickSelectsWord, DEFAULTS.behavior.rightClickSelectsWord),
      drawBoldTextInBrightColors: bool(rawBehavior.drawBoldTextInBrightColors, DEFAULTS.behavior.drawBoldTextInBrightColors),
      minimumContrastRatio: num(rawBehavior.minimumContrastRatio, { min: 1, max: 21, fallback: DEFAULTS.behavior.minimumContrastRatio }),
    },
  };
}

/**
 * Traduz as preferências para o formato de opções do xterm.js.
 * Mantido aqui, e não no Renderer, para que a forma do objeto fique num só
 * lugar junto da validação.
 */
function toXtermOptions(settings) {
  const s = sanitize(settings);
  return {
    fontFamily: s.font.family,
    fontSize: s.font.size,
    fontWeight: s.font.weight,
    fontWeightBold: s.font.weightBold,
    lineHeight: s.font.lineHeight,
    letterSpacing: s.font.letterSpacing,
    cursorStyle: s.cursor.style,
    cursorBlink: s.cursor.blink,
    cursorInactiveStyle: s.cursor.inactiveStyle,
    cursorWidth: s.cursor.width,
    scrollback: s.behavior.scrollback,
    tabStopWidth: s.behavior.tabStopWidth,
    scrollSensitivity: s.behavior.scrollSensitivity,
    rightClickSelectsWord: s.behavior.rightClickSelectsWord,
    drawBoldTextInBrightColors: s.behavior.drawBoldTextInBrightColors,
    minimumContrastRatio: s.behavior.minimumContrastRatio,
    theme: { ...s.theme },
  };
}

class SettingsStore {
  /** @param {string} filePath - Caminho do JSON de preferências */
  constructor(filePath) {
    this.filePath = filePath;
    this.cache = null;
  }

  async load() {
    if (this.cache) {
      return this.cache;
    }

    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      this.cache = sanitize(JSON.parse(raw));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn('settings ilegível, usando padrões:', err.message);
      }
      this.cache = sanitize({});
    }

    return this.cache;
  }

  /**
   * Grava as preferências e devolve a versão normalizada, para que o Renderer
   * reflita exatamente o que foi persistido em vez do que ele enviou.
   */
  async save(input) {
    const clean = sanitize(input);

    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });

    // Gravação atômica: temporário e rename, para que uma falha no meio da
    // escrita não deixe o arquivo pela metade.
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(clean, null, 2), { mode: 0o600 });
    await fs.rename(tmpPath, this.filePath);

    this.cache = clean;
    return clean;
  }

  async reset() {
    return this.save({});
  }
}

module.exports = {
  SettingsStore,
  sanitize,
  toXtermOptions,
  DEFAULTS,
  THEME_PRESETS,
  THEME_KEYS,
  CURSOR_STYLES,
  INACTIVE_CURSOR_STYLES,
  FONT_WEIGHTS,
};
