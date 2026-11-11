const { criarArmazenamento, ErroArquivoMuitoGrande } = require('./armazenamento');
const { gerarMiniatura, ErroImagemInvalida } = require('./servico-imagens');

const PADRAO_CHAVE_ORIGINAL = /^medicos\/(\d+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(jpg|png|webp)$/;

function configuracaoDoAmbiente(env = process.env) {
  const limiteBytes = Number(env.MAX_IMAGE_BYTES ?? 5_242_880);
  const limitePixels = Number(env.MAX_IMAGE_PIXELS ?? 25_000_000);
  if (!Number.isSafeInteger(limiteBytes) || limiteBytes < 1 ||
      !Number.isSafeInteger(limitePixels) || limitePixels < 1) {
    throw new Error('MAX_IMAGE_BYTES e MAX_IMAGE_PIXELS devem ser inteiros positivos');
  }
  return {
    bucketOriginais: env.BUCKET_ORIGINAIS ?? 'cliniflow-originais',
    bucketMiniaturas: env.BUCKET_MINIATURAS ?? 'cliniflow-miniaturas',
    limiteBytes, limitePixels, width: 200, height: 200,
  };
}

function extrairRegistro(registro) {
  if (!registro?.eventName?.startsWith('ObjectCreated:') || !registro?.s3?.bucket?.name || !registro?.s3?.object?.key) {
    throw new Error('Registro S3 ObjectCreated inválido');
  }
  let key;
  try {
    key = decodeURIComponent(registro.s3.object.key.replace(/\+/g, ' '));
  } catch {
    throw new Error('Chave S3 inválida');
  }
  const versionId = registro.s3.object.versionId && registro.s3.object.versionId !== 'null'
    ? registro.s3.object.versionId : undefined;
  const eTag = registro.s3.object.eTag;
  if (!versionId && !eTag) throw new Error('Evento S3 sem versionId ou eTag');
  return { bucket: registro.s3.bucket.name, key, versionId, eTag };
}

function chavesDaFoto(chaveOriginal) {
  const correspondencia = PADRAO_CHAVE_ORIGINAL.exec(chaveOriginal);
  if (!correspondencia) return null;
  const [, medicoId, fotoId] = correspondencia;
  return {
    medicoId: Number(medicoId), fotoId,
    chaveMiniatura: `medicos/${medicoId}/${fotoId}.webp`,
    chaveErro: `erros/medicos/${medicoId}/${fotoId}.json`,
  };
}

async function registrarImagemInvalida(origem, chaves, erro, armazenamento, configuracao, registrador) {
  const dadosErro = {
    foto_id: chaves.fotoId, medico_id: chaves.medicoId, chave_original: origem.key,
    motivo: erro.code, detalhe: erro.message, ocorrido_em: new Date().toISOString(),
  };
  await armazenamento.gravarSeAusente(configuracao.bucketMiniaturas, chaves.chaveErro,
    Buffer.from(JSON.stringify(dadosErro)), 'application/json');
  registrador.warn?.('Imagem inválida', dadosErro);
  return { status: 'invalid', chaveErro: chaves.chaveErro, reason: erro.code };
}

async function processarRegistro(registro, { armazenamento, configuracao, redimensionar = gerarMiniatura, registrador = console }) {
  const origem = extrairRegistro(registro);
  if (origem.bucket !== configuracao.bucketOriginais) return { status: 'ignored', key: origem.key };
  const chaves = chavesDaFoto(origem.key);
  if (!chaves) {
    registrador.info?.('Chave de original fora do contrato', { key: origem.key });
    return { status: 'ignored', key: origem.key };
  }
  if (await armazenamento.existe(configuracao.bucketMiniaturas, chaves.chaveMiniatura)) {
    registrador.info?.('Foto já processada', { key: origem.key });
    return { status: 'duplicate', chaveMiniatura: chaves.chaveMiniatura };
  }

  let original;
  try {
    original = await armazenamento.ler(origem.bucket, origem.key, {
      versionId: origem.versionId, eTag: origem.eTag, limiteBytes: configuracao.limiteBytes,
    });
  } catch (erro) {
    if (!origem.versionId && erro?.$metadata?.httpStatusCode === 412) {
      registrador.info?.('Evento antigo: original substituído', { key: origem.key });
      return { status: 'stale', key: origem.key };
    }
    if (erro instanceof ErroArquivoMuitoGrande || erro?.name === 'ErroArquivoMuitoGrande') {
      return registrarImagemInvalida(origem, chaves,
        new ErroImagemInvalida('ARQUIVO_MUITO_GRANDE', erro.message), armazenamento, configuracao, registrador);
    }
    throw erro;
  }

  let miniatura;
  try {
    miniatura = await redimensionar(original, configuracao);
  } catch (erro) {
    if (!(erro instanceof ErroImagemInvalida)) throw erro;
    return registrarImagemInvalida(origem, chaves, erro, armazenamento, configuracao, registrador);
  }
  const gravacao = await armazenamento.gravarSeAusente(configuracao.bucketMiniaturas, chaves.chaveMiniatura,
    miniatura, 'image/webp');
  return { status: gravacao === 'created' ? 'created' : 'duplicate', chaveMiniatura: chaves.chaveMiniatura };
}

async function processarEvento(evento, dependencias = {}) {
  if (evento?.Event === 's3:TestEvent') return { results: [] };
  if (!Array.isArray(evento?.Records)) throw new Error('Evento S3 sem Records');
  const configuracao = dependencias.configuracao ?? configuracaoDoAmbiente();
  const armazenamento = dependencias.armazenamento ?? criarArmazenamento();
  const results = [];
  for (const registro of evento.Records) {
    results.push(await processarRegistro(registro, { ...dependencias, configuracao, armazenamento }));
  }
  return { results };
}

async function handler(evento) {
  const result = await processarEvento(evento);
  console.info('Processamento de fotos concluído', result);
  return result;
}

module.exports = { handler, processarEvento, processarRegistro, extrairRegistro, chavesDaFoto, configuracaoDoAmbiente };
