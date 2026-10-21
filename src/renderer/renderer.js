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
});
