# CliniFlow — Lambda de miniaturas (Integrante 2)

Implementação da [seção 5 dos contratos do grupo](../../docs/CONTRATOS.md). A PoC é local: o [módulo de infraestrutura](../../docs/INFRA.md) registra S3 e Lambda no LocalStack; o Worker roda em `wrangler dev`. O Integrante 1 cuida da API e da reconciliação dos estados. Este diretório contém o código da função, sem credenciais; o registro da função e do gatilho fica em `localstack/init/02-lambda.sh`.

## Fluxo

1. `handler.js` recebe o evento real `s3:ObjectCreated:*`, decodifica a chave e só aceita `medicos/{medico_id}/{foto_id}.{jpg|png|webp}` no bucket `cliniflow-originais`. Chaves fora do padrão são registradas e ignoradas.
2. Antes de ler o original, a Lambda faz `HEAD` de `cliniflow-miniaturas/medicos/{medico_id}/{foto_id}.webp`. Se existe, registra duplicata e termina.
3. `armazenamento.js` lê o original com `GetObject`. Se houver `versionId`, lê essa versão; caso contrário, exige o ETag do evento via `If-Match`. A leitura é limitada a 5 242 880 bytes, mesmo se `ContentLength` não vier. Isso evita tratar um conteúdo novo como se fosse o objeto de um evento antigo.
4. `servico-imagens.js` confere assinatura JPEG, PNG ou WebP, decodifica com `sharp`, aplica orientação EXIF e gera WebP 200×200 com recorte **central** (`cover`). O limite adicional de pixels reduz o risco de imagens comprimidas que consomem muita memória.
5. A miniatura é gravada no bucket de saída com `Content-Type: image/webp`. Um arquivo inválido, corrompido ou grande demais produz `erros/medicos/{medico_id}/{foto_id}.json`, com `motivo`, `detalhe` e `ocorrido_em` como no contrato.

`PutObject` usa `If-None-Match: *` para miniatura e erro. Assim, duas invocações que disputam a mesma chave não se sobrescrevem. O `HEAD` evita trabalho comum em eventos repetidos; a gravação condicional cobre a corrida entre `HEAD` e `PUT`. Uma resposta `412` é tratada como objeto já existente; `409` é propagado para retentativa. Eventos S3 são entregues [pelo menos uma vez e podem chegar fora de ordem](https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventNotifications.html).

O contrato pressupõe uma chave original nova por `foto_id`. Se o mesmo objeto original for sobrescrito depois que sua miniatura já existe, o `HEAD` fará a Lambda manter a miniatura anterior. Para substituir a foto, a API deve gerar um novo `foto_id`.

Falhas permanentes de imagem gravam o JSON e terminam com sucesso. Falhas do S3, permissões e recursos são lançadas para a política de [retentativas assíncronas da Lambda](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-error-handling.html). Se a gravação do erro também falhar, a exceção é propagada. Em evento com vários registros, uma exceção causa retentativa do lote inteiro; os registros concluídos anteriormente são reconhecidos como duplicatas.

## Configuração

| Variável | Padrão | Uso |
|---|---|---|
| `BUCKET_ORIGINAIS` | `cliniflow-originais` | Bucket que dispara o evento |
| `BUCKET_MINIATURAS` | `cliniflow-miniaturas` | Miniaturas e JSON de erros |
| `MAX_IMAGE_BYTES` | `5242880` | Limite de bytes do original |
| `MAX_IMAGE_PIXELS` | `25000000` | Limite de pixels após decodificar |
| `S3_ENDPOINT` | não definido | O script local usa `http://localhost.localstack.cloud:4566` dentro do container da Lambda; omitido na AWS real |
| `AWS_REGION` | SDK | `us-east-1` no LocalStack |

Quando `S3_ENDPOINT` está definido, o SDK usa `forcePathStyle: true`. As credenciais `test`/`test` do LocalStack devem ser injetadas pelo ambiente de execução, conforme [§6 dos contratos](../../docs/CONTRATOS.md). Nunca use o token pessoal do LocalStack no código ou no Git.

**Integração no LocalStack:** `docker-compose.yml` instala as dependências em Linux pelo serviço `empacotador`; `localstack/init/02-lambda.sh` registra `handler.handler`, Node.js 22, x86_64, 512 MiB, timeout de 30 s e a notificação `s3:ObjectCreated:*` no bucket de originais com prefixo `medicos/`. Esses parâmetros devem ser confirmados no teste integrado. O [template AWS](../../infra/template.yaml) documenta as permissões da função e da API para os buckets; a permissão para o S3 invocar a Lambda é separada. Se houver versionamento, acrescentar `s3:GetObjectVersion`; se houver KMS gerenciado pelo cliente, acrescentar as permissões de chave necessárias. O pacote `sharp` contém binários nativos e precisa ser instalado em Linux compatível com o [runtime e a arquitetura da Lambda](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-layers.html).

Para gerar um ZIP **local**, dentro deste diretório e em ambiente Linux compatível:

```bash
npm ci --omit=dev
zip -r function.zip handler.js servico-imagens.js armazenamento.js package.json node_modules
```

O ZIP manual é uma alternativa ao serviço `empacotador` do Compose. O script de registro já existe no repositório, mas o pacote ainda não foi validado por nós como executável dentro do LocalStack.

## Testes e comparação

```bash
cd serverless/processador-imagens
npm ci
npm test
node processar-local.js foto.png miniatura.webp
```

`processar-local.js` reutiliza a mesma `gerarMiniatura` da Lambda e imprime bytes de entrada, bytes de saída e duração do redimensionamento. O Integrante 4 pode usá-lo para comparar o algoritmo local com o fluxo, separando upload, espera do evento e execução. LocalStack e `wrangler dev` não representam latência real da borda nem cold start real da AWS.

## Contratos com os outros integrantes

- **Integrante 1:** a API reconcilia `PROCESSANDO` por `HEAD` da miniatura e depois `GET` do erro. A Lambda não acessa o banco. O identificador `foto_id` já distingue envios; a API decide qual é a foto atual do médico.
- **Integrante 3:** o código de infraestrutura cria buckets, pacote Linux, função e evento S3 → Lambda; falta confirmar a execução no LocalStack. Dois buckets impedem que a miniatura dispare novamente a função.
- **Integrante 4:** executar os [11 cenários da seção 7](../../docs/CONTRATOS.md) no fluxo completo. Os testes aqui cobrem a Lambda sem credenciais AWS. Ainda faltam os testes de integração no LocalStack.

## Fundamentos para apresentação

**Serverless** significa que o provedor administra a infraestrutura de execução. **FaaS** executa uma função quando um evento ou chamada a invoca; aqui, criar um objeto no S3 é o gatilho da Lambda. O processamento é **assíncrono** porque o upload termina antes da miniatura ficar pronta. **Idempotência** significa que receber o mesmo evento de novo não duplica o resultado. A [AWS explica o modelo da Lambda](https://docs.aws.amazon.com/lambda/latest/dg/welcome.html).

Uma **cold start** inclui preparar o ambiente e carregar o código antes do handler. Memória limita recursos e influencia CPU, duração e custo. Comparado ao processamento no monólito, a Lambda pode escalar separadamente da API, mas introduz dependência de S3, espera do evento, retentativas e observabilidade distribuída. O LocalStack demonstra o fluxo funcional, sem produzir métricas equivalentes às da nuvem. Veja o [ciclo de vida da Lambda](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html).
