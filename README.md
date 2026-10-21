# Protótipo de Terminal SSH em Electron (Node.js + ssh2 + xterm.js)

*[English version](README.en.md)*

Cliente SSH funcional escrito para entender como clientes de terminal gráficos
(PuTTY, Bitvise, Termius) funcionam internamente. O protótipo implementa a
arquitetura desacoplada padrão de clientes de terminal baseados em Electron
(como VS Code Terminal, Hyper e Tabby).

> **Status:** protótipo de estudo, não software de produção.
> Veja [Limitações conhecidas](#5-limitações-conhecidas) antes de usar contra
> qualquer servidor que importe.

## Intuito

Passo boa parte do dia em sessões SSH contra servidores Linux e nunca havia
parado para pensar no que o cliente de terminal faz. Um cliente gráfico resolve
três problemas ao mesmo tempo:

1. **Falar o protocolo SSH** — handshake, verificação da identidade do servidor,
   autenticação, multiplexação de canais
2. **Alocar e operar um PTY** (pseudo-terminal) no host remoto, para que programas
   interativos (`vim`, `top`, `htop`) se comportem como em um TTY real
3. **Emular um terminal localmente** — interpretar sequências de escape ANSI,
   tratar redimensionamento e renderizar a grade de caracteres rápido o bastante
   para parecer instantâneo

Então reconstruí uma versão mínima para descobrir. Nada foi decompilado e nenhum
código de terceiros foi usado: o comportamento dos clientes existentes serviu de
especificação, e a implementação é própria, sobre bibliotecas abertas.

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
    participant Store as KnownHostsStore
    participant Servidor as Servidor SSH Remoto

    Usuário->>Renderer: Digita credenciais e clica em Conectar
    Renderer->>Preload: window.terminalAPI.connect(config)
    Preload->>Main: ipcRenderer.send('ssh:connect', config)
    Main->>Service: sshService.connect(config)

    Service->>Servidor: Início do handshake SSH (troca de chaves)
    Servidor-->>Service: Chave pública do host
    Service->>Service: hostVerifier(chave)
    Service->>Store: Consulta identidade registrada

    alt Chave desconhecida
        Store-->>Service: Nenhum registro
        Service-->>Renderer: host-key-prompt (tipo + impressão digital)
        Usuário->>Renderer: Confere a impressão digital e decide
        Renderer->>Service: respondHostKey(aceito)
        Service->>Store: Registra identidade, se aceita
    else Chave registrada confere
        Store-->>Service: Impressão digital idêntica
    else Chave registrada MUDOU
        Store-->>Service: Impressão digital diferente
        Service-->>Renderer: host-key-changed + erro
        Note over Service,Servidor: Conexão recusada. Nenhuma credencial é enviada.
    end

    Service->>Servidor: Autenticação (somente após host verificado)
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
  - Gerencia o ciclo de vida da conexão de rede SSH, verificação da identidade
    do host, autenticação e alocação do PTY (`client.shell`).
  - Trata redimensionamento (`stream.setWindow`) e eventos de erro e desconexão.

- **`src/main/known-hosts.js`**:
  - Calcula a impressão digital da chave do host no formato do OpenSSH e
    persiste as identidades já aceitas.
  - Sem dependência do Electron de propósito: recebe o caminho do arquivo por
    parâmetro, o que o torna testável fora do app.

- **`src/preload/preload.js`**:
  - Barreira de segurança isolando o Renderer do Node.js (`contextIsolation: true`,
    `nodeIntegration: false`).
  - Expõe a API controlada `window.terminalAPI` através de `contextBridge`.

- **`src/renderer/`**:
  - `index.html`: Layout da interface, inputs de conexão, container do terminal
    e diálogo de confirmação da identidade do host.
  - `renderer.js`: Gerenciamento do `xterm.js`, `FitAddon`, captura de entrada e
    renderização de saída.
  - `style.css`: Estilização escura de alta fidelidade para terminal.

---

## 3. Verificação da Identidade do Host

Um cliente SSH que aceita qualquer chave apresentada pelo servidor é vulnerável a
**man-in-the-middle**: quem estiver no caminho da rede pode se passar pelo
servidor, receber a senha e repassar a sessão. A criptografia do SSH não protege
contra isso por si só, porque ela garante que o canal é privado, não com *quem*
o canal foi estabelecido.

A defesa é a mesma do cliente OpenSSH: comparar a chave pública do servidor com
a que foi registrada na primeira conexão.

### Impressão digital

A chave é identificada por um hash SHA-256 em base64 sem padding, o mesmo formato
exibido pelo OpenSSH desde a versão 6.8:

```
SHA256:n0ThEr3alF1ng3rpr1ntJust4nExampl3Str1ng
```

O valor é diretamente comparável com a saída de, no servidor:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

O algoritmo da chave (`ssh-ed25519`, `ssh-rsa`, `ecdsa-sha2-nistp256`) é extraído
do próprio blob: o formato de rede SSH (RFC 4253) começa com um inteiro de 4 bytes
big-endian indicando o tamanho da string com o nome do algoritmo.

### Os três desfechos

A verificação roda **durante a troca de chaves, antes da autenticação**. Nenhuma
credencial trafega antes dela responder.

| Situação | Comportamento |
| --- | --- |
| Host conhecido, chave confere | Prossegue silenciosamente |
| Host desconhecido | Pergunta ao usuário, exibindo o algoritmo e a impressão digital (*trust on first use*) |
| Host conhecido, chave **mudou** | **Recusa a conexão.** Não pergunta |

O terceiro caso é deliberadamente inflexível. Uma chave trocada pode ser uma
reinstalação legítima do servidor, mas é também exatamente o que um ataque
produz, e não há como distinguir os dois no momento da conexão. Oferecer um botão
de "aceitar mesmo assim" transformaria a proteção em um aviso que se clica sem
ler. Para o caso legítimo, a identidade registrada precisa ser removida de forma
deliberada, via `forgetHost(host, port)`.

### Onde as identidades ficam

Em `known-hosts.json`, dentro do diretório de dados do app
(`app.getPath('userData')`), com permissão `0600`. A gravação é atômica —
arquivo temporário e `rename` — para que uma falha no meio da escrita não deixe
o store corrompido. Um JSON ilegível não impede a conexão: o store parte vazio,
o que faz o host ser tratado como desconhecido e exigir confirmação.

### Uma armadilha do `hostVerifier`

O `ssh2` chama o verificador assim:

```js
const ret = hostVerifier(key, verify);
if (ret !== undefined) verify(ret);
```

Ou seja: se a função **retornar** qualquer valor diferente de `undefined`, o
`ssh2` resolve a verificação imediatamente com esse valor. Escrever o callback
como arrow de expressão devolveria a `Promise` pendente, o `ssh2` chamaria
`verify(Promise)`, e como uma Promise não é `false`, o host seria **aceito sem
verificação alguma**. A falha seria silenciosa: nenhum erro, apenas a checagem
deixando de existir. Por isso o callback usa corpo em bloco e não retorna nada.

---

## 4. Como Executar

Requer Node.js 18 ou superior.

```bash
cd ssh-terminal-prototype
npm install
npm start
```

Preencha host, porta, usuário e senha e clique em **Conectar**. Na primeira
conexão a um servidor, confirme a impressão digital no diálogo. Teste contra um
container local ou uma VM sua.

---

## 5. Limitações conhecidas

Documentadas de propósito — este é um protótipo, e abaixo está a distância entre
ele e um cliente real:

- **Sem suporte a passphrase** para chaves privadas criptografadas: falta repassar
  a opção `passphrase` ao `ssh2`.
- **Credenciais permanecem em memória** durante a conexão e não são zeradas após
  a autenticação.
- **`sandbox: false`** no `BrowserWindow`. O `contextIsolation` e o
  `nodeIntegration: false` já isolam o Renderer, mas ativar o sandbox do Chromium
  seria mais restritivo.
- **Sem persistência de sessões**, perfis salvos, abas, SFTP ou port forwarding.
- **Sem testes automatizados no repositório.** A lógica de verificação de host foi
  exercitada manualmente nos três desfechos, mas não há suíte versionada.

---

## 6. Construído com

[Electron](https://www.electronjs.org/) ·
[ssh2](https://github.com/mscdex/ssh2) ·
[xterm.js](https://xtermjs.org/)

## Licença

MIT
