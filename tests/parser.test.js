/* eslint-disable */
/**
 * Smoke tests do parser e do classificador (lê app.js, extrai a função e roda em Node).
 * Sem dependências — propositalmente puro Node.
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

// Extrai um bloco "function nome(...) { ... }" balanceando chaves
function extractFn(name) {
  const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`);
  const m = src.match(re);
  if (!m) throw new Error('função não encontrada: ' + name);
  const start = m.index;
  let i = src.indexOf('{', start);
  let depth = 1;
  i++;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return src.slice(start, i);
}

// Extrai um bloco const NAME = literal (regex ou objeto) terminando em ;
function extractConst(name) {
  // captura tudo da declaração até o ;  (com aninhamento mínimo de [ { })
  const re = new RegExp(`const\\s+${name}\\s*=\\s*([\\s\\S]*?);\\s*\\n`, 'm');
  const m = src.match(re);
  if (!m) throw new Error('const não encontrado: ' + name);
  return `const ${name} = ${m[1]};`;
}

// Monta um harness só com o que o parser/classifier precisam
const harness = `
${extractConst('AISLES')}
${extractConst('AISLE_LABELS')}
${extractConst('CMD_RE')}
${extractConst('PRE_RE')}
${extractConst('QTY_NUM')}
${extractConst('QTY_WORD')}
${extractConst('NUM_WORD')}
${extractConst('DOZEN_RE')}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

${extractFn('classifyAisle')}
${extractFn('parsePart')}
${extractFn('parseInput')}

module.exports = { parseInput, parsePart, classifyAisle };
`;

// Avalia o harness num scope isolado
const sandbox = {};
const fn = new Function('module', harness + '\nreturn module.exports;');
const m = { exports: {} };
const { parseInput, classifyAisle } = fn(m);

// ── Assertions
let failed = 0;
const eq = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
function test(name, actual, expected) {
  const ok = eq(actual, expected);
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) {
    console.log(`      esperado: ${JSON.stringify(expected)}`);
    console.log(`      recebido: ${JSON.stringify(actual)}`);
    failed++;
  }
}

console.log('\n→ parseInput');
test('texto simples', parseInput('leite'),
  [{ name: 'Leite', qty: '1 un' }]);
test('comando + 3 itens', parseInput('adicionar leite, pão e banana'),
  [{ name: 'Leite', qty: '1 un' }, { name: 'Pão', qty: '1 un' }, { name: 'Banana', qty: '1 un' }]);
test('qty + unidade', parseInput('2 kg de arroz'),
  [{ name: 'Arroz', qty: '2 kg' }]);
test('qty + comando', parseInput('comprar 500g de feijão'),
  [{ name: 'Feijão', qty: '500 g' }]);
test('vírgula decimal', parseInput('1,5 L de leite'),
  [{ name: 'Leite', qty: '1.5 L' }]);
test('número por extenso', parseInput('três cebolas'),
  [{ name: 'Cebolas', qty: '3 un' }]);
test('meia dúzia', parseInput('meia dúzia de ovos'),
  [{ name: 'Ovos', qty: '6 un' }]);
test('uma dúzia', parseInput('uma dúzia de pães'),
  [{ name: 'Pães', qty: '12 un' }]);
test('dúzia sem número', parseInput('dúzia de ovos'),
  [{ name: 'Ovos', qty: '12 un' }]);
test('vários separadores', parseInput('arroz, feijão e batata'),
  [{ name: 'Arroz', qty: '1 un' }, { name: 'Feijão', qty: '1 un' }, { name: 'Batata', qty: '1 un' }]);
test('vazio', parseInput(''), []);
test('só comando', parseInput('adicionar'),
  [{ name: 'Adicionar', qty: '1 un' }]);

console.log('\n→ classifyAisle');
test('leite → laticinios', classifyAisle('leite integral'), 'laticinios');
test('frango → açougue', classifyAisle('peito de frango'), 'acougue');
test('arroz → mercearia', classifyAisle('arroz branco'), 'mercearia');
test('banana → hortifruti', classifyAisle('banana prata'), 'hortifruti');
test('detergente → higiene', classifyAisle('detergente concentrado'), 'higiene');
test('ração → pet', classifyAisle('ração para cães'), 'pet');
test('fralda bebê → bebê', classifyAisle('fralda bebê'), 'bebe');
test('cerveja → bebidas', classifyAisle('cerveja gelada'), 'bebidas');
test('desconhecido → outros', classifyAisle('xpto123'), 'outros');
test('vazio → outros', classifyAisle(''), 'outros');
test('null → outros', classifyAisle(null), 'outros');

if (failed > 0) {
  console.log(`\n✗ ${failed} test(s) falharam`);
  process.exit(1);
}
console.log(`\n✓ todos os testes passaram`);
