const { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

function objetoNaoEncontrado(erro) {
  return erro?.name === 'NotFound' || erro?.name === 'NoSuchKey' || erro?.$metadata?.httpStatusCode === 404;
}

class ErroArquivoMuitoGrande extends Error {
  constructor() {
    super('Arquivo maior que 5 MB');
    this.name = 'ErroArquivoMuitoGrande';
  }
}

async function lerAteLimite(corpo, limiteBytes) {
  if (!corpo || typeof corpo[Symbol.asyncIterator] !== 'function') throw new Error('Resposta S3 sem stream de dados');
  const partes = [];
  let size = 0;
  for await (const parte of corpo) {
    size += parte.length;
    if (size > limiteBytes) {
      corpo.destroy?.();
      throw new ErroArquivoMuitoGrande();
    }
    partes.push(Buffer.from(parte));
  }
  return Buffer.concat(partes, size);
}

function criarArmazenamento(cliente = new S3Client({
  ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true } : {}),
})) {
  return {
    async existe(bucket, key) {
      try {
        await cliente.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (erro) {
        if (objetoNaoEncontrado(erro)) return false;
        throw erro;
      }
    },
    async ler(bucket, key, { versionId, eTag, limiteBytes }) {
      const resposta = await cliente.send(new GetObjectCommand({
        Bucket: bucket, Key: key,
        ...(versionId ? { VersionId: versionId } : { IfMatch: `"${eTag}"` }),
      }));
      if (resposta.ContentLength > limiteBytes) {
        resposta.Body?.destroy?.();
        throw new ErroArquivoMuitoGrande();
      }
      return lerAteLimite(resposta.Body, limiteBytes);
    },
    async gravarSeAusente(bucket, key, bytes, tipoConteudo) {
      try {
        await cliente.send(new PutObjectCommand({
          Bucket: bucket, Key: key, Body: bytes, ContentType: tipoConteudo, IfNoneMatch: '*',
        }));
        return 'created';
      } catch (erro) {
        if (erro?.$metadata?.httpStatusCode === 412 || erro?.name === 'PreconditionFailed') return 'exists';
        throw erro;
      }
    },
  };
}

module.exports = { criarArmazenamento, lerAteLimite, ErroArquivoMuitoGrande };
