import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { tipoReal } from '../src/index.js';

const env = {
  S3_ALLOWED_ORIGIN: 'http://localhost:4566',
  BUCKET_ORIGINAIS: 'cliniflow-originais',
  MAX_BYTES: '5242880',
};

const FOTO = '3f6c1e0a-8a51-4c43-9d0e-6a0f6f2b7c11';
const URL_OK = `http://localhost:4566/cliniflow-originais/medicos/1/${FOTO}.png?X-Amz-Signature=abc`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const WEBP = new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ');

// S3 simulado: guarda as chamadas e responde com `statusS3` (ou lança erro de rede).
let chamadas, statusS3;
beforeEach(() => {
  chamadas = [];
  statusS3 = 200;
  globalThis.fetch = async (input, init) => {
    chamadas.push(new Request(input, init));
    if (statusS3 === 'rede') throw new Error('connect ECONNREFUSED');
    return new Response('', { status: statusS3 });
  };
});

function enviar({ corpo = PNG, tipo = 'image/png', destino = URL_OK, metodo = 'PUT', caminho = '/upload', headers = {} } = {}) {
  const h = { ...headers };
  if (tipo) h['content-type'] = tipo;
  if (destino) h['x-upload-url'] = destino;
  return worker.fetch(new Request('http://localhost:8787' + caminho, { method: metodo, body: metodo === 'PUT' ? corpo : undefined, headers: h }), env);
}

async function esperar(res, status, erro) {
  assert.equal(res.status, status);
  if (erro) assert.match((await res.json()).erro, erro);
}

test('magic bytes dos três formatos', () => {
  assert.equal(tipoReal(PNG), 'image/png');
  assert.equal(tipoReal(JPEG), 'image/jpeg');
  assert.equal(tipoReal(WEBP), 'image/webp');
  assert.equal(tipoReal(new TextEncoder().encode('RIFF\0\0\0\0WAVE')), null);
});

test('cenário 1: imagem válida vai para a URL pré-assinada e responde 202 ENVIADO', async () => {
  const res = await enviar();
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { status: 'ENVIADO', chave: `medicos/1/${FOTO}.png` });
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].method, 'PUT');
  assert.equal(chamadas[0].url, URL_OK);
  assert.equal(chamadas[0].headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await chamadas[0].arrayBuffer()), PNG);
});

test('virtual-host da AWS também é aceito', async () => {
  const awsEnv = { ...env, S3_ALLOWED_ORIGIN: 'https://cliniflow-originais.s3.us-east-1.amazonaws.com' };
  const req = new Request('http://localhost:8787/upload', {
    method: 'PUT', body: PNG,
    headers: { 'content-type': 'image/png', 'x-upload-url': `https://cliniflow-originais.s3.us-east-1.amazonaws.com/medicos/1/${FOTO}.png?X-Amz-Signature=abc` },
  });
  assert.equal((await worker.fetch(req, awsEnv)).status, 202);
});

test('cenário 4: arquivo que não é imagem enviado como image/jpeg → 415, nada vai ao S3', async () => {
  const res = await enviar({ corpo: new TextEncoder().encode('nao sou imagem'), tipo: 'image/jpeg', destino: URL_OK.replace('.png', '.jpg') });
  await esperar(res, 415, /JPEG\/PNG\/WebP/);
  assert.equal(chamadas.length, 0);
});

test('cenário 6: X-Upload-Url para outro host, outro bucket ou chave fora do padrão → 403', async () => {
  for (const destino of [
    URL_OK.replace('localhost:4566', 'evil.example.com'),
    URL_OK.replace('cliniflow-originais', 'cliniflow-miniaturas'),
    `http://localhost:4566/cliniflow-originais/medicos/1/../../x/${FOTO}.png`,
    `http://localhost:4566/cliniflow-originais/outra/1/${FOTO}.png`,
  ]) {
    await esperar(await enviar({ destino }), 403, /não permitido/);
  }
  assert.equal(chamadas.length, 0);
});

test('cenário 7: S3 responde 403 (URL expirada) → 403', async () => {
  statusS3 = 403;
  await esperar(await enviar(), 403, /expirada/);
});

test('headers faltando ou URL malformada → 400', async () => {
  await esperar(await enviar({ destino: null }), 400);
  await esperar(await enviar({ tipo: null }), 400);
  await esperar(await enviar({ destino: 'nao-e-url' }), 400, /malformada/);
});

test('extensão da chave diferente do Content-Type → 400', async () => {
  await esperar(await enviar({ tipo: 'image/jpeg', corpo: JPEG }), 400, /Extensão/);
});

test('Content-Type fora da lista ou magic bytes de outro tipo → 415', async () => {
  await esperar(await enviar({ tipo: 'image/gif' }), 415);
  await esperar(await enviar({ corpo: JPEG }), 415);
  await esperar(await enviar({ corpo: new Uint8Array(0) }), 415);
});

test('acima de 5 MB → 413, pelo Content-Length e pelo tamanho real', async () => {
  const grande = new Uint8Array(5242881);
  grande.set(PNG);
  await esperar(await enviar({ corpo: grande }), 413, /5 MB/);
  assert.equal(chamadas.length, 0);
});

test('S3 com erro 5xx ou fora do ar → 502', async () => {
  statusS3 = 500;
  await esperar(await enviar(), 502, /indisponível/);
  statusS3 = 'rede';
  await esperar(await enviar(), 502, /indisponível/);
});

test('outras rotas → 404; outro método em /upload → 405', async () => {
  assert.equal((await enviar({ caminho: '/health', metodo: 'GET' })).status, 404);
  assert.equal((await enviar({ metodo: 'POST' })).status, 405);
});
