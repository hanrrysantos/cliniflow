# Borda e infraestrutura do pipeline de fotos

Parte do Integrante 3 (Edge e infraestrutura). Implementa [`CONTRATOS.md`](CONTRATOS.md) §2.2 (Worker),
§4 (buckets, chaves e permissões) e §6 (variáveis). Visão geral do fluxo em
[`ARQUITETURA_SERVERLESS.md`](ARQUITETURA_SERVERLESS.md).

| Arquivo | O que é |
|---------|---------|
| `edge/src/index.js` | Cloudflare Worker: `PUT /upload` |
| `edge/wrangler.toml` | Variáveis do Worker |
| `edge/test/index.test.js` | Testes do Worker (sem rede, S3 simulado) |
| `localstack/init/01-buckets.sh` | Cria os buckets e restaura o backup |
| `localstack/init/02-lambda.sh` | Cria a Lambda (`handler.handler`), a permissão de invocação e o gatilho com prefixo `medicos/` |
| `localstack/init/aws-cli` | Usa `lstk aws` se existir na imagem; senão, o `aws` comum apontado para o LocalStack (o `awslocal` está obsoleto) |
| `localstack/shutdown/01-backup.sh` | Copia os buckets para `localstack/dados/` ao desligar |
| `docker-compose.yml` (serviços `empacotador` e `localstack`) | Instala as dependências da Lambda em Linux e sobe o LocalStack |
| `infra/template.yaml` | Mesma infraestrutura para a AWS real (AWS SAM), com as permissões mínimas |

## Papel da borda

O Worker é a **porta de entrada do arquivo**. A API do CliniFlow nunca recebe os bytes da imagem:
ela só registra a foto e gera uma URL pré-assinada. O Worker recebe o arquivo, valida e só então o
repassa ao S3, **nesta ordem** (§2.2):

1. **Destino:** `X-Upload-Url` precisa estar na origem `S3_ALLOWED_ORIGIN`, no bucket
   `BUCKET_ORIGINAIS` e na chave `medicos/{n}/{uuid}.{jpg|png|webp}`. Senão, responde `403`. Isso
   impede que o Worker vire um proxy aberto para qualquer URL.
2. **Tipo:** o `Content-Type` precisa ser JPEG, PNG ou WebP (senão `415`) e combinar com a extensão
   da chave (senão `400`).
3. **Tamanho:** até 5 MB, conferido pelo `Content-Length` e pelo tamanho real lido (senão `413`).
4. **Conteúdo:** os primeiros bytes do arquivo (*magic bytes*) precisam ser do tipo declarado (senão `415`).
5. **Repasse:** `PUT` na URL pré-assinada. Respostas: `202 {status: ENVIADO, chave}`. Se o S3
   responder 403, a URL expirou e o Worker devolve `403`. Se o S3 der erro ou estiver fora do ar, `502`.

Arquivo recusado não chega ao S3, então não dispara a Lambda nem gera custo de armazenamento ou de
invocação.

**O Worker não tem credencial AWS.** A URL pré-assinada vale só para uma chave e só por 5 minutos
(menor privilégio). Como ela também poderia ser usada direto no S3, a Lambda repete a validação
(defesa em profundidade, §5).

**Borda e processamento regional:** a borda serve para trabalho curto, sem estado e perto do usuário:
validar, recusar e repassar. Gerar a miniatura precisa de CPU, memória e biblioteca nativa de imagem,
e o plano gratuito dos Workers limita a CPU a 10 ms por requisição. Por isso esse trabalho fica na
Lambda, na mesma região do S3. Com `wrangler dev`, o Worker roda na própria máquina, então a PoC
**não mede ganho de latência de borda** (ver as limitações em `ARQUITETURA_SERVERLESS.md`).

## Separação entre entrada e saída (sem laço)

| Bucket | Gatilho | Quem grava | Quem lê |
|--------|---------|------------|---------|
| `cliniflow-originais` | `s3:ObjectCreated:*`, prefixo `medicos/` → Lambda | Worker (via URL pré-assinada) | Lambda |
| `cliniflow-miniaturas` | **nenhum** | Lambda | API, cliente (URL pré-assinada) |

A miniatura é gravada num bucket **sem gatilho**, então nunca dispara a função de novo, mesmo que
algum filtro de prefixo esteja errado.

## Permissões (menor privilégio, `infra/template.yaml`)

| Identidade | Pode | Por quê |
|------------|------|---------|
| Worker | nada na AWS | usa só a URL pré-assinada recebida |
| API (`UsuarioApi`) | `s3:PutObject` em `originais/medicos/*`; `s3:GetObject` em `miniaturas/*`; `s3:ListBucket` em `miniaturas` | assinar a URL de upload; HEAD e GET da reconciliação e URL de leitura |
| Lambda (`FuncaoMiniatura`) | `s3:GetObject` em `originais/medicos/*`; `s3:GetObject` e `s3:PutObject` em `miniaturas/medicos/*` e `miniaturas/erros/medicos/*`; `s3:ListBucket` em `miniaturas` | ler o original; checar evento repetido; gravar miniatura ou erro |
| Público | nada: os dois buckets bloqueiam acesso público | |

Por que o `s3:ListBucket`: na AWS real, sem ele, o `HEAD` de um objeto que não existe devolve `403`
em vez de `404`. A Lambda e a reconciliação da API tratariam "ainda não existe" como falha.

O LocalStack não aplica IAM por padrão. Por isso, no ambiente local, as permissões existem só como
documentação e no template. Na AWS real elas são aplicadas.

## Variáveis

**Worker** (`edge/wrangler.toml`; não há segredos):

| Variável | Local | AWS real |
|----------|-------|----------|
| `S3_ALLOWED_ORIGIN` | `http://localhost:4566` | `https://<BucketOriginais>.s3.<regiao>.amazonaws.com` |
| `BUCKET_ORIGINAIS` | `cliniflow-originais` | output `BucketOriginais` |
| `MAX_BYTES` | `5242880` | `5242880` |

**API** (`docker-compose.yml`, já preenchidas com os valores locais da §6): `S3_ENDPOINT`,
`S3_PUBLIC_ENDPOINT`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (`test`/`test` no
LocalStack), `BUCKET_ORIGINAIS`, `BUCKET_MINIATURAS`, `WORKER_URL` e `FOTO_TIMEOUT_SEGUNDOS`.

**LocalStack:** `LOCALSTACK_AUTH_TOKEN` no arquivo `.env` da raiz, que não vai para o Git.

## Como executar (local)

Pré-requisitos: Docker com Docker Compose, Node.js 20+ e uma conta gratuita no LocalStack (plano Hobby).

### 1. Token do LocalStack

```bash
cp .env.example .env
```

Abra o `.env` e coloque o seu token em `LOCALSTACK_AUTH_TOKEN`.

### 2. Subir tudo

```bash
docker compose up -d --build
docker compose logs localstack | grep "\[init\]"
```

O serviço `empacotador` (imagem `node:22`) copia o código de `serverless/processador-imagens/` para
um volume e roda `npm ci --omit=dev` em Linux, porque o `sharp` é nativo. O `node_modules` do seu
computador não é tocado. Depois, o LocalStack sobe e roda os scripts de `localstack/init/`. A última
linha esperada é `[init] Lambda cliniflow-processador-imagens e gatilho prontos.`, e só então o
LocalStack fica `healthy`.

Se o código da função mudar, rode `docker compose up -d --force-recreate empacotador localstack`.

### 3. Reinício do LocalStack (backup dos buckets)

O plano Hobby não tem persistência: ao reiniciar, o LocalStack volta vazio, mas o Postgres continua
com as fotos. Para a demonstração não perder os arquivos:

- ao desligar (`docker compose stop` ou `down`), `localstack/shutdown/01-backup.sh` copia os dois
  buckets para `localstack/dados/`, que não vai para o Git;
- ao subir, `01-buckets.sh` devolve os arquivos **antes** de o `02-lambda.sh` criar o gatilho, então
  nada é reprocessado.

Limites: se o container for derrubado à força (kill, queda de energia), o backup fica com o estado do
último desligamento normal. Para zerar tudo, apague a pasta `localstack/dados/`.

### 4. Worker

```bash
cd edge
npm install
npm test
npx wrangler dev
```

`npm test` roda 13 testes, sem rede: cenários 1, 4, 6 e 7 da §7, mais 400, 413, 415, 502, 404, 405 e o
preflight de CORS.
O `wrangler dev` sobe o Worker em `http://localhost:8787`.

### 5. Fluxo completo

```bash
curl -s -X POST http://localhost:8080/medicos/1/foto -H "Content-Type: application/json" -d '{"content_type":"image/jpeg","tamanho":348120}'
curl -s -X PUT http://localhost:8787/upload -H "Content-Type: image/jpeg" -H "X-Upload-Url: <upload.headers.X-Upload-Url>" --data-binary @foto.jpg
curl -s http://localhost:8080/fotos/<foto_id>
```

Para inspecionar os buckets direto no LocalStack:

```bash
docker compose exec localstack awslocal s3 ls s3://cliniflow-miniaturas --recursive
```

## Como implantar na AWS e na Cloudflare reais

Requer AWS CLI, SAM CLI e uma conta Cloudflare.

```bash
cd infra
sam build --use-container   # sharp é nativo: compila em container Linux
sam deploy --guided --stack-name cliniflow-fotos --capabilities CAPABILITY_IAM
aws iam create-access-key --user-name <output UsuarioApi>
```

A chave gerada vai para `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` da API. Os nomes dos buckets
vão para `BUCKET_*`. Remova `S3_ENDPOINT` e `S3_PUBLIC_ENDPOINT` para o SDK usar a AWS.

Depois, em `edge/wrangler.toml`, ajuste `S3_ALLOWED_ORIGIN` e `BUCKET_ORIGINAIS` e publique:

```bash
cd edge
npx wrangler login
npx wrangler deploy
```

Para remover tudo:

```bash
aws s3 rm s3://<BucketOriginais> --recursive
aws s3 rm s3://<BucketMiniaturas> --recursive
sam delete --stack-name cliniflow-fotos
npx wrangler delete
```

## Fontes

- Cloudflare. *How Workers works*. https://developers.cloudflare.com/workers/reference/how-workers-works/
- Cloudflare. *Workers limits* (CPU por requisição, tamanho de corpo). https://developers.cloudflare.com/workers/platform/limits/
- AWS. *Sharing objects with presigned URLs*. https://docs.aws.amazon.com/AmazonS3/latest/userguide/ShareObjectPreSignedURL.html
- AWS. *Tutorial: Using an Amazon S3 trigger to create thumbnail images*. https://docs.aws.amazon.com/lambda/latest/dg/with-s3-tutorial.html
- AWS. *Process Amazon S3 event notifications with Lambda* (aviso sobre invocação recursiva e uso de buckets separados). https://docs.aws.amazon.com/lambda/latest/dg/with-s3.html
- AWS. *Security best practices in IAM* (menor privilégio). https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html
- LocalStack. *Initialization hooks*. https://docs.localstack.cloud/references/init-hooks/
