const express = require('express');
const db = require('./shared/db');
const broker = require('./shared/broker');
const pacientes = require('./modules/pacientes');
const agenda = require('./modules/agenda');
const agendamentos = require('./modules/agendamentos');

const app = express();
app.use(express.json());

// Timeout por requisição: 5 s -> 504
app.use((req, res, next) => {
  const timer = setTimeout(() => {
    if (!res.headersSent) res.status(504).json({ erro: 'Tempo limite excedido' });
  }, 5000);
  res.on('close', () => clearTimeout(timer));
  next();
});

app.get('/health', async (req, res) => {
  const brokerStatus = broker.isConnected() ? 'ok' : 'indisponivel';
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', db: 'ok', broker: brokerStatus });
  } catch {
    res.status(503).json({ status: 'erro', db: 'indisponivel', broker: brokerStatus });
  }
});

app.use(pacientes.router);
app.use(agenda.router);
app.use(agendamentos.router);

app.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada' }));

// Traduz erros conhecidos para códigos HTTP
app.use((err, req, res, next) => {
  if (res.headersSent) return;
  if (err.status) return res.status(err.status).json({ erro: err.message });
  if (err.code === '22P02') return res.status(400).json({ erro: 'Parâmetro inválido' });
  if (err.code === '23505') return res.status(409).json({ erro: 'Registro duplicado' });
  if (err.code === '57014') return res.status(504).json({ erro: 'Banco demorou demais para responder' });
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || /timeout/i.test(err.message)) {
    return res.status(503).json({ erro: 'Serviço temporariamente indisponível, tente novamente em instantes' });
  }
  console.error(err);
  res.status(500).json({ erro: 'Erro interno' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[api] ouvindo na porta ${PORT}`));
broker.connect();
