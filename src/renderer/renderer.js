/**
 * Renderer Process - Interface do Terminal com xterm.js
 * e integração com a ponte IPC segura exposta via preload.
 */

document.addEventListener('DOMContentLoaded', () => {
  // Elementos do DOM
  const hostInput = document.getElementById('host');
  const portInput = document.getElementById('port');
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');
  const btnConnect = document.getElementById('btnConnect');
  const btnDisconnect = document.getElementById('btnDisconnect');
  const statusIndicator = document.getElementById('statusIndicator');
  const statusText = document.getElementById('statusText');
  const terminalContainer = document.getElementById('terminalContainer');

  // Diálogo de verificação da identidade do host
  const hostKeyModal = document.getElementById('hostKeyModal');
  const hostKeyHost = document.getElementById('hostKeyHost');
  const hostKeyType = document.getElementById('hostKeyType');
  const hostKeyFingerprint = document.getElementById('hostKeyFingerprint');
  const btnAcceptHostKey = document.getElementById('btnAcceptHostKey');
  const btnRejectHostKey = document.getElementById('btnRejectHostKey');

  // Abas e painéis
  const tabTerminal = document.getElementById('tabTerminal');
  const tabOptions = document.getElementById('tabOptions');
  const panelTerminal = document.getElementById('panelTerminal');
  const panelOptions = document.getElementById('panelOptions');

  // Inicialização do xterm.js. As opções de aparência chegam do processo
  // principal logo abaixo, em initSettings().
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: '"Fira Code", "Cascadia Code", Consolas, monospace',
    fontSize: 14,
    theme: {
      background: '#181a1f',
      foreground: '#abb2bf',
      cursor: '#528bff',
      selectionBackground: '#3e4451',
      black: '#1e1f29',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
    },
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(terminalContainer);
  fitAddon.fit();

  // Mensagem inicial de boas-vindas no terminal
  term.writeln('\x1b[1;36m=== Protótipo de Terminal SSH (Electron + ssh2 + xterm.js) ===\x1b[0m');
  term.writeln('Informe os dados de conexão acima e clique em \x1b[1;32mConectar\x1b[0m.\r\n');

  // Redimensionamento sincronizado
  function handleResize() {
    fitAddon.fit();
    if (window.terminalAPI) {
      window.terminalAPI.resize(term.cols, term.rows);
    }
  }

  window.addEventListener('resize', handleResize);

  // Envio de entrada de teclado para o PTY remoto via IPC
  term.onData((data) => {
    if (window.terminalAPI) {
      window.terminalAPI.sendData(data);
    }
  });

  // Estados que têm indicador visual próprio no CSS. Os demais reaproveitam
  // o estado mais próximo para não deixar o indicador sem cor.
  const INDICATOR_STATE = {
    connected: 'connected',
    connecting: 'connecting',
    authenticated: 'connecting',
    'hostkey-ok': 'connecting',
    disconnected: 'disconnected',
    closed: 'disconnected',
    'hostkey-rejected': 'error',
    error: 'error',
  };

  // Atualizador de status visual
  function updateStatus(state, message) {
    statusIndicator.className = 'status-indicator ' + (INDICATOR_STATE[state] || 'disconnected');
    statusText.textContent = message;

    if (state === 'connected') {
      btnConnect.disabled = true;
      btnDisconnect.disabled = false;
      term.focus();
    } else if (state === 'disconnected' || state === 'error' || state === 'hostkey-rejected') {
      btnConnect.disabled = false;
      btnDisconnect.disabled = true;
    } else if (state === 'connecting') {
      btnConnect.disabled = true;
      btnDisconnect.disabled = false;
    }
  }

  // Exibe o diálogo de confirmação e devolve a decisão ao processo principal.
  function openHostKeyPrompt({ hostId, keyType, fingerprint }) {
    hostKeyHost.textContent = hostId;
    hostKeyType.textContent = keyType;
    hostKeyFingerprint.textContent = fingerprint;
    hostKeyModal.classList.remove('hidden');
    btnRejectHostKey.focus();
  }

  function closeHostKeyPrompt(accepted) {
    if (hostKeyModal.classList.contains('hidden')) {
      return;
    }

    hostKeyModal.classList.add('hidden');
    if (window.terminalAPI) {
      window.terminalAPI.respondHostKey(accepted);
    }
  }

  // Esconde o diálogo sem responder — para quando a conexão já foi encerrada
  // por outro caminho e a decisão deixou de ser necessária.
  function hideHostKeyPrompt() {
    hostKeyModal.classList.add('hidden');
  }

  btnAcceptHostKey.addEventListener('click', () => closeHostKeyPrompt(true));
  btnRejectHostKey.addEventListener('click', () => closeHostKeyPrompt(false));

  // Escape fecha o diálogo recusando — o caminho seguro por padrão.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeHostKeyPrompt(false);
    }
  });

  // Ações dos botões
  btnConnect.addEventListener('click', () => {
    const host = hostInput.value.trim();
    const port = parseInt(portInput.value.trim(), 10) || 22;
    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    if (!host || !username) {
      alert('Por favor, informe ao menos o Host e o Usuário.');
      return;
    }

    updateStatus('connecting', `Conectando a ${host}:${port}...`);
    term.writeln(`\r\n\x1b[33m[Conectando a ${host}:${port} como '${username}']...\x1b[0m`);

    if (window.terminalAPI) {
      window.terminalAPI.connect({
        host,
        port,
        username,
        password,
        cols: term.cols,
        rows: term.rows,
      });
    }
  });

  btnDisconnect.addEventListener('click', () => {
    if (window.terminalAPI) {
      window.terminalAPI.disconnect();
    }
  });

  // Conexão com os eventos expostos pela ponte IPC (Preload)
  if (window.terminalAPI) {
    // 1. Dados recebidos do servidor SSH -> escreve no xterm
    window.terminalAPI.onIncomingData((data) => {
      term.write(data);
    });

    // 2. Mudança de status da conexão
    window.terminalAPI.onStatusChange((info) => {
      updateStatus(info.status, info.message);

      if (info.status === 'connected') {
        hideHostKeyPrompt();
        term.writeln(`\r\n\x1b[32m[${info.message}]\x1b[0m\r\n`);
      } else if (info.status === 'disconnected') {
        hideHostKeyPrompt();
        term.writeln(`\r\n\x1b[31m[${info.message}]\x1b[0m\r\n`);
      } else if (info.status === 'hostkey-ok') {
        term.writeln(`\x1b[36m[${info.message}]\x1b[0m`);
      } else if (info.status === 'hostkey-rejected') {
        term.writeln(`\r\n\x1b[33m[${info.message}]\x1b[0m\r\n`);
      }
    });

    // 3. Tratamento de erros
    window.terminalAPI.onError((err) => {
      updateStatus('error', `Erro (${err.stage}): ${err.error}`);
      term.writeln(`\r\n\x1b[1;31m[Erro SSH - ${err.stage}]: ${err.error}\x1b[0m\r\n`);
    });

    // 4. Host desconhecido: confirmação antes de enviar credenciais
    window.terminalAPI.onHostKeyPrompt((info) => {
      term.writeln(`\r\n\x1b[33m[Aguardando confirmação da identidade de ${info.hostId}]\x1b[0m`);
      openHostKeyPrompt(info);
    });

    // 5. Chave de um host conhecido mudou: alerta explícito no terminal
    window.terminalAPI.onHostKeyChanged((info) => {
      term.writeln('\r\n\x1b[1;41;97m  ATENÇÃO: A IDENTIFICAÇÃO DO HOST REMOTO MUDOU  \x1b[0m');
      term.writeln('\x1b[1;31mIsso pode indicar um ataque man-in-the-middle.\x1b[0m');
      term.writeln(`\x1b[31mHost:      \x1b[0m${info.hostId}`);
      term.writeln(`\x1b[31mEsperado:  \x1b[0m${info.expected}`);
      term.writeln(`\x1b[31mRecebido:  \x1b[0m${info.received}`);
      term.writeln(
        '\x1b[33mSe a chave do servidor mudou por um motivo legítimo, remova a ' +
          'identidade registrada antes de reconectar.\x1b[0m\r\n'
      );
    });
  }

  /* =========================================================================
     Abas
     ========================================================================= */

  let previewTerm = null;
  let previewFit = null;

  function showTab(which) {
    const isTerminal = which === 'terminal';

    panelTerminal.classList.toggle('hidden', !isTerminal);
    panelOptions.classList.toggle('hidden', isTerminal);
    tabTerminal.classList.toggle('active', isTerminal);
    tabOptions.classList.toggle('active', !isTerminal);
    tabTerminal.setAttribute('aria-selected', String(isTerminal));
    tabOptions.setAttribute('aria-selected', String(!isTerminal));

    if (isTerminal) {
      // O xterm mede errado enquanto está em um container oculto, então o
      // refit acontece ao voltar para a aba, não ao sair dela.
      handleResize();
      term.focus();
    } else {
      ensurePreview();
    }
  }

  tabTerminal.addEventListener('click', () => showTab('terminal'));
  tabOptions.addEventListener('click', () => showTab('options'));

  /* =========================================================================
     Preferências
     ========================================================================= */

  // Famílias oferecidas. Os valores precisam passar pela validação do
  // settings-store, que aceita apenas caracteres de nome de fonte.
  const FONT_FAMILIES = [
    ['Fira Code', '"Fira Code", "Cascadia Code", Consolas, monospace'],
    ['Cascadia Mono', '"Cascadia Mono", Consolas, monospace'],
    ['JetBrains Mono', '"JetBrains Mono", Consolas, monospace'],
    ['Consolas', 'Consolas, monospace'],
    ['Courier New', '"Courier New", monospace'],
    ['Padrão do sistema', 'monospace'],
  ];

  const FONT_WEIGHTS = ['normal', '300', '400', '500', '600', 'bold', '800'];
  const CURSOR_STYLES = [['Bloco', 'block'], ['Sublinhado', 'underline'], ['Barra', 'bar']];
  const INACTIVE_STYLES = [
    ['Contorno', 'outline'], ['Bloco', 'block'], ['Barra', 'bar'],
    ['Sublinhado', 'underline'], ['Nenhum', 'none'],
  ];

  // Rótulos das cores do tema. A ordem define a grade.
  const COLOR_LABELS = {
    background: 'Fundo', foreground: 'Texto', cursor: 'Cursor',
    cursorAccent: 'Contraste do cursor', selectionBackground: 'Seleção',
    black: 'Preto', red: 'Vermelho', green: 'Verde', yellow: 'Amarelo',
    blue: 'Azul', magenta: 'Magenta', cyan: 'Ciano', white: 'Branco',
    brightBlack: 'Preto claro', brightRed: 'Vermelho claro',
    brightGreen: 'Verde claro', brightYellow: 'Amarelo claro',
    brightBlue: 'Azul claro', brightMagenta: 'Magenta claro',
    brightCyan: 'Ciano claro', brightWhite: 'Branco claro',
  };

  // Barra de amostra das paletas: cores representativas, não todas as 21.
  const SWATCH_KEYS = ['background', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'foreground'];

  const el = {
    presetGrid: document.getElementById('presetGrid'),
    colorGrid: document.getElementById('colorGrid'),
    fontFamily: document.getElementById('fontFamily'),
    fontSize: document.getElementById('fontSize'),
    fontWeight: document.getElementById('fontWeight'),
    fontWeightBold: document.getElementById('fontWeightBold'),
    lineHeight: document.getElementById('lineHeight'),
    letterSpacing: document.getElementById('letterSpacing'),
    cursorStyle: document.getElementById('cursorStyle'),
    cursorInactiveStyle: document.getElementById('cursorInactiveStyle'),
    cursorWidth: document.getElementById('cursorWidth'),
    cursorBlink: document.getElementById('cursorBlink'),
    scrollback: document.getElementById('scrollback'),
    tabStopWidth: document.getElementById('tabStopWidth'),
    scrollSensitivity: document.getElementById('scrollSensitivity'),
    minimumContrastRatio: document.getElementById('minimumContrastRatio'),
    rightClickSelectsWord: document.getElementById('rightClickSelectsWord'),
    drawBoldTextInBrightColors: document.getElementById('drawBoldTextInBrightColors'),
    btnReset: document.getElementById('btnResetOptions'),
    saved: document.getElementById('optSaved'),
    previewContainer: document.getElementById('previewContainer'),
  };

  let settings = null;
  let presets = {};

  function fillSelect(select, pairs) {
    select.replaceChildren();
    for (const entry of pairs) {
      const [label, value] = Array.isArray(entry) ? entry : [entry, entry];
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      select.appendChild(opt);
    }
  }

  /** Aplica as opções a um terminal. O tema vai inteiro: o xterm substitui. */
  function applyToTerminal(target, xterm) {
    for (const [key, value] of Object.entries(xterm)) {
      try {
        target.options[key] = value;
      } catch (err) {
        console.warn(`Opção ignorada pelo xterm: ${key}`, err.message);
      }
    }
  }

  /**
   * Aplica ao terminal principal e à pré-visualização.
   *
   * O refit depois é obrigatório: mudar fonte, altura de linha ou espaçamento
   * altera quantas colunas e linhas cabem, e o PTY remoto precisa saber disso
   * ou programas de tela cheia continuam desenhando nas dimensões antigas.
   */
  function applyEverywhere(xterm) {
    applyToTerminal(term, xterm);

    if (!panelTerminal.classList.contains('hidden')) {
      handleResize();
    }

    if (previewTerm) {
      applyToTerminal(previewTerm, xterm);
      try {
        previewFit.fit();
      } catch (_) {}
    }
  }

  let saveTimer = null;
  let savedTimer = null;

  function flashSaved() {
    el.saved.textContent = 'Salvo';
    el.saved.classList.add('visible');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => el.saved.classList.remove('visible'), 1400);
  }

  /**
   * Aplica na hora e persiste com atraso. A gravação é adiada porque um
   * controle de arrastar dispara dezenas de eventos por segundo, e cada um
   * seria uma escrita em disco.
   */
  function commit() {
    applyEverywhere(toXtermLocal(settings));

    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      if (!window.terminalAPI) {
        return;
      }
      try {
        const res = await window.terminalAPI.saveSettings(settings);
        // O processo principal normaliza: adota-se o que ele devolveu, não o
        // que foi enviado, para que a interface mostre o que está em disco.
        settings = res.settings;
        applyEverywhere(res.xterm);
        renderForm();
        flashSaved();
      } catch (err) {
        console.warn('Falha ao salvar preferências:', err.message);
      }
    }, 250);
  }

  /**
   * Espelho local de toXtermOptions, para aplicar antes do ida e volta ao
   * processo principal. A validação continua sendo a de lá, que é a que vale.
   */
  function toXtermLocal(s) {
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

  function renderPresets() {
    el.presetGrid.replaceChildren();

    for (const [name, palette] of Object.entries(presets)) {
      const btn = document.createElement('button');
      btn.className = 'swatch' + (settings.themeName === name ? ' active' : '');
      btn.type = 'button';

      const label = document.createElement('span');
      label.className = 'swatch-name';
      label.textContent = name;
      btn.appendChild(label);

      const bar = document.createElement('span');
      bar.className = 'swatch-colors';
      for (const key of SWATCH_KEYS) {
        const cell = document.createElement('span');
        cell.style.backgroundColor = palette[key];
        bar.appendChild(cell);
      }
      btn.appendChild(bar);

      btn.addEventListener('click', () => {
        settings.themeName = name;
        settings.theme = { ...palette };
        commit();
      });

      el.presetGrid.appendChild(btn);
    }
  }

  function renderColors() {
    el.colorGrid.replaceChildren();

    for (const [key, label] of Object.entries(COLOR_LABELS)) {
      const item = document.createElement('label');
      item.className = 'color-item';

      const input = document.createElement('input');
      input.type = 'color';
      // <input type="color"> só aceita #rrggbb; valores com alfa ou de três
      // dígitos precisam ser expandidos para a exibição.
      input.value = toSixDigitHex(settings.theme[key]);

      const text = document.createElement('span');
      text.textContent = label;

      input.addEventListener('input', () => {
        settings.theme[key] = input.value;
        // Editar uma cor isolada deixa de ser um preset.
        settings.themeName = 'Personalizado';
        commit();
      });

      item.append(input, text);
      el.colorGrid.appendChild(item);
    }
  }

  function toSixDigitHex(value) {
    if (typeof value !== 'string') {
      return '#000000';
    }
    const hex = value.replace('#', '');
    if (hex.length === 3) {
      return '#' + hex.split('').map((c) => c + c).join('');
    }
    return '#' + hex.slice(0, 6).padEnd(6, '0');
  }

  /** Reflete o estado atual nos controles, sem disparar eventos. */
  function renderForm() {
    el.fontFamily.value = settings.font.family;
    el.fontSize.value = settings.font.size;
    el.fontWeight.value = settings.font.weight;
    el.fontWeightBold.value = settings.font.weightBold;
    el.lineHeight.value = settings.font.lineHeight;
    el.letterSpacing.value = settings.font.letterSpacing;

    el.cursorInactiveStyle.value = settings.cursor.inactiveStyle;
    el.cursorWidth.value = settings.cursor.width;
    el.cursorBlink.checked = settings.cursor.blink;

    el.scrollback.value = settings.behavior.scrollback;
    el.tabStopWidth.value = settings.behavior.tabStopWidth;
    el.scrollSensitivity.value = settings.behavior.scrollSensitivity;
    el.minimumContrastRatio.value = settings.behavior.minimumContrastRatio;
    el.rightClickSelectsWord.checked = settings.behavior.rightClickSelectsWord;
    el.drawBoldTextInBrightColors.checked = settings.behavior.drawBoldTextInBrightColors;

    document.getElementById('fontSizeOut').value = `${settings.font.size}px`;
    document.getElementById('lineHeightOut').value = settings.font.lineHeight.toFixed(2);
    document.getElementById('letterSpacingOut').value = `${settings.font.letterSpacing}px`;
    document.getElementById('cursorWidthOut').value = `${settings.cursor.width}px`;
    document.getElementById('scrollSensitivityOut').value = settings.behavior.scrollSensitivity.toFixed(1);
    document.getElementById('minimumContrastRatioOut').value = settings.behavior.minimumContrastRatio.toFixed(1);

    for (const btn of el.cursorStyle.querySelectorAll('button')) {
      btn.classList.toggle('active', btn.dataset.value === settings.cursor.style);
    }

    for (const sw of el.presetGrid.querySelectorAll('.swatch')) {
      const name = sw.querySelector('.swatch-name').textContent;
      sw.classList.toggle('active', name === settings.themeName);
    }

    for (const input of el.colorGrid.querySelectorAll('input[type="color"]')) {
      const label = input.parentElement.querySelector('span').textContent;
      const key = Object.keys(COLOR_LABELS).find((k) => COLOR_LABELS[k] === label);
      if (key) {
        input.value = toSixDigitHex(settings.theme[key]);
      }
    }
  }

  function bindControls() {
    fillSelect(el.fontFamily, FONT_FAMILIES);
    fillSelect(el.fontWeight, FONT_WEIGHTS);
    fillSelect(el.fontWeightBold, FONT_WEIGHTS);
    fillSelect(el.cursorInactiveStyle, INACTIVE_STYLES);

    // Controle segmentado do estilo do cursor
    el.cursorStyle.replaceChildren();
    for (const [label, value] of CURSOR_STYLES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.dataset.value = value;
      btn.addEventListener('click', () => {
        settings.cursor.style = value;
        renderForm();
        commit();
      });
      el.cursorStyle.appendChild(btn);
    }

    // Mapeia cada controle ao caminho que ele altera nas preferências.
    const bindings = [
      [el.fontFamily, 'change', (v) => { settings.font.family = v; }],
      [el.fontSize, 'input', (v) => { settings.font.size = Number(v); }],
      [el.fontWeight, 'change', (v) => { settings.font.weight = v; }],
      [el.fontWeightBold, 'change', (v) => { settings.font.weightBold = v; }],
      [el.lineHeight, 'input', (v) => { settings.font.lineHeight = Number(v); }],
      [el.letterSpacing, 'input', (v) => { settings.font.letterSpacing = Number(v); }],
      [el.cursorInactiveStyle, 'change', (v) => { settings.cursor.inactiveStyle = v; }],
      [el.cursorWidth, 'input', (v) => { settings.cursor.width = Number(v); }],
      [el.scrollback, 'input', (v) => { settings.behavior.scrollback = Number(v); }],
      [el.tabStopWidth, 'input', (v) => { settings.behavior.tabStopWidth = Number(v); }],
      [el.scrollSensitivity, 'input', (v) => { settings.behavior.scrollSensitivity = Number(v); }],
      [el.minimumContrastRatio, 'input', (v) => { settings.behavior.minimumContrastRatio = Number(v); }],
    ];

    for (const [node, evt, setter] of bindings) {
      node.addEventListener(evt, () => {
        setter(node.value);
        renderForm();
        commit();
      });
    }

    const switches = [
      [el.cursorBlink, (v) => { settings.cursor.blink = v; }],
      [el.rightClickSelectsWord, (v) => { settings.behavior.rightClickSelectsWord = v; }],
      [el.drawBoldTextInBrightColors, (v) => { settings.behavior.drawBoldTextInBrightColors = v; }],
    ];

    for (const [node, setter] of switches) {
      node.addEventListener('change', () => {
        setter(node.checked);
        commit();
      });
    }

    el.btnReset.addEventListener('click', async () => {
      if (!window.terminalAPI) {
        return;
      }
      const res = await window.terminalAPI.resetSettings();
      settings = res.settings;
      applyEverywhere(res.xterm);
      renderPresets();
      renderColors();
      renderForm();
      flashSaved();
    });
  }

  /**
   * Cria a pré-visualização na primeira vez que a aba é aberta. Criar antes
   * disso mediria o container oculto e sairia com dimensões erradas.
   */
  function ensurePreview() {
    if (previewTerm) {
      previewFit.fit();
      return;
    }

    previewTerm = new Terminal({ disableStdin: true, cursorBlink: true, scrollback: 0 });
    previewFit = new FitAddon.FitAddon();
    previewTerm.loadAddon(previewFit);
    previewTerm.open(el.previewContainer);

    applyToTerminal(previewTerm, toXtermLocal(settings));
    previewFit.fit();

    // Amostra com as 16 cores ANSI e saída típica de terminal.
    const linha = (base) => Array.from({ length: 8 }, (_, i) => `\x1b[${base + i}m  `).join('') + '\x1b[0m';
    previewTerm.writeln('\x1b[1;32malfred@servidor\x1b[0m:\x1b[1;34m~/projetos\x1b[0m$ ls -la');
    previewTerm.writeln('drwxr-xr-x  4 alfred  staff   \x1b[1;34msrc\x1b[0m');
    previewTerm.writeln('-rw-r--r--  1 alfred  staff   \x1b[33mREADME.md\x1b[0m');
    previewTerm.writeln('');
    previewTerm.writeln(linha(40));
    previewTerm.writeln(linha(100));
    previewTerm.write('\x1b[1;32malfred@servidor\x1b[0m:\x1b[1;34m~/projetos\x1b[0m$ ');
  }

  /** Carrega as preferências e as aplica antes de a interface ficar utilizável. */
  async function initSettings() {
    if (!window.terminalAPI || !window.terminalAPI.getSettings) {
      return;
    }

    try {
      const res = await window.terminalAPI.getSettings();
      settings = res.settings;
      presets = res.presets || {};

      bindControls();
      renderPresets();
      renderColors();
      renderForm();
      applyEverywhere(res.xterm);
    } catch (err) {
      console.warn('Falha ao carregar preferências:', err.message);
    }
  }

  initSettings();
});
