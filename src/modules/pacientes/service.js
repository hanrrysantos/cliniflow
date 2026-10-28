const db = require('../../shared/db');
const HttpError = require('../../shared/http-error');

async function criar({ nome, email, telefone }) {
  if (!nome || !email) throw new HttpError(400, 'nome e email são obrigatórios');
  try {
    const { rows } = await db.query(
      'INSERT INTO pacientes.pacientes (nome, email, telefone) VALUES ($1, $2, $3) RETURNING *',
      [nome, email, telefone || null],
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'email já cadastrado');
    throw err;
  }
}

async function buscarPaciente(id) {
  const { rows } = await db.query('SELECT id, nome, email, telefone FROM pacientes.pacientes WHERE id = $1', [id]);
  return rows[0] || null;
}

module.exports = { criar, buscarPaciente };
