/**
 * Preload Script - Ponte segura de IPC usando contextBridge.
 * Expõe apenas métodos e eventos estritamente necessários para o Renderer,
 * sem vazar módulos de sistema Node.js.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('terminalAPI', {
  // Comandos enviados do Renderer para o Main
  connect: (config) => ipcRenderer.send('ssh:connect', config),
  sendData: (data) => ipcRenderer.send('ssh:data', data),
  resize: (cols, rows) => ipcRenderer.send('ssh:resize', { cols, rows }),
  disconnect: () => ipcRenderer.send('ssh:disconnect'),

  // Listeners de eventos vindos do Main
  onIncomingData: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('ssh:incoming-data', subscription);
    return () => ipcRenderer.removeListener('ssh:incoming-data', subscription);
  },

  onStatusChange: (callback) => {
    const subscription = (event, info) => callback(info);
    ipcRenderer.on('ssh:status-change', subscription);
    return () => ipcRenderer.removeListener('ssh:status-change', subscription);
  },

  onError: (callback) => {
    const subscription = (event, err) => callback(err);
    ipcRenderer.on('ssh:error', subscription);
    return () => ipcRenderer.removeListener('ssh:error', subscription);
  },
});
