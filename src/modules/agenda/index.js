// Interface pública do módulo Agenda
const router = require('./routes');
const { buscarHorario, reservarHorario, liberarHorario } = require('./service');

module.exports = { router, buscarHorario, reservarHorario, liberarHorario };
