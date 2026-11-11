const router = require('./routes');
const { buscarMedico, buscarHorario, reservarHorario, liberarHorario } = require('./service');

module.exports = { router, buscarMedico, buscarHorario, reservarHorario, liberarHorario };
