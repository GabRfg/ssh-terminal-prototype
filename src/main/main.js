/**
 * Main Process - Inicialização do ciclo de vida da janela Electron
 * e ponte IPC bidirecional com o serviço de SSH.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { SshService } = require('./ssh-service');
const { KnownHostsStore } = require('./known-hosts');

let mainWindow = null;
let sshService = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 700,
    minHeight: 500,
    title: 'Protótipo SSH Terminal - Electron + ssh2 + xterm.js',
    backgroundColor: '#181a1f',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.on('closed', () => {
    if (sshService) {
      sshService.disconnect();
    }
    mainWindow = null;
  });
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// Configuração dos canais de comunicação IPC
function setupIpcBridge() {
  // 1. Conexão SSH solicitada pelo Renderer
  ipcMain.on('ssh:connect', (event, config) => {
    sshService.connect(config);
  });

  // 2. Envio de dados do xterm (Renderer) -> PTY remoto
  ipcMain.on('ssh:data', (event, data) => {
    sshService.sendData(data);
  });

  // 3. Redimensionamento de janela e colunas/linhas
  ipcMain.on('ssh:resize', (event, { cols, rows }) => {
    sshService.resize(cols, rows);
  });

  // 4. Desconexão manual solicitada pelo Renderer
  ipcMain.on('ssh:disconnect', () => {
    sshService.disconnect();
  });

  // 5. Decisão do usuário sobre a chave de um host desconhecido
  ipcMain.on('ssh:host-key-response', (event, accepted) => {
    sshService.resolveHostKeyPrompt(accepted);
  });

  // 6. Remoção deliberada de uma identidade registrada
  ipcMain.handle('ssh:forget-host', async (event, { host, port }) => {
    return sshService.forgetHost(host, port);
  });

  // Relé de eventos do SshService -> Renderer (via webContents)
  sshService.on('data', (data) => sendToRenderer('ssh:incoming-data', data));
  sshService.on('status', (info) => sendToRenderer('ssh:status-change', info));
  sshService.on('error', (err) => sendToRenderer('ssh:error', err));

  // Verificação de host: pedido de confirmação e alerta de chave trocada
  sshService.on('host-key-prompt', (info) => sendToRenderer('ssh:host-key-prompt', info));
  sshService.on('host-key-changed', (info) => sendToRenderer('ssh:host-key-changed', info));
}

app.whenReady().then(() => {
  // app.getPath('userData') só está disponível depois do app pronto.
  const knownHostsPath = path.join(app.getPath('userData'), 'known-hosts.json');
  sshService = new SshService(new KnownHostsStore(knownHostsPath));

  setupIpcBridge();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (sshService) {
    sshService.disconnect();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
