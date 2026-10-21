/**
 * SshService - Gerenciador do ciclo de vida da conexão SSH e stream PTY.
 * Isola a comunicação de rede e sessão segura do processo principal da UI.
 */
const { Client } = require('ssh2');
const EventEmitter = require('events');
const { fingerprintFromKey, keyTypeFromKey, KnownHostsStore } = require('./known-hosts');

class SshService extends EventEmitter {
  /**
   * @param {KnownHostsStore} knownHosts - Store de identidades de host já aceitas
   */
  constructor(knownHosts) {
    super();
    this.client = null;
    this.stream = null;
    this.isConnected = false;
    this.knownHosts = knownHosts;

    // Promise pendente enquanto o usuário decide sobre uma chave desconhecida.
    this.pendingHostKey = null;

    // Identifica a tentativa de conexão atual. A verificação de host envolve
    // I/O e espera pelo usuário, então pode terminar depois de a conexão já
    // ter sido cancelada — comparar a época evita agir sobre uma sessão morta.
    this.epoch = 0;
  }

  /** A tentativa de conexão que originou esta verificação ainda é a atual? */
  _isStale(epoch) {
    return epoch !== this.epoch;
  }

  /**
   * Inicia a conexão SSH e aloca o PTY interativo.
   * @param {Object} config - Configurações de conexão SSH
   * @param {string} config.host - Endereço IP ou hostname
   * @param {number} config.port - Porta SSH (padrão 22)
   * @param {string} config.username - Usuário
   * @param {string} [config.password] - Senha (opcional)
   * @param {string} [config.privateKey] - Chave privada PEM (opcional)
   * @param {number} [config.cols] - Colunas iniciais do terminal
   * @param {number} [config.rows] - Linhas iniciais do terminal
   */
  connect(config) {
    if (this.isConnected) {
      this.disconnect();
    }

    const port = parseInt(config.port, 10) || 22;
    const epoch = ++this.epoch;

    this.client = new Client();
    this.emit('status', { status: 'connecting', message: `Conectando a ${config.host}:${port}...` });

    this.client.on('ready', () => {
      this.isConnected = true;
      this.emit('status', { status: 'authenticated', message: 'Autenticado com sucesso. Abrindo shell PTY...' });

      const ptyOptions = {
        term: 'xterm-256color',
        cols: config.cols || 80,
        rows: config.rows || 24,
      };

      this.client.shell(ptyOptions, (err, stream) => {
        if (err) {
          this.emit('error', { stage: 'shell', error: err.message });
          this.disconnect();
          return;
        }

        this.stream = stream;
        this.emit('status', { status: 'connected', message: 'Sessão de terminal ativa.' });

        // Stream de dados recebidos do servidor remoto -> emite para IPC
        this.stream.on('data', (data) => {
          this.emit('data', data.toString('utf-8'));
        });

        // Fechamento do stream remoto
        this.stream.on('close', () => {
          this.emit('status', { status: 'closed', message: 'Sessão remota encerrada pelo servidor.' });
          this.disconnect();
        });
      });
    });

    this.client.on('error', (err) => {
      this.emit('error', { stage: 'transport', error: err.message });
      this.disconnect();
    });

    this.client.on('close', () => {
      if (this.isConnected) {
        this.isConnected = false;
        this.emit('status', { status: 'disconnected', message: 'Conexão SSH encerrada.' });
      }
    });

    // Inicia handshake
    try {
      this.client.connect({
        host: config.host,
        port,
        username: config.username,
        password: config.password || undefined,
        privateKey: config.privateKey || undefined,
        readyTimeout: 20000,
        keepaliveInterval: 10000,

        // Verificação da identidade do servidor. Roda durante a troca de
        // chaves, ANTES da autenticação: nenhuma credencial é enviada pela
        // rede antes desta função responder.
        //
        // Dois detalhes do contrato do ssh2 que não são óbvios:
        //
        // 1. O corpo em bloco e a AUSÊNCIA de return são obrigatórios. O ssh2
        //    faz `const ret = hostVerifier(key, verify); if (ret !== undefined)
        //    verify(ret)`. Transformar isto em arrow de expressão devolveria a
        //    Promise, o ssh2 chamaria verify(Promise), e como o valor não é
        //    `false` o host seria ACEITO sem verificação alguma. A falha seria
        //    silenciosa — não há erro, só a checagem deixando de existir.
        //
        // 2. `hostHash` fica deliberadamente sem configurar. Se definido, o
        //    ssh2 entrega a chave já com hash como string hex, e o cálculo da
        //    impressão digital no formato do OpenSSH deixa de ser possível.
        hostVerifier: (keyBuffer, callback) => {
          this._verifyHostKey(config.host, port, keyBuffer, epoch)
            .then((accepted) => callback(accepted))
            .catch((err) => {
              this.emit('error', { stage: 'hostkey', error: err.message });
              callback(false);
            });
        },
      });
    } catch (err) {
      this.emit('error', { stage: 'init', error: err.message });
      this.disconnect();
    }
  }

  /**
   * Decide se a chave apresentada pelo servidor é aceitável.
   *
   * Três desfechos possíveis, espelhando o comportamento do cliente OpenSSH:
   *   1. Host conhecido e chave confere  -> prossegue silenciosamente
   *   2. Host conhecido e chave MUDOU    -> recusa, sem perguntar ao usuário
   *   3. Host desconhecido               -> pergunta (trust on first use)
   *
   * @param {string} host
   * @param {number} port
   * @param {Buffer} keyBuffer - Chave pública do servidor, formato de rede SSH
   * @param {number} epoch - Época da tentativa de conexão que pediu a verificação
   * @returns {Promise<boolean>}
   */
  async _verifyHostKey(host, port, keyBuffer, epoch) {
    const hostId = KnownHostsStore.hostId(host, port);
    const fingerprint = fingerprintFromKey(keyBuffer);
    const keyType = keyTypeFromKey(keyBuffer);

    const known = await this.knownHosts.get(hostId);

    // A leitura do store é assíncrona: se a conexão foi cancelada nesse meio
    // tempo, encerra aqui em vez de abrir um diálogo órfão.
    if (this._isStale(epoch)) {
      return false;
    }

    // Caso 1: identidade já registrada e idêntica.
    if (known && known.fingerprint === fingerprint) {
      this.emit('status', {
        status: 'hostkey-ok',
        message: `Identidade do host confirmada (${keyType} ${fingerprint}).`,
      });
      return true;
    }

    // Caso 2: a chave mudou. Pode ser reinstalação legítima do servidor, mas é
    // também exatamente o que um ataque man-in-the-middle produz. Como não há
    // como distinguir os dois aqui, a conexão é recusada e cabe ao usuário
    // remover a entrada do store de forma deliberada.
    if (known && known.fingerprint !== fingerprint) {
      this.emit('host-key-changed', {
        hostId,
        keyType,
        expected: known.fingerprint,
        received: fingerprint,
      });
      this.emit('error', {
        stage: 'hostkey',
        error:
          `A IDENTIFICAÇÃO DO HOST REMOTO MUDOU. Esperado ${known.fingerprint}, ` +
          `recebido ${fingerprint}. Conexão recusada.`,
      });
      return false;
    }

    // Caso 3: primeiro contato. O usuário confirma a impressão digital por um
    // canal que ele confie, como rodar ssh-keygen -lf no próprio servidor.
    const accepted = await this._promptUser({ hostId, keyType, fingerprint });

    // O usuário pode levar tempo para decidir. Se a conexão já não é a atual,
    // nada é registrado nem reportado.
    if (this._isStale(epoch)) {
      return false;
    }

    if (!accepted) {
      this.emit('status', {
        status: 'hostkey-rejected',
        message: 'Chave do host rejeitada. Conexão cancelada antes do envio de credenciais.',
      });
      return false;
    }

    await this.knownHosts.add(hostId, { keyType, fingerprint });
    this.emit('status', {
      status: 'hostkey-ok',
      message: `Identidade do host registrada (${keyType} ${fingerprint}).`,
    });
    return true;
  }

  /**
   * Suspende a verificação até que o Renderer devolva a decisão do usuário.
   * @returns {Promise<boolean>}
   */
  _promptUser(info) {
    return new Promise((resolve) => {
      this.pendingHostKey = { resolve, ...info };
      this.emit('host-key-prompt', info);
    });
  }

  /**
   * Chamado pelo processo principal quando o usuário responde ao prompt.
   * @param {boolean} accepted
   */
  resolveHostKeyPrompt(accepted) {
    if (!this.pendingHostKey) {
      return;
    }

    const { resolve } = this.pendingHostKey;
    this.pendingHostKey = null;
    resolve(Boolean(accepted));
  }

  /**
   * Remove a identidade registrada de um host, para o caso legítimo de
   * reinstalação ou troca de servidor.
   */
  async forgetHost(host, port) {
    return this.knownHosts.remove(KnownHostsStore.hostId(host, parseInt(port, 10) || 22));
  }

  /**
   * Envia dados do teclado / entrada do terminal para o PTY remoto.
   * @param {string} data
   */
  sendData(data) {
    if (this.stream && this.stream.writable) {
      this.stream.write(data);
    }
  }

  /**
   * Redimensiona o pseudo-terminal (PTY) remoto sincronizando com xterm.js.
   * @param {number} cols
   * @param {number} rows
   */
  resize(cols, rows) {
    if (this.stream && typeof this.stream.setWindow === 'function') {
      try {
        this.stream.setWindow(rows, cols, 0, 0);
      } catch (err) {
        console.warn('Erro ao redimensionar PTY remoto:', err.message);
      }
    }
  }

  /**
   * Encerra a conexão SSH e limpa recursos associados.
   */
  disconnect() {
    // Invalida qualquer verificação de host em andamento desta sessão.
    this.epoch++;

    // Um prompt aberto precisa ser resolvido, ou o handshake fica suspenso
    // esperando uma Promise que nunca se completa.
    if (this.pendingHostKey) {
      const { resolve } = this.pendingHostKey;
      this.pendingHostKey = null;
      resolve(false);
    }

    if (this.stream) {
      try {
        this.stream.end();
      } catch (_) {}
      this.stream = null;
    }

    if (this.client) {
      try {
        this.client.end();
      } catch (_) {}
      this.client = null;
    }

    if (this.isConnected) {
      this.isConnected = false;
      this.emit('status', { status: 'disconnected', message: 'Desconectado.' });
    }
  }
}

module.exports = { SshService };
