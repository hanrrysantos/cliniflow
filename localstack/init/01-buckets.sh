#!/bin/sh
set -e
awslocal s3 mb s3://cliniflow-originais
awslocal s3 mb s3://cliniflow-miniaturas
