# Divisão de tarefas — prazo 16:30

Cada pessoa é dona de **uma pasta**, para evitar conflitos no Git. Os contratos abaixo já estão
combinados, então todos podem trabalhar em paralelo desde o início.

## Estrutura do repositório

```
docker-compose.yml        # P1
gateway/nginx.conf        # P1
db/init.sql               # P1 commita (já contém uma seção com as tabelas de cada módulo)
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

## Como enviar a sua parte para o repositório

O código completo já foi feito e testado no notebook do P1 e distribuído em `cliniflow.zip`.
Cada integrante commita **apenas os arquivos da sua parte**, com a própria conta do GitHub.

| Pessoa | Arquivos para commitar | Mensagem sugerida |
|--------|------------------------|-------------------|
| **P1** | `package.json`, `package-lock.json`, `.gitignore`, `.dockerignore`, `Dockerfile`, `docker-compose.yml`, `gateway/`, `db/init.sql`, `src/app.js`, `src/shared/`, `README.md`, `docs/DIVISAO_TAREFAS.md` | `feat: adiciona infraestrutura e base da API` |
| **P2** | `src/modules/pacientes/` | `feat(pacientes): adiciona módulo de pacientes` |
| **P3** | `src/modules/agenda/` | `feat(agenda): adiciona médicos, horários e reserva atômica` |
| **P4** | `src/modules/agendamentos/` | `feat(agendamentos): adiciona agendamento e cancelamento de consultas` |
| **P5** | `src/worker.js`, `src/modules/notificacoes/`, `requests.http` | `feat(notificacoes): adiciona worker com retentativas e DLQ` |

Passo a passo (cada integrante):

```bash
git clone git@github.com:hanrrysantos/cliniflow.git   # ou: git pull, se já tiver clonado
cd cliniflow
# extraia o cliniflow.zip em outra pasta e copie para cá SOMENTE os arquivos da sua linha
git add <seus arquivos>
git commit -m "<mensagem sugerida>"
git pull --rebase    # pega o que os colegas já enviaram
git push
```

Como cada pessoa mexe em arquivos diferentes, a ordem dos pushes não gera conflito. Se o push for
recusado, basta repetir `git pull --rebase` e `git push`.

## Como rodar

```bash
docker compose up -d --build
docker compose logs -f worker # e-mails simulados, retentativas e DLQ
```

O roteiro completo da demonstração está em `requests.http`.
