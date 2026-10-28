// Interface pública do módulo Notificações (usada apenas pelo worker)
const consumer = require('./consumer');

module.exports = { iniciar: consumer.iniciar };
