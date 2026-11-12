const { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const BUCKET_ORIGINAIS = process.env.BUCKET_ORIGINAIS || 'cliniflow-originais';
const BUCKET_MINIATURAS = process.env.BUCKET_MINIATURAS || 'cliniflow-miniaturas';

const configBase = {
  region: process.env.AWS_REGION || 'us-east-1',
  forcePathStyle: true,
  maxAttempts: 2,
  requestHandler: { connectionTimeout: 1000, requestTimeout: 1500 },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
};

let interno = null;
let publico = null;

// Consultas da API ao S3 (HEAD/GET), pela rede interna do Docker.
function clienteInterno() {
  interno ??= new S3Client({ ...configBase, endpoint: process.env.S3_ENDPOINT || undefined });
  return interno;
}

// Só assina URLs (cálculo local). O host entra na assinatura, então precisa ser o
// endereço que o Worker e o cliente enxergam.
function clientePublico() {
  publico ??= new S3Client({
    ...configBase,
    endpoint: process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT || undefined,
  });
  return publico;
}

function naoEncontrado(err) {
  return err.name === 'NotFound' || err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404;
}

function urlDeUpload(chave, contentType, segundos) {
  const comando = new PutObjectCommand({ Bucket: BUCKET_ORIGINAIS, Key: chave, ContentType: contentType });
  return getSignedUrl(clientePublico(), comando, {
    expiresIn: segundos,
    signableHeaders: new Set(['content-type']),
  });
}

function urlDeLeitura(chave, segundos) {
  const comando = new GetObjectCommand({ Bucket: BUCKET_MINIATURAS, Key: chave });
  return getSignedUrl(clientePublico(), comando, { expiresIn: segundos });
}

async function miniaturaExiste(chave) {
  try {
    await clienteInterno().send(new HeadObjectCommand({ Bucket: BUCKET_MINIATURAS, Key: chave }));
    return true;
  } catch (err) {
    if (naoEncontrado(err)) return false;
    throw err;
  }
}

async function lerErro(chave) {
  let resposta;
  try {
    resposta = await clienteInterno().send(new GetObjectCommand({ Bucket: BUCKET_MINIATURAS, Key: chave }));
  } catch (err) {
    if (naoEncontrado(err)) return null;
    throw err;
  }
  const texto = await resposta.Body.transformToString();
  try {
    return JSON.parse(texto);
  } catch {
    return { motivo: 'FALHA_PROCESSAMENTO', detalhe: 'Arquivo de erro ilegível' };
  }
}

module.exports = { urlDeUpload, urlDeLeitura, miniaturaExiste, lerErro };
