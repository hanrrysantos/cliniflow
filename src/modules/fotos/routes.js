const { Router } = require('express');
const service = require('./service');

const router = Router();

router.post('/medicos/:id/foto', async (req, res) => {
  res.status(201).json(await service.solicitarUpload(req.params.id, req.body ?? {}));
});

router.get('/medicos/:id/foto', async (req, res) => {
  res.json(await service.fotoDoMedico(req.params.id));
});

router.get('/fotos/:id', async (req, res) => {
  const foto = await service.buscar(req.params.id);
  if (!foto) return res.status(404).json({ erro: 'Foto não encontrada' });
  res.json(foto);
});

module.exports = router;
