const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { Readable } = require('node:stream');
const { ErroImagemInvalida, gerarMiniatura } = require('../servico-imagens');
const { processarEvento, configuracaoDoAmbiente, chavesDaFoto } = require('../handler');
const { criarArmazenamento, lerAteLimite, ErroArquivoMuitoGrande } = require('../armazenamento');

const fotoId = '3f6c1e0a-8a51-4c43-9d0e-6a0f6f2b7c11';
const key = `medicos/1/${fotoId}.jpg`;
const chaveMiniatura = `medicos/1/${fotoId}.webp`;
const chaveErro = `erros/medicos/1/${fotoId}.json`;
const configuracao = configuracaoDoAmbiente({});

function registro(objectKey = key, overrides = {}) {
  return {
    eventName: 'ObjectCreated:Put',
    s3: { bucket: { name: 'cliniflow-originais' }, object: {
      key: encodeURIComponent(objectKey).replace(/%20/g, '+'), eTag: 'abc123', ...overrides,
    } },
  };
}
const evento = (...records) => ({ Records: records });
function armazenamentoSimulado(bytes) {
  const objects = new Map();
  return {
    objects,
    existe: async (_bucket, objectKey) => objects.has(objectKey),
    ler: async () => bytes,
    gravarSeAusente: async (_bucket, objectKey, value, tipoConteudo) => {
      if (objects.has(objectKey)) return 'exists';
      objects.set(objectKey, { bytes: value, tipoConteudo });
      return 'created';
    },
  };
}

test('JPEG válido gera WebP central 200 x 200', async () => {
  const bytes = await sharp({ create: { width: 400, height: 300, channels: 3, background: 'red' } }).jpeg().toBuffer();
  const output = await gerarMiniatura(bytes);
  const metadata = await sharp(output).metadata();
  assert.deepEqual([metadata.format, metadata.width, metadata.height], ['webp', 200, 200]);
});

test('PNG válido gera miniatura com chave e tipo do contrato', async () => {
  const bytes = await sharp({ create: { width: 300, height: 400, channels: 3, background: 'blue' } }).png().toBuffer();
  const armazenamento = armazenamentoSimulado(bytes);
  const result = await processarEvento(evento(registro(key.replace('.jpg', '.png'))), { armazenamento, configuracao });
  assert.equal(result.results[0].status, 'created');
  assert.equal(result.results[0].chaveMiniatura, chaveMiniatura);
  assert.equal(armazenamento.objects.get(chaveMiniatura).tipoConteudo, 'image/webp');
});

test('WebP válido também é aceito', async () => {
  const bytes = await sharp({ create: { width: 300, height: 300, channels: 3, background: 'green' } }).webp().toBuffer();
  assert.equal((await sharp(await gerarMiniatura(bytes)).metadata()).format, 'webp');
});

test('conteúdo de formato não permitido grava erro com motivo correto', async () => {
  const armazenamento = armazenamentoSimulado(Buffer.from('<svg></svg>'));
  const result = await processarEvento(evento(registro()), { armazenamento, configuracao, registrador: { warn() {} } });
  assert.equal(result.results[0].status, 'invalid');
  assert.equal(armazenamento.objects.get(chaveErro).tipoConteudo, 'application/json');
  const dadosErro = JSON.parse(armazenamento.objects.get(chaveErro).bytes.toString());
  assert.deepEqual([dadosErro.foto_id, dadosErro.medico_id, dadosErro.chave_original, dadosErro.motivo],
    [fotoId, 1, key, 'FORMATO_NAO_SUPORTADO']);
  assert.ok(dadosErro.ocorrido_em);
});

test('imagem corrompida grava ARQUIVO_INVALIDO', async () => {
  const armazenamento = armazenamentoSimulado(Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  await processarEvento(evento(registro()), { armazenamento, configuracao, registrador: { warn() {} } });
  assert.equal(JSON.parse(armazenamento.objects.get(chaveErro).bytes.toString()).motivo, 'ARQUIVO_INVALIDO');
});

test('JPEG truncado depois do cabeçalho também grava ARQUIVO_INVALIDO', async () => {
  const complete = await sharp({ create: { width: 500, height: 500, channels: 3, background: 'red' } })
    .jpeg().toBuffer();
  const armazenamento = armazenamentoSimulado(complete.subarray(0, Math.floor(complete.length / 2)));
  await processarEvento(evento(registro()), { armazenamento, configuracao, registrador: { warn() {} } });
  assert.equal(JSON.parse(armazenamento.objects.get(chaveErro).bytes.toString()).motivo, 'ARQUIVO_INVALIDO');
});

test('arquivo maior que 5 MB grava ARQUIVO_MUITO_GRANDE', async () => {
  const armazenamento = armazenamentoSimulado(Buffer.alloc(0));
  armazenamento.ler = async () => { throw new ErroArquivoMuitoGrande(); };
  await processarEvento(evento(registro()), { armazenamento, configuracao, registrador: { warn() {} } });
  assert.equal(JSON.parse(armazenamento.objects.get(chaveErro).bytes.toString()).motivo, 'ARQUIVO_MUITO_GRANDE');
});

test('erro permanente no redimensionamento grava FALHA_PROCESSAMENTO', async () => {
  const armazenamento = armazenamentoSimulado(Buffer.from('bytes'));
  await processarEvento(evento(registro()), { armazenamento, configuracao, registrador: { warn() {} },
    redimensionar: async () => { throw new ErroImagemInvalida('FALHA_PROCESSAMENTO', 'Falha de codec'); } });
  assert.equal(JSON.parse(armazenamento.objects.get(chaveErro).bytes.toString()).motivo, 'FALHA_PROCESSAMENTO');
});

test('falha de leitura S3 é propagada para retentativa', async () => {
  const armazenamento = armazenamentoSimulado(Buffer.alloc(0));
  armazenamento.ler = async () => { throw new Error('S3 indisponível'); };
  await assert.rejects(processarEvento(evento(registro()), { armazenamento, configuracao }), /S3 indisponível/);
});

test('falha ao gravar miniatura é propagada', async () => {
  const armazenamento = armazenamentoSimulado(Buffer.from('original'));
  armazenamento.gravarSeAusente = async () => { throw new Error('AccessDenied'); };
  await assert.rejects(processarEvento(evento(registro()), { armazenamento, configuracao,
    redimensionar: async () => Buffer.from('thumb') }), /AccessDenied/);
});

test('falha ao gravar erro também é propagada', async () => {
  const armazenamento = armazenamentoSimulado(Buffer.from('bad'));
  armazenamento.gravarSeAusente = async () => { throw new Error('S3 503'); };
  await assert.rejects(processarEvento(evento(registro()), { armazenamento, configuracao,
    redimensionar: async () => { throw new ErroImagemInvalida('ARQUIVO_INVALIDO', 'ruim'); } }), /S3 503/);
});

test('repetir evento não reprocessa quando a miniatura existe', async () => {
  const armazenamento = armazenamentoSimulado(Buffer.from('original'));
  let calls = 0;
  const dependencias = { armazenamento, configuracao, registrador: { info() {} },
    redimensionar: async () => { calls++; return Buffer.from('thumb'); } };
  assert.equal((await processarEvento(evento(registro()), dependencias)).results[0].status, 'created');
  assert.equal((await processarEvento(evento(registro()), dependencias)).results[0].status, 'duplicate');
  assert.equal(calls, 1);
});

test('objeto fora do padrão de chave é ignorado', async () => {
  const armazenamento = armazenamentoSimulado(Buffer.alloc(0));
  armazenamento.ler = async () => { throw new Error('não deveria ler'); };
  const result = await processarEvento(evento(registro('outros/foto.jpg')), { armazenamento, configuracao, registrador: { info() {} } });
  assert.equal(result.results[0].status, 'ignored');
});

test('bucket de origem errado é ignorado', async () => {
  const wrong = registro(); wrong.s3.bucket.name = 'outro-bucket';
  assert.equal((await processarEvento(evento(wrong), { armazenamento: armazenamentoSimulado(Buffer.alloc(0)), configuracao })).results[0].status, 'ignored');
});

test('evento de teste S3 é ignorado', async () => {
  assert.deepEqual(await processarEvento({ Event: 's3:TestEvent' }), { results: [] });
});

test('evento com múltiplos registros processa todos', async () => {
  const armazenamento = armazenamentoSimulado(Buffer.from('original'));
  const otherKey = `medicos/2/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`;
  const result = await processarEvento(evento(registro(), registro(otherKey)), { armazenamento, configuracao,
    redimensionar: async () => Buffer.from('thumb') });
  assert.deepEqual(result.results.map((item) => item.status), ['created', 'created']);
  assert.equal(armazenamento.objects.size, 2);
});

test('evento antigo sem versionId é ignorado quando ETag mudou', async () => {
  const armazenamento = armazenamentoSimulado(Buffer.alloc(0));
  armazenamento.ler = async () => { const erro = new Error('PreconditionFailed'); erro.$metadata = { httpStatusCode: 412 }; throw erro; };
  assert.equal((await processarEvento(evento(registro()), { armazenamento, configuracao, registrador: { info() {} } })).results[0].status, 'stale');
});

test('duas execuções concorrentes têm uma única gravação efetiva', async () => {
  const armazenamento = armazenamentoSimulado(Buffer.from('original'));
  const dependencias = { armazenamento, configuracao, redimensionar: async () => Buffer.from('thumb') };
  const results = await Promise.all([processarEvento(evento(registro()), dependencias), processarEvento(evento(registro()), dependencias)]);
  assert.deepEqual(results.map((item) => item.results[0].status).sort(), ['created', 'duplicate']);
  assert.equal(armazenamento.objects.size, 1);
});

test('limite de stream é imposto mesmo sem ContentLength', async () => {
  await assert.rejects(lerAteLimite(Readable.from([Buffer.alloc(3), Buffer.alloc(4)]), 5), ErroArquivoMuitoGrande);
});

test('adaptador S3 usa ETag e gravação condicional com tipo WebP', async () => {
  const commands = [];
  const armazenamento = criarArmazenamento({ send: async (comando) => {
    commands.push(comando);
    if (comando.constructor.name === 'GetObjectCommand') return { Body: Readable.from([Buffer.from('abc')]), ContentLength: 3 };
    return {};
  } });
  await armazenamento.ler('cliniflow-originais', key, { eTag: 'abc', limiteBytes: 10 });
  await armazenamento.gravarSeAusente('cliniflow-miniaturas', chaveMiniatura, Buffer.from('x'), 'image/webp');
  assert.equal(commands[0].input.IfMatch, '"abc"');
  assert.equal(commands[1].input.IfNoneMatch, '*');
  assert.equal(commands[1].input.ContentType, 'image/webp');
});

test('adaptador S3 usa versionId quando disponível', async () => {
  const commands = [];
  const armazenamento = criarArmazenamento({ send: async (comando) => {
    commands.push(comando); return { Body: Readable.from([Buffer.from('abc')]), ContentLength: 3 };
  } });
  await armazenamento.ler('cliniflow-originais', key, { versionId: 'v1', eTag: 'abc', limiteBytes: 10 });
  assert.equal(commands[0].input.VersionId, 'v1');
  assert.equal(commands[0].input.IfMatch, undefined);
});

test('adaptador S3 trata 412 como duplicata e 403 como falha', async () => {
  const armazenamento = criarArmazenamento({ send: async () => {
    const erro = new Error('PreconditionFailed'); erro.$metadata = { httpStatusCode: 412 }; throw erro;
  } });
  assert.equal(await armazenamento.gravarSeAusente('b', 'k', Buffer.from('x'), 'image/webp'), 'exists');
  const denied = criarArmazenamento({ send: async () => {
    const erro = new Error('AccessDenied'); erro.$metadata = { httpStatusCode: 403 }; throw erro;
  } });
  await assert.rejects(denied.existe('b', 'k'), /AccessDenied/);
});

test('chaves derivadas de foto_id correspondem ao contrato', () => {
  assert.deepEqual(chavesDaFoto(key), { medicoId: 1, fotoId, chaveMiniatura, chaveErro });
  assert.equal(chavesDaFoto('medicos/1/invalido.jpg'), null);
  assert.equal(configuracao.limiteBytes, 5_242_880);
});
