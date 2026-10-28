const { randomUUID } = require('node:crypto');
const db = require('../../shared/db');
const broker = require('../../shared/broker');
const HttpError = require('../../shared/http-error');
const pacientes = require('../pacientes');
const agenda = require('../agenda');

async function buscarPorChave(idempotencyKey) {
  const { rows } = await db.query('SELECT * FROM agendamentos.consultas WHERE idempotency_key = $1', [idempotencyKey]);
  return rows[0] || null;
}

async function publicarEvento(tipo, consulta, paciente, horario) {
  broker.publish(tipo, {
    event_id: randomUUID(),
    tipo,
    consulta_id: consulta.id,
    paciente: { nome: paciente.nome, email: paciente.email },
    horario: { data_hora: horario.data_hora, medico: horario.medico.nome },
  });
}

// Retorna { consulta, criada } — criada = false quando a Idempotency-Key já foi usada.
async function agendar({ paciente_id, horario_id }, idempotencyKey) {
  if (!paciente_id || !horario_id) throw new HttpError(400, 'paciente_id e horario_id são obrigatórios');

  if (idempotencyKey) {
    const existente = await buscarPorChave(idempotencyKey);
    if (existente) return { consulta: existente, criada: false };
  }

  const paciente = await pacientes.buscarPaciente(paciente_id);
  if (!paciente) throw new HttpError(404, 'Paciente não encontrado');
  const horario = await agenda.buscarHorario(horario_id);
  if (!horario) throw new HttpError(404, 'Horário não encontrado');

  let consulta;
  try {
    // Reserva + registro na MESMA transação: ou as duas coisas acontecem, ou nenhuma.
    consulta = await db.withTransaction(async (client) => {
      const reservou = await agenda.reservarHorario(client, horario_id);
      if (!reservou) throw new HttpError(409, 'Horário indisponível');
      const { rows } = await client.query(
        `INSERT INTO agendamentos.consultas (paciente_id, horario_id, idempotency_key)
         VALUES ($1, $2, $3) RETURNING *`,
        [paciente_id, horario_id, idempotencyKey || null],
      );
      return rows[0];
    });
  } catch (err) {
    // Dois reenvios simultâneos com a mesma chave: devolve a consulta que venceu
    if (err.code === '23505' && err.constraint === 'consultas_idempotency_key_key') {
      return { consulta: await buscarPorChave(idempotencyKey), criada: false };
    }
    if (err.code === '23505') throw new HttpError(409, 'Horário indisponível');
    throw err;
  }

  // Evento publicado só depois do COMMIT
  publicarEvento('consulta.agendada', consulta, paciente, horario);
  return { consulta, criada: true };
}

async function buscar(id) {
  const { rows } = await db.query('SELECT * FROM agendamentos.consultas WHERE id = $1', [id]);
  return rows[0] || null;
}

async function cancelar(id) {
  const consulta = await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE agendamentos.consultas SET status = 'CANCELADA'
        WHERE id = $1 AND status = 'CONFIRMADA' RETURNING *`,
      [id],
    );
    if (!rows[0]) {
      const existe = await client.query('SELECT 1 FROM agendamentos.consultas WHERE id = $1', [id]);
      if (existe.rowCount === 0) throw new HttpError(404, 'Consulta não encontrada');
      throw new HttpError(409, 'Consulta já cancelada');
    }
    await agenda.liberarHorario(client, rows[0].horario_id);
    return rows[0];
  });

  const paciente = await pacientes.buscarPaciente(consulta.paciente_id);
  const horario = await agenda.buscarHorario(consulta.horario_id);
  if (paciente && horario) publicarEvento('consulta.cancelada', consulta, paciente, horario);
  return consulta;
}

module.exports = { agendar, buscar, cancelar };
