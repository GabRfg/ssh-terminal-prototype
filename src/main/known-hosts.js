/**
 * known-hosts.js - Impressão digital de chaves de host e armazenamento persistente.
 *
 * Replica o papel do arquivo ~/.ssh/known_hosts do OpenSSH: guarda a identidade
 * de cada servidor já aceito, para que uma troca de chave seja detectada em
 * conexões futuras.
 *
 * Este módulo não depende do Electron de propósito — recebe o caminho do arquivo
 * por parâmetro, o que o torna testável fora do app.
 */
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

/**
 * Calcula a impressão digital da chave pública no mesmo formato que o OpenSSH
 * exibe desde a versão 6.8: "SHA256:" + base64 do hash, sem o padding '='.
 *
 * O valor é diretamente comparável com a saída de:
 *   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
 *
 * @param {Buffer} keyBuffer - Blob da chave pública no formato de rede SSH
 * @returns {string} ex: "SHA256:n0ThEr3alF1ng3rpr1ntJust4nExampl3Str1ng"
 */
function fingerprintFromKey(keyBuffer) {
  if (!Buffer.isBuffer(keyBuffer) || keyBuffer.length === 0) {
    throw new Error('Chave de host inválida ou vazia.');
  }

  const digest = crypto.createHash('sha256').update(keyBuffer).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

/**
 * Extrai o algoritmo da chave do próprio blob.
 *
 * O formato de rede SSH (RFC 4253) começa com um inteiro de 4 bytes big-endian
 * indicando o tamanho da string seguinte, que é o nome do algoritmo.
 *
 * @param {Buffer} keyBuffer
 * @returns {string} ex: "ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256"
 */
function keyTypeFromKey(keyBuffer) {
  if (!Buffer.isBuffer(keyBuffer) || keyBuffer.length < 4) {
    return 'desconhecido';
  }

  const length = keyBuffer.readUInt32BE(0);
  if (length <= 0 || length > keyBuffer.length - 4) {
    return 'desconhecido';
  }

  return keyBuffer.subarray(4, 4 + length).toString('ascii');
}

const EMPTY_STORE = { version: 1, hosts: {} };

class KnownHostsStore {
  /**
   * @param {string} filePath - Caminho do JSON de hosts conhecidos
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.cache = null;
  }

  /**
   * Monta o identificador do host. A porta entra na chave porque o mesmo
   * endereço em portas diferentes pode ser outra máquina.
   */
  static hostId(host, port) {
    return `${host}:${port}`;
  }

  async _load() {
    if (this.cache) {
      return this.cache;
    }

    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      this.cache = {
        version: parsed.version || 1,
        hosts: parsed.hosts && typeof parsed.hosts === 'object' ? parsed.hosts : {},
      };
    } catch (err) {
      // Arquivo ausente na primeira execução é esperado. JSON corrompido não
      // deve impedir a conexão: parte de um store vazio, o que faz o host ser
      // tratado como desconhecido e exige confirmação do usuário.
      if (err.code !== 'ENOENT') {
        console.warn('known-hosts ilegível, iniciando vazio:', err.message);
      }
      this.cache = { ...EMPTY_STORE, hosts: {} };
    }

    return this.cache;
  }

  /**
   * Gravação atômica: escreve em arquivo temporário e renomeia, para que uma
   * falha no meio da escrita não deixe o store corrompido.
   */
  async _save(store) {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });

    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(store, null, 2), { mode: 0o600 });
    await fs.rename(tmpPath, this.filePath);

    this.cache = store;
  }

  /**
   * @returns {Promise<{keyType: string, fingerprint: string, addedAt: string}|null>}
   */
  async get(hostId) {
    const store = await this._load();
    return store.hosts[hostId] || null;
  }

  async add(hostId, { keyType, fingerprint }) {
    const store = await this._load();
    store.hosts[hostId] = {
      keyType,
      fingerprint,
      addedAt: new Date().toISOString(),
    };
    await this._save(store);
  }

  async remove(hostId) {
    const store = await this._load();
    if (!store.hosts[hostId]) {
      return false;
    }
    delete store.hosts[hostId];
    await this._save(store);
    return true;
  }

  async list() {
    const store = await this._load();
    return Object.entries(store.hosts).map(([hostId, entry]) => ({ hostId, ...entry }));
  }
}

module.exports = { fingerprintFromKey, keyTypeFromKey, KnownHostsStore };
