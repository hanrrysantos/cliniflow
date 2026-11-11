#!/bin/sh
. /etc/localstack/init/ready.d/aws-cli
# Copia os buckets para ./localstack/dados ao desligar: o plano Hobby do LocalStack não tem persistência,
# e o banco guarda fotos que apontam para esses arquivos. O 01-buckets.sh restaura na próxima subida.
# Sem --delete: se a subida falhar e os buckets ficarem vazios, o backup anterior não é apagado.
for b in cliniflow-originais cliniflow-miniaturas; do
  AWS s3 sync "s3://$b" "/var/lib/cliniflow-backup/$b" --only-show-errors
done
echo "[shutdown] buckets copiados para localstack/dados"
