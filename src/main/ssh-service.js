/**
 * SshService - Gerenciador do ciclo de vida da conexão SSH e stream PTY.
 * Isola a comunicação de rede e sessão segura do processo principal da UI.
 */
const { Client } = require('ssh2');
const EventEmitter = require('events');

class SshService extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.stream = null;
    this.isConnected = false;
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

    this.client = new Client();
    this.emit('status', { status: 'connecting', message: `Conectando a ${config.host}:${config.port || 22}...` });

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
        port: parseInt(config.port, 10) || 22,
        username: config.username,
        password: config.password || undefined,
        privateKey: config.privateKey || undefined,
        readyTimeout: 20000,
        keepaliveInterval: 10000,
      });
    } catch (err) {
      this.emit('error', { stage: 'init', error: err.message });
      this.disconnect();
    }
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
