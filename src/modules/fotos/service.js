const { randomUUID } = require('node:crypto');
const db = require('../../shared/db');
const HttpError = require('../../shared/http-error');
const agenda = require('../agenda');
const storage = require('./storage');

const EXTENSOES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const TAMANHO_MAXIMO = 5 * 1024 * 1024;
const VALIDADE_UPLOAD_S = 300;
const VALIDADE_LEITURA_S = 600;
const TIMEOUT_PROCESSAMENTO_S = Number(process.env.FOTO_TIMEOUT_SEGUNDOS) || 300;
const WORKER_URL = process.env.WORKER_URL || 'http://localhost:8787';

function chaveDeErro(foto) {
  return `erros/medicos/${foto.medico_id}/${foto.id}.json`;
}

function descreverErro({ motivo, detalhe }) {
  if (!motivo) return detalhe || 'FALHA_PROCESSAMENTO';
  return detalhe ? `${motivo}: ${detalhe}` : motivo;
}

async function formatar(foto) {
  const concluida = foto.status === 'CONCLUIDO';
  return {
    foto_id: foto.id,
    medico_id: foto.medico_id,
    status: foto.status,
    miniatura_url: concluida ? await storage.urlDeLeitura(foto.chave_miniatura, VALIDADE_LEITURA_S) : null,
    erro: foto.erro,
    criado_em: foto.criado_em,
    atualizado_em: foto.atualizado_em,
  };
}

async function buscarRegistro(id) {
  const { rows } = await db.query('SELECT * FROM fotos.fotos WHERE id = $1', [id]);
  return rows[0] || null;
}

async function solicitarUpload(medicoId, { content_type, tamanho }) {
  if (!content_type || tamanho === undefined) throw new HttpError(400, 'content_type e tamanho são obrigatórios');
  if (!Number.isInteger(tamanho) || tamanho <= 0) throw new HttpError(400, 'tamanho deve ser um inteiro positivo, em bytes');
  const extensao = EXTENSOES[content_type];
  if (!extensao) throw new HttpError(415, 'content_type deve ser image/jpeg, image/png ou image/webp');
  if (tamanho > TAMANHO_MAXIMO) throw new HttpError(413, 'Arquivo maior que 5 MB');

  const medico = await agenda.buscarMedico(medicoId);
  if (!medico) throw new HttpError(404, 'Médico não encontrado');

  const id = randomUUID();
  const base = `medicos/${medico.id}/${id}`;
  const chaveOriginal = `${base}.${extensao}`;
  const urlUpload = await storage.urlDeUpload(chaveOriginal, content_type, VALIDADE_UPLOAD_S);

  await db.query(
    `INSERT INTO fotos.fotos (id, medico_id, content_type, tamanho_bytes, chave_original, chave_miniatura)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, medico.id, content_type, tamanho, chaveOriginal, `${base}.webp`],
  );

  return {
    foto_id: id,
    medico_id: medico.id,
    status: 'PROCESSANDO',
    upload: {
      metodo: 'PUT',
      url: `${WORKER_URL}/upload`,
      headers: { 'Content-Type': content_type, 'X-Upload-Url': urlUpload },
      expira_em: new Date(Date.now() + VALIDADE_UPLOAD_S * 1000).toISOString(),
    },
    consulta: `/fotos/${id}`,
  };
}

// Atualiza o status de uma foto PROCESSANDO olhando o S3 (a Lambda não acessa o banco).
// Se o S3 falhar, devolve o que está salvo e não aplica o tempo limite.
async function reconciliar(foto) {
  if (foto.status !== 'PROCESSANDO') return foto;

  let resultado = null;
  try {
    if (await storage.miniaturaExiste(foto.chave_miniatura)) {
      resultado = { status: 'CONCLUIDO', erro: null };
    } else {
      const erro = await storage.lerErro(chaveDeErro(foto));
      if (erro) resultado = { status: 'ERRO', erro: descreverErro(erro) };
    }
  } catch (err) {
    console.error(`[fotos] S3 indisponível ao reconciliar ${foto.id}: ${err.message}`);
    return foto;
  }

  // WHERE status = 'PROCESSANDO' torna a transição atômica; o tempo limite usa o relógio do banco.
  const { rows } = resultado
    ? await db.query(
      `UPDATE fotos.fotos SET status = $2, erro = $3, atualizado_em = now()
        WHERE id = $1 AND status = 'PROCESSANDO' RETURNING *`,
      [foto.id, resultado.status, resultado.erro],
    )
    : await db.query(
      `UPDATE fotos.fotos SET status = 'ERRO', erro = 'Tempo limite de processamento excedido', atualizado_em = now()
        WHERE id = $1 AND status = 'PROCESSANDO' AND criado_em < now() - make_interval(secs => $2)
        RETURNING *`,
      [foto.id, TIMEOUT_PROCESSAMENTO_S],
    );

  return rows[0] || (await buscarRegistro(foto.id));
}

async function buscar(id) {
  const foto = await buscarRegistro(id);
  if (!foto) return null;
  return formatar(await reconciliar(foto));
}

async function fotoDoMedico(medicoId) {
  const medico = await agenda.buscarMedico(medicoId);
  if (!medico) throw new HttpError(404, 'Médico não encontrado');

  // Só as pendentes mais novas que a última CONCLUIDO podem mudar a resposta.
  const { rows: pendentes } = await db.query(
    `SELECT * FROM fotos.fotos
      WHERE medico_id = $1 AND status = 'PROCESSANDO'
        AND criado_em > COALESCE(
          (SELECT max(criado_em) FROM fotos.fotos WHERE medico_id = $1 AND status = 'CONCLUIDO'),
          '-infinity')
      ORDER BY criado_em DESC
      LIMIT 5`,
    [medico.id],
  );
  await Promise.all(pendentes.map(reconciliar));

  const { rows } = await db.query(
    `SELECT * FROM fotos.fotos WHERE medico_id = $1 AND status = 'CONCLUIDO'
      ORDER BY criado_em DESC LIMIT 1`,
    [medico.id],
  );
  if (!rows[0]) throw new HttpError(404, 'Médico sem foto processada');
  return formatar(rows[0]);
}

module.exports = { solicitarUpload, buscar, fotoDoMedico };
