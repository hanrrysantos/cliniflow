const broker = require('./shared/broker');
const notificacoes = require('./modules/notificacoes');

// Processo separado da API: e-mail lento ou com erro não afeta o agendamento.
broker.connect({ onReady: notificacoes.iniciar });
