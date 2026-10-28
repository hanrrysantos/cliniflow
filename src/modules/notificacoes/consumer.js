const { QUEUE } = require('../../shared/broker');
const { processar } = require('./service');

const MAX_TENTATIVAS = 3;

async function iniciar(channel) {
  await channel.prefetch(1);
  await channel.consume(QUEUE, async (msg) => {
    if (!msg) return;
    const tentativa = (msg.properties.headers?.['x-tentativa'] || 0) + 1;

    let evento;
    try {
      evento = JSON.parse(msg.content.toString());
    } catch {
      console.error('[notificacoes] mensagem inválida, enviada para a DLQ');
      return channel.nack(msg, false, false);
    }

    try {
      await processar(evento);
      channel.ack(msg); // ack manual: só confirma depois de processar
    } catch (err) {
      if (tentativa < MAX_TENTATIVAS) {
        console.error(`[notificacoes] falha (tentativa ${tentativa}/${MAX_TENTATIVAS}) ${evento.event_id}: ${err.message}`);
        channel.sendToQueue(QUEUE, msg.content, {
          persistent: true,
          contentType: 'application/json',
          headers: { 'x-tentativa': tentativa },
        });
        channel.ack(msg);
      } else {
        console.error(`[notificacoes] ${evento.event_id} falhou ${MAX_TENTATIVAS} vezes, enviado para a DLQ`);
        channel.nack(msg, false, false); // vai para notificacoes.dlq via dead-letter exchange
      }
    }
  });
  console.log(`[notificacoes] consumindo a fila "${QUEUE}"`);
}

module.exports = { iniciar };
