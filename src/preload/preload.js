/**
 * Preload Script - Ponte segura de IPC usando contextBridge.
 * Expõe apenas métodos e eventos estritamente necessários para o Renderer,
 * sem vazar módulos de sistema Node.js.
 */
const { contextBridge, ipcRenderer } = require('electron');

/**
 * Registra um listener e devolve a função de remoção, para evitar vazamento
 * de handlers acumulados no ipcRenderer.
 */
function subscribe(channel, callback) {
  const subscription = (event, payload) => callback(payload);
  ipcRenderer.on(channel, subscription);
  return () => ipcRenderer.removeListener(channel, subscription);
}

contextBridge.exposeInMainWorld('terminalAPI', {
  // Comandos enviados do Renderer para o Main
  connect: (config) => ipcRenderer.send('ssh:connect', config),
  sendData: (data) => ipcRenderer.send('ssh:data', data),
  resize: (cols, rows) => ipcRenderer.send('ssh:resize', { cols, rows }),
  disconnect: () => ipcRenderer.send('ssh:disconnect'),

  // Resposta do usuário ao prompt de chave de host desconhecida
  respondHostKey: (accepted) => ipcRenderer.send('ssh:host-key-response', accepted),

  // Remove uma identidade registrada (reinstalação legítima do servidor)
  forgetHost: (host, port) => ipcRenderer.invoke('ssh:forget-host', { host, port }),

  // Preferências do terminal. Cada chamada devolve { settings, xterm } — as
  // preferências normalizadas pelo processo principal e as opções já no
  // formato do xterm.js.
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),

  // Listeners de eventos vindos do Main
  onIncomingData: (callback) => subscribe('ssh:incoming-data', callback),
  onStatusChange: (callback) => subscribe('ssh:status-change', callback),
  onError: (callback) => subscribe('ssh:error', callback),
  onHostKeyPrompt: (callback) => subscribe('ssh:host-key-prompt', callback),
  onHostKeyChanged: (callback) => subscribe('ssh:host-key-changed', callback),
});
