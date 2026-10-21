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

  // Inicialização do xterm.js
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

  // Atualizador de status visual
  function updateStatus(state, message) {
    statusIndicator.className = 'status-indicator ' + state;
    statusText.textContent = message;

    if (state === 'connected') {
      btnConnect.disabled = true;
      btnDisconnect.disabled = false;
      term.focus();
    } else if (state === 'disconnected' || state === 'error') {
      btnConnect.disabled = false;
      btnDisconnect.disabled = true;
    } else if (state === 'connecting') {
      btnConnect.disabled = true;
      btnDisconnect.disabled = false;
    }
  }

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
      if (info.status === 'connected') {
        updateStatus('connected', info.message);
        term.writeln(`\r\n\x1b[32m[${info.message}]\x1b[0m\r\n`);
      } else if (info.status === 'disconnected') {
        updateStatus('disconnected', info.message);
        term.writeln(`\r\n\x1b[31m[${info.message}]\x1b[0m\r\n`);
      } else {
        updateStatus(info.status, info.message);
      }
    });

    // 3. Tratamento de erros
    window.terminalAPI.onError((err) => {
      updateStatus('error', `Erro (${err.stage}): ${err.error}`);
      term.writeln(`\r\n\x1b[1;31m[Erro SSH - ${err.stage}]: ${err.error}\x1b[0m\r\n`);
    });
  }
});
