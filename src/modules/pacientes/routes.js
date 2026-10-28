const { Router } = require('express');
const service = require('./service');

const router = Router();

router.post('/pacientes', async (req, res) => {
  res.status(201).json(await service.criar(req.body ?? {}));
});

router.get('/pacientes/:id', async (req, res) => {
  const paciente = await service.buscarPaciente(req.params.id);
  if (!paciente) return res.status(404).json({ erro: 'Paciente não encontrado' });
  res.json(paciente);
});

module.exports = router;
