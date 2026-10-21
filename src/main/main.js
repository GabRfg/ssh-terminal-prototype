/**
 * Main Process - Inicialização do ciclo de vida da janela Electron
 * e ponte IPC bidirecional com o serviço de SSH.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { SshService } = require('./ssh-service');

let mainWindow = null;
const sshService = new SshService();

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
    sshService.disconnect();
    mainWindow = null;
  });
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

  // Relé de eventos do SshService -> Renderer (via webContents)
  sshService.on('data', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ssh:incoming-data', data);
    }
  });

  sshService.on('status', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ssh:status-change', info);
    }
  });

  sshService.on('error', (err) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ssh:error', err);
    }
  });
}

app.whenReady().then(() => {
  setupIpcBridge();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  sshService.disconnect();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
