// Worker de entrada do pipeline de fotos (docs/CONTRATOS.md §2.2).
// Não tem credencial AWS: só valida e repassa o arquivo para a URL pré-assinada gerada pela API.

const EXTENSAO_POR_TIPO = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const CHAVE_ORIGINAL = /^medicos\/\d+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

// Confere o tipo real pelos primeiros bytes (CONTRATOS §1), não só pelo Content-Type declarado.
export function tipoReal(b) {
  const comeca = (bytes, inicio = 0) => bytes.every((v, i) => b[inicio + i] === v);
  if (comeca([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (comeca([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (comeca([0x52, 0x49, 0x46, 0x46]) && comeca([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

function json(status, corpo) {
  return Response.json(corpo, { status });
}

// Devolve a chave do objeto se a URL aponta para o bucket de originais no endpoint permitido.
// Aceita path-style (LocalStack: http://localhost:4566/<bucket>/<chave>)
// e virtual-host (AWS: https://<bucket>.s3.<regiao>.amazonaws.com/<chave>).
function chaveDoDestino(url, env) {
  if (url.origin !== new URL(env.S3_ALLOWED_ORIGIN).origin) return null;
  const caminho = decodeURIComponent(url.pathname);
  let chave = null;
  if (caminho.startsWith(`/${env.BUCKET_ORIGINAIS}/`)) chave = caminho.slice(env.BUCKET_ORIGINAIS.length + 2);
  else if (url.hostname.startsWith(`${env.BUCKET_ORIGINAIS}.`)) chave = caminho.slice(1);
  return chave && CHAVE_ORIGINAL.test(chave) ? chave : null;
}

async function upload(request, env) {
  const maximo = Number(env.MAX_BYTES);
  const muitoGrande = () => json(413, { erro: `Arquivo maior que ${maximo / 1024 / 1024} MB` });
  const naoImagem = () => json(415, { erro: 'Conteúdo não é uma imagem JPEG/PNG/WebP' });

  const destino = request.headers.get('x-upload-url');
  const tipo = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!destino || !tipo) return json(400, { erro: 'Headers Content-Type e X-Upload-Url são obrigatórios' });

  // 1. Destino: só o bucket de originais, na chave do contrato. Impede uso como proxy aberto.
  let url;
  try {
    url = new URL(destino);
  } catch {
    return json(400, { erro: 'X-Upload-Url malformada' });
  }
  const chave = chaveDoDestino(url, env);
  if (!chave) return json(403, { erro: 'Destino de upload não permitido' });

  // 2. Tipo declarado aceito e compatível com a extensão da chave.
  if (!EXTENSAO_POR_TIPO[tipo]) return naoImagem();
  if (!chave.endsWith(`.${EXTENSAO_POR_TIPO[tipo]}`)) {
    return json(400, { erro: 'Extensão do arquivo diferente do Content-Type' });
  }

  // 3. Tamanho: pelo Content-Length (sem ler o corpo) e pelo tamanho real lido.
  if (Number(request.headers.get('content-length')) > maximo) return muitoGrande();
  const corpo = new Uint8Array(await request.arrayBuffer());
  if (corpo.length > maximo) return muitoGrande();

  // 4. Magic bytes iguais ao tipo declarado.
  if (tipoReal(corpo) !== tipo) return naoImagem();

  // 5. Repassa para o S3 com o mesmo corpo e o mesmo Content-Type (assinado na URL).
  let s3;
  try {
    s3 = await fetch(url, { method: 'PUT', body: corpo, headers: { 'content-type': tipo } });
  } catch (err) {
    console.error('[borda] S3 não respondeu:', err.message);
    return json(502, { erro: 'Armazenamento indisponível' });
  }
  if (s3.status === 403) return json(403, { erro: 'URL de upload expirada' });
  if (!s3.ok) {
    console.error('[borda] S3 respondeu', s3.status, await s3.text());
    return json(502, { erro: 'Armazenamento indisponível' });
  }
  return json(202, { status: 'ENVIADO', chave });
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/upload') return json(404, { erro: 'Rota não encontrada' });
    if (request.method !== 'PUT') return json(405, { erro: 'Use PUT /upload' });
    return upload(request, env);
  },
};
