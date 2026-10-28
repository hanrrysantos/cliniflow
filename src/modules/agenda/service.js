const db = require('../../shared/db');
const HttpError = require('../../shared/http-error');

async function criarMedico({ nome, especialidade }) {
  if (!nome || !especialidade) throw new HttpError(400, 'nome e especialidade são obrigatórios');
  const { rows } = await db.query(
    'INSERT INTO agenda.medicos (nome, especialidade) VALUES ($1, $2) RETURNING *',
    [nome, especialidade],
  );
  return rows[0];
}

async function criarHorario(medicoId, { data_hora }) {
  if (!data_hora) throw new HttpError(400, 'data_hora é obrigatória');
  const medico = await db.query('SELECT id FROM agenda.medicos WHERE id = $1', [medicoId]);
  if (medico.rowCount === 0) throw new HttpError(404, 'Médico não encontrado');
  try {
    const { rows } = await db.query(
      'INSERT INTO agenda.horarios (medico_id, data_hora) VALUES ($1, $2) RETURNING *',
      [medicoId, data_hora],
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'Horário já existe para este médico');
    throw err;
  }
}

async function listarHorarios(status) {
  const { rows } = await db.query(
    `SELECT h.id, h.data_hora, h.status, m.id AS medico_id, m.nome AS medico, m.especialidade
       FROM agenda.horarios h JOIN agenda.medicos m ON m.id = h.medico_id
      WHERE ($1::text IS NULL OR h.status = $1)
      ORDER BY h.data_hora`,
    [status || null],
  );
  return rows;
}

async function buscarHorario(horarioId) {
  const { rows } = await db.query(
    `SELECT h.id, h.data_hora, h.status, m.nome, m.especialidade
       FROM agenda.horarios h JOIN agenda.medicos m ON m.id = h.medico_id
      WHERE h.id = $1`,
    [horarioId],
  );
  if (!rows[0]) return null;
  const { nome, especialidade, ...horario } = rows[0];
  return { ...horario, medico: { nome, especialidade } };
}

async function reservarHorario(client, horarioId) {
  const { rowCount } = await client.query(
    "UPDATE agenda.horarios SET status = 'RESERVADO' WHERE id = $1 AND status = 'LIVRE'",
    [horarioId],
  );
  return rowCount === 1;
}

async function liberarHorario(client, horarioId) {
  await client.query("UPDATE agenda.horarios SET status = 'LIVRE' WHERE id = $1", [horarioId]);
}

module.exports = { criarMedico, criarHorario, listarHorarios, buscarHorario, reservarHorario, liberarHorario };
