/**
 * Testes do settings-store. Rodam em Node puro, sem Electron:
 *   node test/settings-store.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  SettingsStore, sanitize, toXtermOptions, DEFAULTS, THEME_PRESETS, THEME_KEYS,
} = require('../src/main/settings-store');

let passou = 0;
function ok(nome) {
  passou += 1;
  console.log(`  ok  ${nome}`);
}

// --- sanitize: estrutura ---------------------------------------------------
{
  const s = sanitize({});
  assert.deepStrictEqual(s, sanitize(undefined), 'vazio e undefined coincidem');
  assert.strictEqual(s.themeName, DEFAULTS.themeName);
  assert.strictEqual(Object.keys(s.theme).length, THEME_KEYS.length, 'tema completo');
  for (const k of THEME_KEYS) {
    assert.match(s.theme[k], /^#[0-9a-fA-F]{3,8}$/, `cor valida em ${k}`);
  }
  ok('padroes completos e bem formados');
}

// Entrada hostil não derruba nem vaza.
for (const lixo of [null, 42, 'texto', [], true, { font: 'nao-objeto' }, { theme: [] }]) {
  const s = sanitize(lixo);
  assert.strictEqual(typeof s.font.size, 'number');
  assert.strictEqual(Object.keys(s.theme).length, THEME_KEYS.length);
}
ok('entrada hostil cai nos padroes sem lancar');

// --- sanitize: numeros fora de faixa --------------------------------------
{
  assert.strictEqual(sanitize({ font: { size: 999 } }).font.size, DEFAULTS.font.size);
  assert.strictEqual(sanitize({ font: { size: 0 } }).font.size, DEFAULTS.font.size);
  assert.strictEqual(sanitize({ font: { size: -5 } }).font.size, DEFAULTS.font.size);
  assert.strictEqual(sanitize({ font: { size: NaN } }).font.size, DEFAULTS.font.size);
  assert.strictEqual(sanitize({ font: { size: Infinity } }).font.size, DEFAULTS.font.size);
  assert.strictEqual(sanitize({ font: { size: 18 } }).font.size, 18, 'valido passa');
  assert.strictEqual(sanitize({ font: { size: '20' } }).font.size, 20, 'string numerica vira numero');
  assert.strictEqual(sanitize({ font: { size: 14.7 } }).font.size, 15, 'inteiro arredonda');
  assert.strictEqual(sanitize({ behavior: { scrollback: 1e9 } }).behavior.scrollback, DEFAULTS.behavior.scrollback);
  assert.strictEqual(sanitize({ behavior: { scrollback: 0 } }).behavior.scrollback, 0, 'zero e valido');
  ok('numeros validados por faixa');
}

// --- sanitize: enums ------------------------------------------------------
{
  assert.strictEqual(sanitize({ cursor: { style: 'bar' } }).cursor.style, 'bar');
  assert.strictEqual(sanitize({ cursor: { style: 'piscante' } }).cursor.style, DEFAULTS.cursor.style);
  assert.strictEqual(sanitize({ cursor: { blink: 'sim' } }).cursor.blink, DEFAULTS.cursor.blink, 'booleano exige booleano');
  assert.strictEqual(sanitize({ cursor: { blink: false } }).cursor.blink, false);
  assert.strictEqual(sanitize({ font: { weight: '600' } }).font.weight, '600');
  assert.strictEqual(sanitize({ font: { weight: 'grosso' } }).font.weight, DEFAULTS.font.weight);
  ok('enums restritos aos valores conhecidos');
}

// --- sanitize: cores ------------------------------------------------------
{
  const s = sanitize({ theme: { background: '#000', foreground: 'red', cursor: '#aabbccdd' } });
  assert.strictEqual(s.theme.background, '#000', 'hex curto aceito');
  assert.strictEqual(s.theme.cursor, '#aabbccdd', 'hex com alfa aceito');
  assert.strictEqual(s.theme.foreground, THEME_PRESETS['Padrão'].foreground, 'nome de cor rejeitado');

  // Tentativa de injecao via valor de cor nao sobrevive.
  const mal = sanitize({ theme: { background: 'url(javascript:alert(1))' } });
  assert.strictEqual(mal.theme.background, THEME_PRESETS['Padrão'].background);
  ok('cores aceitam apenas hexadecimal');
}

// --- sanitize: tema sempre completo ---------------------------------------
{
  // O xterm.js SUBSTITUI o objeto theme; um tema parcial apagaria as cores
  // restantes, então sanitize precisa devolver todas as chaves.
  const s = sanitize({ themeName: 'Dracula', theme: { background: '#123456' } });
  assert.strictEqual(s.theme.background, '#123456', 'sobrescrita respeitada');
  assert.strictEqual(s.theme.red, THEME_PRESETS['Dracula'].red, 'resto vem do preset');
  assert.strictEqual(Object.keys(s.theme).length, THEME_KEYS.length);
  ok('tema parcial e completado pelo preset');
}

// --- sanitize: familia de fonte vai para CSS ------------------------------
{
  assert.strictEqual(sanitize({ font: { family: 'Consolas, monospace' } }).font.family, 'Consolas, monospace');
  assert.strictEqual(sanitize({ font: { family: '"Fira Code", monospace' } }).font.family, '"Fira Code", monospace');

  // O valor termina dentro de CSS, então construções perigosas caem no padrão.
  for (const mal of [
    'monospace; } body { display:none } .x {',
    'url(http://exemplo/x)',
    'expression(alert(1))',
    'a'.repeat(300),
    '',
    '   ',
    123,
  ]) {
    assert.strictEqual(sanitize({ font: { family: mal } }).font.family, DEFAULTS.font.family,
      `familia rejeitada: ${String(mal).slice(0, 25)}`);
  }
  ok('familia de fonte restrita a caracteres de nome');
}

// --- themeName ------------------------------------------------------------
{
  assert.strictEqual(sanitize({ themeName: 'Gruvbox Dark' }).themeName, 'Gruvbox Dark');
  assert.strictEqual(sanitize({ themeName: 'Personalizado' }).themeName, 'Personalizado');
  assert.strictEqual(sanitize({ themeName: 'Inexistente' }).themeName, DEFAULTS.themeName);
  assert.strictEqual(sanitize({ themeName: 42 }).themeName, DEFAULTS.themeName);
  ok('themeName limitado a presets ou Personalizado');
}

// --- toXtermOptions -------------------------------------------------------
{
  const o = toXtermOptions({ font: { size: 20 }, cursor: { style: 'bar' }, themeName: 'One Dark' });
  assert.strictEqual(o.fontSize, 20);
  assert.strictEqual(o.cursorStyle, 'bar');
  assert.strictEqual(o.theme.background, THEME_PRESETS['One Dark'].background);
  assert.strictEqual(Object.keys(o.theme).length, THEME_KEYS.length, 'tema completo para o xterm');

  // Chaves que o xterm.js espera, com os tipos que ele espera.
  assert.strictEqual(typeof o.fontFamily, 'string');
  assert.strictEqual(typeof o.cursorBlink, 'boolean');
  assert.strictEqual(typeof o.scrollback, 'number');
  assert.ok(!('font' in o) && !('behavior' in o), 'nao vaza a forma interna');

  // Sanitiza mesmo recebendo lixo.
  assert.strictEqual(toXtermOptions(null).fontSize, DEFAULTS.font.size);
  ok('toXtermOptions produz opcoes validas do xterm');
}

// --- SettingsStore --------------------------------------------------------
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));
  const file = path.join(dir, 'sub', 'settings.json');
  const store = new SettingsStore(file);

  // Arquivo ausente na primeira execução é esperado.
  const inicial = await store.load();
  assert.strictEqual(inicial.font.size, DEFAULTS.font.size);
  assert.ok(!fs.existsSync(file), 'load nao cria arquivo');
  ok('load sem arquivo devolve padroes');

  const salvo = await store.save({ font: { size: 18 }, themeName: 'Dracula' });
  assert.strictEqual(salvo.font.size, 18);
  assert.ok(fs.existsSync(file), 'cria o diretorio e o arquivo');
  assert.ok(!fs.existsSync(`${file}.tmp`), 'temporario removido no rename');
  ok('save grava de forma atomica e cria o diretorio');

  // save devolve o normalizado, nao o enviado.
  const devolvido = await store.save({ font: { size: 9999 } });
  assert.strictEqual(devolvido.font.size, DEFAULTS.font.size, 'devolve o valor corrigido');
  ok('save devolve a versao normalizada');

  // Persistiu de fato: outro store lendo o mesmo caminho.
  await store.save({ themeName: 'Gruvbox Dark', font: { size: 16 } });
  const outro = await new SettingsStore(file).load();
  assert.strictEqual(outro.themeName, 'Gruvbox Dark');
  assert.strictEqual(outro.font.size, 16);
  ok('preferencias sobrevivem a um novo store');

  // JSON corrompido degrada para padrões em vez de impedir a abertura.
  const ruim = path.join(dir, 'ruim.json');
  fs.writeFileSync(ruim, '{ isso nao e json');
  const degradado = await new SettingsStore(ruim).load();
  assert.strictEqual(degradado.font.size, DEFAULTS.font.size);
  ok('JSON corrompido cai nos padroes');

  // Arquivo com valores absurdos editado à mão.
  const hostil = path.join(dir, 'hostil.json');
  fs.writeFileSync(hostil, JSON.stringify({
    font: { size: 10000, family: 'x; } html { display:none } i {' },
    cursor: { style: '../../etc/passwd' },
    theme: { background: 'javascript:void(0)' },
    behavior: { scrollback: -1 },
  }));
  const limpo = await new SettingsStore(hostil).load();
  assert.strictEqual(limpo.font.size, DEFAULTS.font.size);
  assert.strictEqual(limpo.font.family, DEFAULTS.font.family);
  assert.strictEqual(limpo.cursor.style, DEFAULTS.cursor.style);
  assert.strictEqual(limpo.theme.background, THEME_PRESETS['Padrão'].background);
  assert.strictEqual(limpo.behavior.scrollback, DEFAULTS.behavior.scrollback);
  ok('arquivo editado a mao com valores hostis e saneado');

  const resetado = await store.reset();
  assert.deepStrictEqual(resetado, sanitize({}), 'reset volta aos padroes');
  ok('reset restaura os padroes');

  // DEFAULTS não deve ser mutável por referência.
  const s1 = sanitize({});
  s1.theme.background = '#ffffff';
  s1.font.size = 99;
  assert.strictEqual(sanitize({}).theme.background, THEME_PRESETS['Padrão'].background);
  assert.strictEqual(sanitize({}).font.size, DEFAULTS.font.size);
  ok('sanitize devolve objetos independentes');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passou} grupos de teste passaram.`);
})().catch((e) => {
  console.error('FALHOU:', e.message);
  process.exit(1);
});
