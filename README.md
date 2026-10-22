# Protótipo de Terminal SSH em Electron (Node.js + ssh2 + xterm.js)

*[English version](README.en.md)*

Cliente SSH funcional escrito para entender como clientes de terminal gráficos
(PuTTY, Bitvise, Termius) funcionam internamente. O protótipo implementa a
arquitetura desacoplada padrão de clientes de terminal baseados em Electron
(como VS Code Terminal, Hyper e Tabby).

> **Status:** protótipo de estudo, não software de produção.
> Veja [Limitações conhecidas](#7-limitações-conhecidas) antes de usar contra
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

- **`src/main/settings-store.js`**:
  - Preferências de aparência e comportamento do terminal: padrões, paletas
    prontas, validação e persistência.
  - Traduz as preferências para o formato de opções do `xterm.js`, para que o
    Renderer não precise conhecer o formato da biblioteca.

- **`src/preload/preload.js`**:
  - Barreira de segurança isolando o Renderer do Node.js (`contextIsolation: true`,
    `nodeIntegration: false`).
  - Expõe a API controlada `window.terminalAPI` através de `contextBridge`.

- **`src/renderer/`**:
  - `index.html`: Layout da interface, inputs de conexão, abas, container do
    terminal, painel de preferências e diálogo de confirmação da identidade do
    host.
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

## 4. Isolamento do Renderer e CSP

A verificação de host protege contra um servidor falso. Esta seção trata do lado
oposto: impedir que código não confiável execute dentro da própria janela.

O Renderer tem acesso a `window.terminalAPI.sendData()`. Script arbitrário
executando ali não alcança o Node — o `contextIsolation` impede isso — mas
alcança a ponte, e portanto consegue **digitar comandos na sessão SSH ativa**.
A superfície relevante não é o sistema de arquivos, é o terminal do usuário.

Duas medidas fecham isso:

**Assets locais, não CDN.** O `xterm.js` e o `FitAddon` são carregados do
`node_modules`, não de um CDN. Baixar o próprio código executável pela rede, sem
verificação de integridade, é a mesma classe de problema que a verificação de
host resolve, só do outro lado: um CDN comprometido ou uma requisição
interceptada injetam JavaScript direto no Renderer. Como efeito colateral, o app
passa a funcionar offline — relevante para um cliente SSH, já que muitos
servidores administrados por SSH estão em redes restritas.

**Content Security Policy restritiva**, declarada em `<meta>` no `index.html`:

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
font-src 'self'; img-src 'self' data:
```

`default-src 'none'` nega tudo por padrão e cada diretiva libera o mínimo.
A ausência de `connect-src` é intencional e é uma consequência direta da
arquitetura: o Renderer não faz requisição de rede alguma, porque o socket SSH
vive no processo principal.

A única permissão frouxa é `'unsafe-inline'` em `style-src`, e é necessária: o
`xterm.js` cria dois elementos `<style>` em tempo de execução, um para as
dimensões do terminal e outro para o tema. Elementos `<style>` injetados por
script são bloqueados pelo CSP sem essa permissão, e como quem os cria é a
biblioteca, não há como usar nonce. A exceção libera CSS inline, não execução de
código — bem menos grave que o equivalente em `script-src`.

> O Electron emite um aviso no console quando o Renderer não tem CSP. O aviso
> informa que não aparece mais no app empacotado, o que é verdade — mas é só o
> aviso que desaparece, não o risco.

---

## 5. Painel de preferências

A aba **Options** permite customizar a aparência e o comportamento do terminal:
paleta de cores (seis prontas, mais as 21 cores editáveis uma a uma), família,
tamanho, peso, altura de linha e espaçamento da fonte, estilo e piscar do cursor,
e comportamentos como histórico, largura do tab e contraste mínimo.

As mudanças são aplicadas ao vivo, no terminal principal e numa
pré-visualização, e persistem em `settings.json` no diretório de dados do app.

### Validação na fronteira

As preferências saem da interface, vão para o disco e voltam alimentando
diretamente as opções do `xterm.js`. São, portanto, entrada não confiável por
dois caminhos: o arquivo pode ser editado à mão ou corromper, e um valor
inválido chegando ao `xterm.js` quebra a renderização.

Por isso toda a validação vive no processo principal, em `sanitize()`, e não no
Renderer. Números são checados por faixa, enumerações contra listas conhecidas,
cores contra hexadecimal, e a família da fonte contra um conjunto restrito de
caracteres — ela termina dentro de CSS, então `monospace; } body { display:none
} .x {` não pode passar. O que não é reconhecido volta ao padrão em vez de
propagar.

O `save` devolve a versão já normalizada, e a interface adota o que voltou em
vez do que enviou. Digitar 999999999 no histórico faz o campo mostrar 1000.

### Dois detalhes do xterm.js que moldaram o código

**O objeto `theme` é substituído, não mesclado.** Enviar um tema parcial apaga
as cores que ficaram de fora, então `sanitize()` sempre completa as 21 chaves a
partir da paleta base antes de entregar.

**Mudar a fonte não redimensiona sozinho.** Alterar tamanho, altura de linha ou
espaçamento muda quantas colunas e linhas cabem, mas o `fit()` precisa ser
chamado — e o PTY remoto precisa ser avisado com `resize()`, ou programas de
tela cheia continuam desenhando nas dimensões antigas. É a mesma lição do
redimensionamento de janela, por outro caminho.

A pré-visualização é criada na primeira vez que a aba é aberta, e o terminal
principal só refaz o `fit` ao voltar para a aba dele: o `xterm.js` mede errado
dentro de um container oculto.

---

## 6. Como Executar

Requer Node.js 18 ou superior.

```bash
cd ssh-terminal-prototype
npm install
npm start
```

```bash
npm test     # verificação de host e validação de preferências
```

Preencha host, porta, usuário e senha e clique em **Conectar**. Na primeira
conexão a um servidor, confirme a impressão digital no diálogo. Teste contra um
container local ou uma VM sua.

### Se o `npm start` falhar com "Electron failed to install correctly"

A partir do npm 11.20, scripts de instalação ficam bloqueados por padrão e
exigem aprovação por pacote. O pacote `electron` no npm é só um stub: o binário
de verdade é baixado por um `postinstall`. Com o script bloqueado, o
`npm install` **termina com sucesso** (`exit 0`, `info ok`) sem baixar nada, e a
falha só aparece no `npm start`.

```bash
npm install-scripts approve electron
rm -rf node_modules/electron        # Windows: Remove-Item -Recurse -Force node_modules\electron
npm install
```

A remoção da pasta é necessária: aprovar não reexecuta o script de um pacote já
instalado, porque o npm considera a árvore satisfeita e não refaz nada.

Os outros dois scripts bloqueados, de `ssh2` e `cpu-features`, podem continuar
bloqueados. Servem para compilar o `cpu-features`, que é opcional.

---

## 7. Limitações conhecidas

Documentadas de propósito — este é um protótipo, e abaixo está a distância entre
ele e um cliente real:

- **Sem suporte a passphrase** para chaves privadas criptografadas: falta repassar
  a opção `passphrase` ao `ssh2`.
- **Credenciais permanecem em memória** durante a conexão e não são zeradas após
  a autenticação.
- **`cpu-features` não compilado.** É dependência nativa opcional do `ssh2` e
  exige `node-gyp`. O `ssh2` funciona sem ela, usando o caminho em JavaScript
  puro.
- **Sem persistência de sessões**, perfis salvos, abas, SFTP ou port forwarding.
- **Cobertura de testes parcial.** `npm test` cobre a verificação de identidade
  de host e a validação de preferências, ambos em Node puro. A interface é
  verificada manualmente.

---

## 8. Construído com

[Electron](https://www.electronjs.org/) ·
[ssh2](https://github.com/mscdex/ssh2) ·
[xterm.js](https://xtermjs.org/)

## Licença

MIT
