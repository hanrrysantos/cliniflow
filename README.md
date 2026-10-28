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
