const { Router } = require('express');
const service = require('./service');

const router = Router();

router.post('/consultas', async (req, res) => {
  const { consulta, criada } = await service.agendar(req.body ?? {}, req.get('Idempotency-Key'));
  res.status(criada ? 201 : 200).json(consulta);
});

router.get('/consultas/:id', async (req, res) => {
  const consulta = await service.buscar(req.params.id);
  if (!consulta) return res.status(404).json({ erro: 'Consulta não encontrada' });
  res.json(consulta);
});

router.delete('/consultas/:id', async (req, res) => {
  res.json(await service.cancelar(req.params.id));
});

module.exports = router;
