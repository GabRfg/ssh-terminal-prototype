// Verificação dos três caminhos do hostVerifier, fora do Electron.
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const base = require('path').join(__dirname, '..', 'src', 'main');
const { fingerprintFromKey, keyTypeFromKey, KnownHostsStore } = require(path.join(base, 'known-hosts'));
const { SshService } = require(path.join(base, 'ssh-service'));

// Blob de chave pública em formato de rede SSH: len(4) + "ssh-ed25519" + corpo.
function fakeKey(bodyByte) {
  const type = Buffer.from('ssh-ed25519', 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(type.length, 0);
  return Buffer.concat([len, type, Buffer.alloc(32, bodyByte)]);
}

const keyA = fakeKey(0x11);
const keyB = fakeKey(0x22);

// --- fingerprint e tipo ----------------------------------------------------
const fpA = fingerprintFromKey(keyA);
assert.match(fpA, /^SHA256:[A-Za-z0-9+/]{43}$/, 'formato OpenSSH SHA256');
assert.strictEqual(fingerprintFromKey(keyA), fpA, 'determinístico');
assert.notStrictEqual(fingerprintFromKey(keyB), fpA, 'chaves diferentes, fps diferentes');
assert.strictEqual(keyTypeFromKey(keyA), 'ssh-ed25519');
assert.strictEqual(keyTypeFromKey(Buffer.alloc(2)), 'desconhecido');
assert.throws(() => fingerprintFromKey(Buffer.alloc(0)));
console.log('fingerprint/keyType .............. OK');
console.log('  exemplo:', keyTypeFromKey(keyA), fpA);

// Confere contra o cálculo manual do formato OpenSSH.
const manual = 'SHA256:' + require('crypto').createHash('sha256').update(keyA).digest('base64').replace(/=+$/, '');
assert.strictEqual(fpA, manual, 'bate com sha256+base64 sem padding');
console.log('formato igual ao ssh-keygen -lf ... OK');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-'));
  const file = path.join(dir, 'known-hosts.json');
  const store = new KnownHostsStore(file);

  // --- store -------------------------------------------------------------
  assert.strictEqual(await store.get('h:22'), null, 'vazio no início');
  await store.add('h:22', { keyType: 'ssh-ed25519', fingerprint: fpA });
  assert.strictEqual((await store.get('h:22')).fingerprint, fpA);
  assert.ok(fs.existsSync(file) && !fs.existsSync(`${file}.tmp`), 'temp removido após rename');

  // Store novo lendo o mesmo arquivo: persistiu de fato.
  assert.strictEqual((await new KnownHostsStore(file).get('h:22')).fingerprint, fpA, 'persistente');
  assert.strictEqual(KnownHostsStore.hostId('srv', 2222), 'srv:2222', 'porta na chave');
  console.log('KnownHostsStore .................. OK');

  // JSON corrompido não deve lançar: parte vazio.
  const badFile = path.join(dir, 'bad.json');
  fs.writeFileSync(badFile, '{nao é json');
  assert.strictEqual(await new KnownHostsStore(badFile).get('h:22'), null, 'degrada com segurança');
  console.log('JSON corrompido .................. OK');

  // --- os três caminhos --------------------------------------------------
  function serviceOn(storePath) {
    const svc = new SshService(new KnownHostsStore(storePath));
    const events = [];
    svc.on('status', (i) => events.push(['status', i.status]));
    svc.on('error', (e) => events.push(['error', e.stage]));
    svc.on('host-key-changed', () => events.push(['host-key-changed']));
    svc.on('host-key-prompt', () => events.push(['host-key-prompt']));
    return { svc, events };
  }

  // Caso 1: host conhecido, chave confere -> aceita sem perguntar.
  {
    const { svc, events } = serviceOn(file);
    assert.strictEqual(await svc._verifyHostKey('h', 22, keyA, svc.epoch), true);
    assert.deepStrictEqual(events, [['status', 'hostkey-ok']], 'sem prompt');
    console.log('caso 1: chave confere ............ aceita');
  }

  // Caso 2: host conhecido, chave MUDOU -> recusa sem perguntar.
  {
    const { svc, events } = serviceOn(file);
    assert.strictEqual(await svc._verifyHostKey('h', 22, keyB, svc.epoch), false);
    assert.ok(events.some(([e]) => e === 'host-key-changed'));
    assert.ok(events.some(([e, s]) => e === 'error' && s === 'hostkey'));
    assert.ok(!events.some(([e]) => e === 'host-key-prompt'), 'NAO pergunta ao usuario');
    // A entrada original não foi sobrescrita.
    assert.strictEqual((await new KnownHostsStore(file).get('h:22')).fingerprint, fpA);
    console.log('caso 2: chave trocada ............ recusa, sem prompt');
  }

  // Caso 3a: host desconhecido, usuário aceita -> conecta e registra.
  {
    const f3 = path.join(dir, 'tofu-accept.json');
    const { svc, events } = serviceOn(f3);
    svc.on('host-key-prompt', () => setImmediate(() => svc.resolveHostKeyPrompt(true)));
    assert.strictEqual(await svc._verifyHostKey('novo', 22, keyA, svc.epoch), true);
    assert.ok(events.some(([e]) => e === 'host-key-prompt'), 'perguntou');
    assert.strictEqual((await new KnownHostsStore(f3).get('novo:22')).fingerprint, fpA, 'registrou');
    console.log('caso 3a: desconhecido, aceito .... conecta e registra');
  }

  // Caso 3b: host desconhecido, usuário recusa -> não conecta, não registra.
  {
    const f4 = path.join(dir, 'tofu-reject.json');
    const { svc, events } = serviceOn(f4);
    svc.on('host-key-prompt', () => setImmediate(() => svc.resolveHostKeyPrompt(false)));
    assert.strictEqual(await svc._verifyHostKey('novo', 22, keyA, svc.epoch), false);
    assert.ok(events.some(([e, s]) => e === 'status' && s === 'hostkey-rejected'));
    assert.strictEqual(await new KnownHostsStore(f4).get('novo:22'), null, 'nao registrou');
    console.log('caso 3b: desconhecido, recusado .. cancela, nao registra');
  }

  // --- disconnect resolve prompt pendente (nao deixa handshake suspenso) --
  {
    const svc = new SshService(new KnownHostsStore(path.join(dir, 'pend.json')));
    const prompted = new Promise((r) => svc.once('host-key-prompt', r));
    const pending = svc._verifyHostKey('x', 22, keyA, svc.epoch);
    await prompted;
    svc.disconnect();
    assert.strictEqual(await pending, false, 'prompt resolvido no disconnect');
    console.log('disconnect com prompt aberto ..... resolve em false');
  }

  // Cancelamento ANTES do prompt aparecer: nada de dialogo orfao.
  {
    const f5 = path.join(dir, 'cancel-early.json');
    const svc = new SshService(new KnownHostsStore(f5));
    let prompts = 0;
    svc.on('host-key-prompt', () => { prompts += 1; });
    const pending = svc._verifyHostKey('x', 22, keyA, svc.epoch);
    svc.disconnect();                      // cancela durante o I/O do store
    assert.strictEqual(await pending, false, 'recusa sem prompt');
    assert.strictEqual(prompts, 0, 'nenhum dialogo aberto');
    assert.strictEqual(await new KnownHostsStore(f5).get('x:22'), null, 'nada registrado');
    console.log('cancelado antes do prompt ........ sem dialogo orfao');
  }

  // --- forgetHost permite reconectar apos troca legitima ------------------
  {
    const svc = new SshService(new KnownHostsStore(file));
    assert.strictEqual(await svc.forgetHost('h', 22), true);
    assert.strictEqual(await svc.forgetHost('h', 22), false, 'idempotente');
    console.log('forgetHost ....................... OK');
  }

  // --- a chave e verificada ANTES da autenticacao -------------------------
  {
    const svc = new SshService(new KnownHostsStore(path.join(dir, 'order.json')));
    let authSent = false;
    svc.on('status', (i) => { if (i.status === 'authenticated') authSent = true; });
    const prompted = new Promise((r) => svc.once('host-key-prompt', r));
    const p = svc._verifyHostKey('x', 22, keyA, svc.epoch);
    await prompted;
    assert.strictEqual(authSent, false, 'nenhuma credencial antes da decisao');
    svc.resolveHostKeyPrompt(false);
    await p;
    console.log('ordem: verifica antes de autenticar OK');
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\nTodos os casos passaram.');
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });