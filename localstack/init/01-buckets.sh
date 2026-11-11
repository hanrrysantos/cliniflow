#!/bin/sh
. /etc/localstack/init/ready.d/aws-cli
set -e
AWS s3 mb s3://cliniflow-originais
AWS s3 mb s3://cliniflow-miniaturas

# Restaura o backup do último desligamento (localstack/shutdown/01-backup.sh).
# Roda antes do 02-lambda.sh criar o gatilho, então os originais restaurados não são reprocessados.
for b in cliniflow-originais cliniflow-miniaturas; do
  if [ -d "/var/lib/cliniflow-backup/$b" ]; then
    AWS s3 sync "/var/lib/cliniflow-backup/$b" "s3://$b" --only-show-errors
    echo "[init] $b restaurado do backup"
  fi
done
