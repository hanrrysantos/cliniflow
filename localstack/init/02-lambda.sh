#!/bin/sh
. /etc/localstack/init/ready.d/aws-cli
# Cria a Lambda de miniaturas (serverless/processador-imagens) e o gatilho S3 -> Lambda (CONTRATOS §5).
# Roda depois do 01-buckets.sh, então o backup já foi restaurado e não dispara reprocessamento.
set -e

CONTA=000000000000
REGIAO=us-east-1
FUNCAO=cliniflow-processador-imagens
PACOTE=/opt/processador-imagens # preenchido pelo serviço `empacotador` (dependências instaladas em Linux)

if [ ! -f "$PACOTE/handler.js" ]; then
  echo "[init] $PACOTE/handler.js não existe: Lambda e gatilho NÃO foram criados."
  exit 1
fi

# Role da função. O LocalStack não aplica IAM por padrão; as permissões reais estão em infra/template.yaml.
AWS iam create-role --role-name "$FUNCAO" --assume-role-policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null

(cd "$PACOTE" && python3 -m zipfile -c /tmp/funcao.zip handler.js servico-imagens.js armazenamento.js package.json node_modules)

# S3_ENDPOINT: dentro do container da Lambda, `localstack` não resolve; o DNS do LocalStack resolve este nome.
AWS lambda create-function \
  --function-name "$FUNCAO" \
  --runtime nodejs22.x \
  --architectures x86_64 \
  --handler handler.handler \
  --role "arn:aws:iam::$CONTA:role/$FUNCAO" \
  --zip-file fileb:///tmp/funcao.zip \
  --timeout 30 \
  --memory-size 512 \
  --environment "Variables={BUCKET_ORIGINAIS=cliniflow-originais,BUCKET_MINIATURAS=cliniflow-miniaturas,S3_ENDPOINT=http://localhost.localstack.cloud:4566}" >/dev/null
AWS lambda wait function-active-v2 --function-name "$FUNCAO"

# Permissão separada para o S3 invocar a função (como na AWS real).
AWS lambda add-permission --function-name "$FUNCAO" --statement-id s3-originais \
  --action lambda:InvokeFunction --principal s3.amazonaws.com \
  --source-arn arn:aws:s3:::cliniflow-originais >/dev/null

# Gatilho só no bucket de originais, prefixo medicos/. O bucket de miniaturas não tem gatilho (sem laço).
AWS s3api put-bucket-notification-configuration --bucket cliniflow-originais --notification-configuration "{
  \"LambdaFunctionConfigurations\": [{
    \"LambdaFunctionArn\": \"arn:aws:lambda:$REGIAO:$CONTA:function:$FUNCAO\",
    \"Events\": [\"s3:ObjectCreated:*\"],
    \"Filter\": {\"Key\": {\"FilterRules\": [{\"Name\": \"prefix\", \"Value\": \"medicos/\"}]}}
  }]
}"

echo "[init] Lambda $FUNCAO e gatilho prontos."
