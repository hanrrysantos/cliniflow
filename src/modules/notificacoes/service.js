const db = require('../../shared/db');

const MENSAGENS = {
  'consulta.agendada': 'Sua consulta foi confirmada',
  'consulta.cancelada': 'Sua consulta foi cancelada',
};

function comTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`envio excedeu ${ms} ms`)), ms)),
  ]);
}

// "Envio" de e-mail simulado. E-mails contendo "falha" simulam um provedor com erro,
// para demonstrar as novas tentativas e a DLQ.
async function enviarEmail(destinatario, assunto, corpo) {
  if (destinatario.includes('falha')) throw new Error('provedor de e-mail recusou o envio');
  console.log(`[email] para=${destinatario} | ${assunto} | ${corpo}`);
}

// Processa um evento de forma idempotente: o event_id é gravado na mesma transação do envio.
async function processar(evento) {
  await db.withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `INSERT INTO notificacoes.notificacoes_enviadas (event_id, tipo, destinatario)
       VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING`,
      [evento.event_id, evento.tipo, evento.paciente.email],
    );
    if (rowCount === 0) {
      console.log(`[notificacoes] evento ${evento.event_id} duplicado, ignorado`);
      return;
    }
    const corpo = `${evento.paciente.nome}, consulta com ${evento.horario.medico} em ${evento.horario.data_hora}`;
    await comTimeout(enviarEmail(evento.paciente.email, MENSAGENS[evento.tipo] || evento.tipo, corpo), 3000);
  });
}

module.exports = { processar };
