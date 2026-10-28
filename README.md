# CliniFlow

MVP de um sistema distribuído de **agendamento de consultas**, desenvolvido para a atividade
"Arquitetura de um sistema distribuído".

- Proposta arquitetural (Etapas 1 a 4): [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md)
- Divisão de tarefas do grupo: [`docs/DIVISAO_TAREFAS.md`](docs/DIVISAO_TAREFAS.md)

## Visão rápida

- **Estilo:** monólito modular (Node.js + Express) + worker separado de notificações
- **Módulos:** Pacientes, Agenda, Agendamentos, Notificações
- **Entrada:** API Gateway (Nginx)
- **Comunicação:** REST síncrono + eventos assíncronos via RabbitMQ
- **Dados:** PostgreSQL com um schema por módulo

## Fluxo de uma requisição (exemplo)

A paciente **Ana** quer marcar uma consulta com o **Dr. João** na terça às 14h.

### 1. A Ana envia o pedido

```
POST http://localhost:8080/consultas
{ "paciente_id": 1, "horario_id": 1 }
```

O pedido chega ao **API Gateway (Nginx)**, que o repassa para uma das réplicas da **API**.

### 2. A API faz o trabalho principal (parte **síncrona**)

O módulo **Agendamentos**:

1. pergunta ao módulo **Pacientes** se a paciente 1 existe → sim, é a Ana;
2. pergunta ao módulo **Agenda** se o horário 1 existe → sim, terça 14h com o Dr. João;
3. abre uma transação no banco: marca o horário como `RESERVADO`, grava a consulta como
   `CONFIRMADA` e faz `COMMIT`.

Nesse ponto **a consulta já está garantida no banco**.

### 3. A API publica um evento e responde (começa a parte **assíncrona**)

A API não envia o e-mail ela mesma. Ela apenas publica um evento no **RabbitMQ**:

```json
{
  "event_id": "ead3eadc-...",
  "tipo": "consulta.agendada",
  "paciente": { "nome": "Ana", "email": "ana@email.com" },
  "horario": { "data_hora": "2026-11-03T14:00:00-03:00", "medico": "Dr. João" }
}
```

A publicação leva poucos milissegundos e **a API não espera ninguém processar o evento**. Em
seguida ela responde `201 Created` — a Ana já vê "consulta confirmada", **antes de o e-mail
ser enviado**.

### 4. O evento fica guardado na fila

O RabbitMQ funciona como uma caixa de correio: o evento fica na fila durável `notificacoes`
até alguém vir buscá-lo.

### 5. O worker processa o evento

O **worker** (`src/worker.js`) é outro processo, em outro container, que só escuta essa fila.
Ao receber o evento, ele:

1. verifica no banco se esse `event_id` já foi tratado (idempotência);
2. "envia" o e-mail (simulado com `console.log`);
3. confirma ao RabbitMQ (`ack`) — só então o evento sai da fila.

### Onde está cada tipo de comunicação

| Comunicação | Entre | Onde está no código |
|-------------|-------|---------------------|
| Síncrona (HTTP/REST) | Cliente → Gateway → API | `gateway/nginx.conf`, `src/app.js`, `src/modules/*/routes.js` |
| Síncrona (chamada de função) | Agendamentos → Pacientes / Agenda | `src/modules/agendamentos/service.js` (`buscarPaciente`, `reservarHorario`) |
| Assíncrona (publicação) | Agendamentos → RabbitMQ | `src/modules/agendamentos/service.js` (`publicarEvento`), `src/shared/broker.js` (`publish`) |
| Assíncrona (consumo) | RabbitMQ → Notificações | `src/modules/notificacoes/consumer.js`, `src/modules/notificacoes/service.js` |

Pacientes e Agenda são síncronos porque o resultado é necessário na hora (sem saber se o horário
foi reservado, não dá para confirmar a consulta). O assíncrono entra só onde a resposta pode
esperar: o e-mail.

## Cenários testados

### Cenários de sucesso

| Cenário | Requisição | Resultado |
|---------|------------|-----------|
| Cadastrar paciente | `POST /pacientes` | `201` com o paciente criado |
| Cadastrar médico | `POST /medicos` | `201` com o médico criado |
| Criar horário | `POST /medicos/:id/horarios` | `201` com o horário `LIVRE` |
| Listar horários livres | `GET /horarios?status=LIVRE` | `200` com a lista |
| Agendar consulta | `POST /consultas` | `201` com a consulta `CONFIRMADA`; worker registra o e-mail de confirmação |
| Consultar status | `GET /consultas/:id` | `200` com a consulta |
| Cancelar consulta | `DELETE /consultas/:id` | `200` com a consulta `CANCELADA`; horário volta a `LIVRE`; worker registra o e-mail de cancelamento |
| Healthcheck | `GET /health` | `200` `{"status":"ok","db":"ok","broker":"ok"}` |

### Cenários de erro de requisição

| Cenário | Requisição | Resultado |
|---------|------------|-----------|
| Campos obrigatórios ausentes | `POST /pacientes` sem `email` | `400` "nome e email são obrigatórios" |
| Parâmetro inválido | `GET /pacientes/abc` | `400` "Parâmetro inválido" |
| E-mail repetido | `POST /pacientes` com e-mail já usado | `409` "email já cadastrado" |
| Médico inexistente | `POST /medicos/99/horarios` | `404` "Médico não encontrado" |
| Paciente inexistente | `POST /consultas` com `paciente_id` inválido | `404` "Paciente não encontrado" |
| Horário já reservado | `POST /consultas` para horário ocupado | `409` "Horário indisponível" |
| Cancelar duas vezes | `DELETE /consultas/:id` repetido | `409` "Consulta já cancelada" |
| Rota inexistente | `GET /nada` | `404` "Rota não encontrada" |

### Cenários de falha (Etapa 3)

| Cenário | Como reproduzir | Resultado |
|---------|-----------------|-----------|
| Pedido reenviado (duplicado) | Repetir `POST /consultas` com o mesmo header `Idempotency-Key` | `200` com a **mesma** consulta, sem criar outra |
| Dois pacientes disputando o último horário | Enviar dois `POST /consultas` simultâneos para o mesmo horário | Um recebe `201`, o outro `409` — a reserva atômica impede a dupla marcação |
| Mensagem entregue mais de uma vez | Publicar novamente um evento com o mesmo `event_id` | Worker registra "evento duplicado, ignorado"; nenhum e-mail repetido |
| Evento não processado | Agendar para um paciente com `falha` no e-mail | Worker tenta 3 vezes e move o evento para `notificacoes.dlq` (visível em `http://localhost:15672`) |
| Worker indisponível | `docker compose stop worker` e agendar | API responde `201` normalmente; evento fica na fila e é processado quando o worker volta (`docker compose start worker`) |
| Banco indisponível | `docker compose stop postgres` | API responde `503` "Serviço temporariamente indisponível"; `/health` mostra `db: indisponivel` |
| Uma réplica da API fora do ar | `docker stop cliniflow-api-1` | Gateway envia as requisições para a outra réplica; respostas continuam `200` |
| Resposta lenta (configurado, não reproduzido nos testes) | Query acima de 2 s ou requisição acima de 5 s | `504` "Tempo limite excedido"; a transação faz rollback e o horário não fica preso |

## Como rodar

Pré-requisito: Docker com Docker Compose.

```bash
docker compose up -d --build
curl http://localhost:8080/health
```

| Endereço | O quê |
|----------|-------|
| `http://localhost:8080` | API (via API Gateway Nginx) |
| `http://localhost:15672` | Painel do RabbitMQ (guest/guest) — filas `notificacoes` e `notificacoes.dlq` |

## Demonstração

- `requests.http` — roteiro completo: cadastro, agendamento, `Idempotency-Key`, conflito 409,
  cancelamento e evento que falha 3 vezes e vai para a DLQ.
- `docker compose logs -f worker` — e-mails simulados, eventos duplicados ignorados, retentativas.
- Falhas: `docker compose stop worker` (eventos ficam na fila), `docker compose stop postgres`
  (API responde `503`), `docker stop cliniflow-api-1` (gateway usa a outra réplica).

## Estrutura

```
docker-compose.yml   gateway/nginx.conf   db/init.sql   Dockerfile
src/
  app.js             # API Express (Pacientes, Agenda, Agendamentos)
  worker.js          # processo de Notificações
  shared/            # db (transações), broker (RabbitMQ + DLQ), HttpError
  modules/
    pacientes/  agenda/  agendamentos/  notificacoes/
```
