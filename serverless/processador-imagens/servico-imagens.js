const sharp = require('sharp');

class ErroImagemInvalida extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ErroImagemInvalida';
    this.code = code;
  }
}

function formatoDaImagem(bytes) {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  throw new ErroImagemInvalida('FORMATO_NAO_SUPORTADO', 'Conteúdo não é JPEG, PNG ou WebP');
}

async function gerarMiniatura(bytes, { width = 200, height = 200, limitePixels = 25_000_000 } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new ErroImagemInvalida('ARQUIVO_INVALIDO', 'Imagem vazia');
  }
  const format = formatoDaImagem(bytes);
  let metadata;
  try {
    metadata = await sharp(bytes, { limitInputPixels: limitePixels, failOn: 'error' }).metadata();
  } catch (erro) {
    if (/memory|allocation|ENOMEM/i.test(erro.message)) throw erro;
    throw new ErroImagemInvalida('ARQUIVO_INVALIDO', `Não foi possível decodificar a imagem: ${erro.message}`);
  }
  if (metadata.format !== format || !metadata.width || !metadata.height ||
      metadata.width * metadata.height > limitePixels || (metadata.pages ?? 1) !== 1) {
    throw new ErroImagemInvalida('ARQUIVO_INVALIDO', 'Imagem inválida ou excede o limite de pixels');
  }
  try {
    return await sharp(bytes, { limitInputPixels: limitePixels, failOn: 'error' })
      .autoOrient().resize(width, height, { fit: 'cover', position: 'centre' })
      .webp({ quality: 80 }).toBuffer();
  } catch (erro) {
    if (/memory|allocation|ENOMEM/i.test(erro.message)) throw erro;
    const corrompido = /premature|corrupt|truncated|unexpected end|invalid image|bad header|read error/i.test(erro.message);
    throw new ErroImagemInvalida(corrompido ? 'ARQUIVO_INVALIDO' : 'FALHA_PROCESSAMENTO',
      `Não foi possível processar a imagem: ${erro.message}`);
  }
}

module.exports = { ErroImagemInvalida, gerarMiniatura, formatoDaImagem };
