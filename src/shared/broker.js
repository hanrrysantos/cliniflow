const amqp = require('amqplib');

const EXCHANGE = 'consultas';
const QUEUE = 'notificacoes';
const DLX = 'consultas.dlx';
const DLQ = 'notificacoes.dlq';

let channel = null;

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect({ onReady } = {}) {
  for (;;) {
    try {
      const conn = await amqp.connect(process.env.RABBITMQ_URL);
      const ch = await conn.createChannel();

      await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
      await ch.assertExchange(DLX, 'fanout', { durable: true });
      await ch.assertQueue(DLQ, { durable: true });
      await ch.bindQueue(DLQ, DLX, '');
      await ch.assertQueue(QUEUE, { durable: true, deadLetterExchange: DLX });
      await ch.bindQueue(QUEUE, EXCHANGE, 'consulta.*');

      conn.on('error', (err) => console.error('[broker] erro:', err.message));
      conn.on('close', () => {
        console.error('[broker] conexão perdida, reconectando...');
        channel = null;
        esperar(2000).then(() => connect({ onReady }));
      });

      channel = ch;
      console.log('[broker] conectado');
      if (onReady) await onReady(ch);
      return;
    } catch (err) {
      console.error('[broker] indisponível, nova tentativa em 2 s:', err.message);
      await esperar(2000);
    }
  }
}

function isConnected() {
  return channel !== null;
}

function publish(routingKey, payload, tentativa = 1) {
  if (channel) {
    channel.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(payload)), {
      persistent: true,
      messageId: payload.event_id,
      contentType: 'application/json',
    });
    console.log(`[broker] publicado ${routingKey} ${payload.event_id}`);
    return;
  }
  if (tentativa > 5) {
    console.error(`[broker] evento perdido após 5 tentativas: ${routingKey} ${payload.event_id}`);
    return;
  }
  console.error(`[broker] fora do ar, tentativa ${tentativa} de publicar ${payload.event_id}`);
  setTimeout(() => publish(routingKey, payload, tentativa + 1), 2000);
}

module.exports = { connect, isConnected, publish, QUEUE };
