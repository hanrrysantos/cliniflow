const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  statement_timeout: 2000, // nenhuma query segura conexão por mais de 2 s
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => console.error('[db] erro no pool:', err.message));

function query(text, params) {
  return pool.query(text, params);
}

// Executa fn(client) dentro de uma transação; faz ROLLBACK se algo lançar erro.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resultado = await fn(client);
    await client.query('COMMIT');
    return resultado;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { query, withTransaction };
