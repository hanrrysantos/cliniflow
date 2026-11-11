CREATE SCHEMA pacientes;
CREATE SCHEMA agenda;
CREATE SCHEMA agendamentos;
CREATE SCHEMA notificacoes;
CREATE SCHEMA fotos;

CREATE TABLE pacientes.pacientes (
  id        SERIAL PRIMARY KEY,
  nome      TEXT NOT NULL,
  email     TEXT NOT NULL UNIQUE,
  telefone  TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ P3 — Módulo Agenda ============
CREATE TABLE agenda.medicos (
  id            SERIAL PRIMARY KEY,
  nome          TEXT NOT NULL,
  especialidade TEXT NOT NULL
);

CREATE TABLE agenda.horarios (
  id        SERIAL PRIMARY KEY,
  medico_id INT NOT NULL REFERENCES agenda.medicos(id),
  data_hora TIMESTAMPTZ NOT NULL,
  status    TEXT NOT NULL DEFAULT 'LIVRE' CHECK (status IN ('LIVRE', 'RESERVADO')),
  UNIQUE (medico_id, data_hora)
);

-- ============ P4 — Módulo Agendamentos ============
-- Sem FK para outros schemas: cada módulo é dono apenas dos seus dados.
CREATE TABLE agendamentos.consultas (
  id              SERIAL PRIMARY KEY,
  paciente_id     INT NOT NULL,
  horario_id      INT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'CONFIRMADA' CHECK (status IN ('CONFIRMADA', 'CANCELADA')),
  idempotency_key TEXT UNIQUE,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reforço contra dupla reserva: só uma consulta CONFIRMADA por horário
CREATE UNIQUE INDEX consultas_horario_confirmada_idx
  ON agendamentos.consultas (horario_id) WHERE status = 'CONFIRMADA';

-- ============ P5 — Módulo Notificações ============
CREATE TABLE notificacoes.notificacoes_enviadas (
  event_id     UUID PRIMARY KEY, -- garante idempotência do consumidor
  tipo         TEXT NOT NULL,
  destinatario TEXT NOT NULL,
  enviado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ Trabalho final — Módulo Fotos (pipeline serverless) ============
-- Sem FK para agenda.medicos: o médico é validado pela interface do módulo Agenda.
CREATE TABLE fotos.fotos (
  id              UUID PRIMARY KEY,
  medico_id       INT  NOT NULL,
  content_type    TEXT NOT NULL,
  tamanho_bytes   INT  NOT NULL,
  chave_original  TEXT NOT NULL UNIQUE,
  chave_miniatura TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'PROCESSANDO' CHECK (status IN ('PROCESSANDO', 'CONCLUIDO', 'ERRO')),
  erro            TEXT,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX fotos_medico_idx ON fotos.fotos (medico_id, criado_em DESC);
