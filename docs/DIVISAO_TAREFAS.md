# Divisão de tarefas — prazo 16:30

Cada pessoa é dona de **uma pasta**, para evitar conflitos no Git. Os contratos abaixo já estão
combinados, então todos podem trabalhar em paralelo desde o início.

## Estrutura do repositório

```
docker-compose.yml        # P1
gateway/nginx.conf        # P1
db/init.sql               # P1 cria o arquivo; cada pessoa escreve a parte do seu schema
src/
  app.js                  # P1 — Express, monta as rotas dos módulos, /health, timeout
  worker.js               # P5 — processo do worker de notificações
  shared/db.js            # P1 — pool do Postgres + helper de transação
  shared/broker.js        # P1 — conexão RabbitMQ, exchange, fila, DLQ, publish()
  modules/
    pacientes/            # P2 — routes.js, service.js, index.js
    agenda/               # P3
    agendamentos/         # P4
    notificacoes/         # P5
requests.http             # P5 — roteiro de demonstração
```

## Contratos entre módulos (não mudar sem avisar o grupo)

```js
// modules/pacientes/index.js
buscarPaciente(id)                 // -> { id, nome, email } | null

// modules/agenda/index.js  (client = conexão da transação, vinda de shared/db.js)
reservarHorario(client, horarioId) // -> true se reservou, false se já estava RESERVADO
liberarHorario(client, horarioId)  // -> void
buscarHorario(horarioId)           // -> { id, data_hora, medico: { nome, especialidade } } | null

// shared/broker.js
publish(routingKey, payload)       // routingKey: 'consulta.agendada' | 'consulta.cancelada'
```

Payload dos eventos:

```json
{
  "event_id": "uuid",
  "tipo": "consulta.agendada",
  "consulta_id": 1,
  "paciente": { "nome": "Ana", "email": "ana@email.com" },
  "horario": { "data_hora": "2026-11-03T14:00:00Z", "medico": "Dr. João" }
}
```

## Responsáveis

| Pessoa | Parte | Entregas |
|--------|-------|----------|
| **P1** | Infra + base da API | `docker-compose.yml` (api, worker, postgres, rabbitmq, nginx), `gateway/nginx.conf`, `src/app.js` (Express, `/health`, timeout de 5 s, erro 503 quando o banco cai), `shared/db.js` (pool + `withTransaction`), `shared/broker.js` (exchange `consultas`, fila `notificacoes`, DLQ `notificacoes.dlq`), esqueleto de `db/init.sql`. Faz a integração final. |
| **P2** | Módulo Pacientes | Tabela `pacientes.pacientes`; `POST /pacientes`, `GET /pacientes/:id` com validação (nome e email obrigatórios); exporta `buscarPaciente`. |
| **P3** | Módulo Agenda | Tabelas `agenda.medicos` e `agenda.horarios`; `POST /medicos`, `POST /medicos/:id/horarios`, `GET /horarios?status=LIVRE`; exporta `reservarHorario` com `UPDATE ... WHERE status='LIVRE'` (corrida pelo último horário), `liberarHorario` e `buscarHorario`. |
| **P4** | Módulo Agendamentos | Tabela `agendamentos.consultas` com índice único parcial; `POST /consultas` (valida paciente, reserva na mesma transação, `409` se ocupado, header `Idempotency-Key`), `DELETE /consultas/:id` (cancela e libera horário), `GET /consultas/:id`; publica os eventos após o commit. |
| **P5** | Módulo Notificações + demo | Tabela `notificacoes.notificacoes_enviadas`; `src/worker.js` consumindo a fila com ack manual, idempotência por `event_id`, até 3 tentativas e depois DLQ; "envio" do e-mail via `console.log`. Escreve o `requests.http` com o roteiro de demonstração (inclui o teste dos dois pedidos no mesmo horário) e revisa o `docs/ARQUITETURA.md`. |

## Cronograma

| Horário | O quê |
|---------|-------|
| até 15:35 | P1 sobe o esqueleto (estrutura, compose, `db.js`, `broker.js`, `app.js` montando as rotas) para a `main`. Os outros já começam o código dos seus módulos seguindo os contratos. |
| 15:35 – 16:05 | Cada pessoa implementa e testa o próprio módulo. |
| 16:05 – 16:20 | Integração: `docker compose up`, rodar o `requests.http` de ponta a ponta, corrigir bugs. |
| 16:20 – 16:30 | README final, último commit e entrega. |

## Regras de Git

- Cada pessoa trabalha numa branch `feat/<modulo>` e só altera a própria pasta (e a sua parte do
  `init.sql`).
- Abre PR (ou faz merge direto, dado o prazo) na `main` assim que o módulo funcionar.
- Mudança em contrato ou em arquivo de outra pessoa: avisar no grupo antes.
