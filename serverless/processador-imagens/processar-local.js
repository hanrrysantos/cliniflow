const fs = require('node:fs/promises');
const { performance } = require('node:perf_hooks');
const { gerarMiniatura } = require('./servico-imagens');
const { configuracaoDoAmbiente } = require('./handler');

async function executar() {
  const [caminhoOriginal, caminhoMiniatura] = process.argv.slice(2);
  if (!caminhoOriginal || !caminhoMiniatura) {
    console.error('Uso: node processar-local.js <imagem-original> <miniatura.webp>');
    process.exitCode = 2;
    return;
  }
  const configuracao = configuracaoDoAmbiente();
  const arquivo = await fs.stat(caminhoOriginal);
  if (arquivo.size > configuracao.limiteBytes) throw new Error('Imagem excede o tamanho máximo');
  const original = await fs.readFile(caminhoOriginal);
  const inicio = performance.now();
  const miniatura = await gerarMiniatura(original, configuracao);
  const tempoProcessamentoMs = performance.now() - inicio;
  await fs.writeFile(caminhoMiniatura, miniatura);
  console.log(JSON.stringify({ bytesEntrada: original.length, bytesSaida: miniatura.length, tempoProcessamentoMs }));
}

executar().catch((erro) => { console.error(erro); process.exitCode = 1; });
