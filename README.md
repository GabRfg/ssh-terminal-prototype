# Protótipo de Terminal SSH em Electron (Node.js + ssh2 + xterm.js)

Este protótipo implementa a arquitetura desacoplada padrão para clientes de terminal modernos baseados em Electron (como VS Code Terminal, Hyper, Tabby e Termius).

---

## 1. Arquitetura e Grafo de Comunicação IPC

```mermaid
sequenceDiagram
    autonumber
    actor Usuário
    participant Renderer as Renderer (index.html + xterm.js)
    participant Preload as Preload (contextBridge)
    participant Main as Main Process (main.js)
    participant Service as SshService (ssh2.Client)
    participant Servidor as Servidor SSH Remoto

    Usuário->>Renderer: Digita credenciais e clica em Conectar
    Renderer->>Preload: window.terminalAPI.connect(config)
    Preload->>Main: ipcRenderer.send('ssh:connect', config)
    Main->>Service: sshService.connect(config)
    Service->>Servidor: Handshake SSH + Autenticação
    Servidor-->>Service: Conexão Estabelecida (ready)
    Service->>Servidor: client.shell({ term: 'xterm-256color', cols, rows })
    Servidor-->>Service: Stream PTY interativo aberto
    Service-->>Main: emit('status', 'connected')
    Main-->>Preload: webContents.send('ssh:status-change')
    Preload-->>Renderer: callback status 'connected'

    loop Sessão Ativa
        Usuário->>Renderer: Digita comando no terminal
        Renderer->>Preload: window.terminalAPI.sendData(tecla/texto)
        Preload->>Main: ipcRenderer.send('ssh:data', data)
        Main->>Service: sshService.sendData(data)
        Service->>Servidor: stream.write(data)
        Servidor-->>Service: stream.on('data', chunk)
        Service-->>Main: emit('data', chunk)
        Main-->>Preload: webContents.send('ssh:incoming-data', chunk)
        Preload-->>Renderer: callback dados recebidos
        Renderer->>Renderer: term.write(chunk)
    end
```

---

## 2. Estrutura de Módulos

- **`src/main/main.js`**:
  - Controla o ciclo de vida do Electron (`app`, `BrowserWindow`).
  - Configura a ponte IPC (`ipcMain`).
  - Encaminha eventos assíncronos do `SshService` para o `webContents` da janela ativa.

- **`src/main/ssh-service.js`**:
  - Encapsula a biblioteca `ssh2`.
  - Gerencia o ciclo de vida da conexão de rede SSH, autenticação e alocação do PTY (`client.shell`).
  - Trata redimensionamento (`stream.setWindow`) e eventos de erro e desconexão.

- **`src/preload/preload.js`**:
  - Barreira de segurança isolando o Renderer do Node.js (`contextIsolation: true`, `nodeIntegration: false`).
  - Expõe a API controlada `window.terminalAPI` através de `contextBridge`.

- **`src/renderer/`**:
  - `index.html`: Layout da interface, inputs de conexão e container do terminal.
  - `renderer.js`: Gerenciamento do `xterm.js`, `FitAddon`, captura de entrada e renderização de saída.
  - `style.css`: Estilização escura de alta fidelidade para terminal.

---

## 3. Como Executar

```bash
cd ssh-terminal-prototype
npm install
npm start
```
