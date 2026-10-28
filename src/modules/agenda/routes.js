const { Router } = require('express');
const service = require('./service');

const router = Router();

router.post('/medicos', async (req, res) => {
  res.status(201).json(await service.criarMedico(req.body ?? {}));
});

router.post('/medicos/:id/horarios', async (req, res) => {
  res.status(201).json(await service.criarHorario(req.params.id, req.body ?? {}));
});

router.get('/horarios', async (req, res) => {
  res.json(await service.listarHorarios(req.query.status));
});

module.exports = router;
