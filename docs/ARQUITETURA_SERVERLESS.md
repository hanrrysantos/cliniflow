# CliniFlow — Arquitetura do pipeline de fotos (Serverless & Edge)

Prova de conceito do tema **Serverless & Edge Computing**, construída sobre o CliniFlow (veja
[`ARQUITETURA.md`](ARQUITETURA.md)). Caso de uso: a clínica envia a foto de perfil de um médico e
uma **miniatura é gerada automaticamente**, sem servidor próprio para isso. O CliniFlow guarda a
ligação entre a foto e o médico e expõe o resultado.

Os contratos detalhados estão em [`CONTRATOS.md`](CONTRATOS.md). Os diagramas seguem o
**modelo C4** (níveis 1 e 2, mais uma visão dinâmica), desenhados em Mermaid.

---

## 1. Contexto (C4 — nível 1)

```mermaid
flowchart TB
    REC["👤 <b>Recepção / Administração</b><br/><i>[Pessoa]</i><br/>Cadastra médicos e envia a foto de perfil"]
    PAC["👤 <b>Paciente</b><br/><i>[Pessoa]</i><br/>Vê os médicos e suas fotos ao agendar"]

    CF["<b>CliniFlow</b><br/><i>[Sistema de software]</i><br/>Agendamento de consultas; registra a foto do médico e o status do processamento"]

    EDGE["<b>Cloudflare Workers</b><br/><i>[Sistema externo — borda]</i><br/>Recebe e valida o upload perto do usuário"]
    AWS["<b>AWS — S3 + Lambda</b><br/><i>[Sistema externo — nuvem]</i><br/>Armazena as imagens e gera a miniatura por evento"]

    REC -- "Solicita upload e consulta o resultado<br/>[HTTPS/JSON]" --> CF
    PAC -- "Consulta médicos e foto<br/>[HTTPS/JSON]" --> CF
    REC -- "Envia o arquivo da imagem<br/>[HTTPS PUT]" --> EDGE
    EDGE -- "Grava o original<br/>[URL pré-assinada S3]" --> AWS
    CF -- "Gera URLs pré-assinadas e verifica o resultado<br/>[API S3]" --> AWS
    PAC -- "Baixa a miniatura<br/>[URL pré-assinada]" --> AWS

    classDef pessoa fill:#08427b,color:#fff,stroke:#052e56
    classDef sistema fill:#1168bd,color:#fff,stroke:#0b4884
    classDef externo fill:#999,color:#fff,stroke:#6b6b6b
    class REC,PAC pessoa
    class CF sistema
    class EDGE,AWS externo
```

---

## 2. Containers (C4 — nível 2)

```mermaid
flowchart LR
    CLI["👤 <b>Cliente</b><br/><i>[Web / curl / requests.http]</i>"]

    subgraph CF["CliniFlow — docker-compose"]
        GW["<b>API Gateway</b><br/><i>[Container: Nginx]</i><br/>Entrada única, rate limit"]
        API["<b>API</b><br/><i>[Container: Node.js + Express, 2 réplicas]</i><br/>Módulos Pacientes, Agenda, Agendamentos<br/>e <b>Fotos</b> (novo)"]
        DB[("<b>PostgreSQL</b><br/><i>[Container]</i><br/>schema <b>fotos</b>: foto ↔ médico, status")]
        MQ["RabbitMQ + worker de notificações<br/><i>(existentes, fora deste fluxo)</i>"]
    end

    subgraph BORDA["Borda — Cloudflare"]
        WK["<b>Worker de entrada</b><br/><i>[Container: Cloudflare Worker]</i><br/>Valida destino, tipo, tamanho e magic bytes;<br/>repassa ao S3"]
    end

    subgraph NUVEM["Nuvem — AWS (local: LocalStack)"]
        S3O[("<b>cliniflow-originais</b><br/><i>[Bucket S3]</i>")]
        LB["<b>Função de miniaturas</b><br/><i>[Container: AWS Lambda, Node.js]</i><br/>Gera 200×200 WebP; trata falhas<br/>e eventos repetidos"]
        S3M[("<b>cliniflow-miniaturas</b><br/><i>[Bucket S3]</i><br/>miniaturas + erros/")]
    end

    CLI -- "1. POST /medicos/:id/foto<br/>5. GET /fotos/:id<br/>[HTTP/JSON]" --> GW
    GW --> API
    API -- "SQL" --> DB
    API -. "assina URL de upload<br/>[SDK S3, sem tráfego]" .-> S3O
    CLI -- "2. PUT /upload (bytes)<br/>[HTTP]" --> WK
    WK -- "3. PUT via URL pré-assinada" --> S3O
    S3O -- "4. evento ObjectCreated<br/>[assíncrono]" --> LB
    LB -- "lê original" --> S3O
    LB -- "grava miniatura ou erro" --> S3M
    API -- "6. HEAD miniatura / GET erro<br/>(reconciliação)" --> S3M
    CLI -- "7. GET miniatura<br/>[URL pré-assinada]" --> S3M

    classDef novo fill:#1168bd,color:#fff,stroke:#0b4884
    classDef existente fill:#438dd5,color:#fff,stroke:#2e6295
    classDef fora fill:#ddd,color:#555,stroke:#aaa
    class WK,LB,S3O,S3M novo
    class GW,API,DB existente
    class MQ fora
```

**Execução local da PoC:** S3 e Lambda rodam no **LocalStack** (`http://localhost:4566`). O Worker
roda com **`wrangler dev`** (`http://localhost:8787`), usando o mesmo motor de execução da
Cloudflare (workerd). Em produção, só mudam os endereços e as credenciais (variáveis de ambiente,
§6 dos contratos).

---

## 3. Fluxo completo (C4 — visão dinâmica)

```mermaid
sequenceDiagram
    autonumber
    actor C as Cliente
    participant API as API CliniFlow<br/>(via Nginx)
    participant DB as PostgreSQL
    participant W as Worker<br/>(borda)
    participant SO as S3<br/>originais
    participant L as Lambda<br/>miniaturas
    participant SM as S3<br/>miniaturas

    C->>API: POST /medicos/1/foto {content_type, tamanho}
    API->>DB: médico existe? (interface do módulo Agenda)
    API->>DB: INSERT foto (status PROCESSANDO)
    API->>API: gera URL pré-assinada PUT (5 min)
    API-->>C: 201 {foto_id, upload: {url do Worker, X-Upload-Url}}

    C->>W: PUT /upload (bytes + X-Upload-Url)
    W->>W: valida destino, Content-Type, tamanho, magic bytes
    alt arquivo inválido
        W-->>C: 4xx (nada chega ao S3)
    else arquivo válido
        W->>SO: PUT (URL pré-assinada)
        SO-->>W: 200
        W-->>C: 202 {status: ENVIADO}
    end

    SO-)L: evento s3:ObjectCreated (assíncrono)
    L->>SM: miniatura já existe? (evento repetido → encerra)
    L->>SO: GET original
    alt imagem válida
        L->>SM: PUT medicos/1/{foto_id}.webp (200×200)
    else imagem inválida (falha permanente)
        L->>SM: PUT erros/medicos/1/{foto_id}.json
    end

    C->>API: GET /fotos/{foto_id}
    API->>DB: SELECT foto
    opt status = PROCESSANDO
        API->>SM: HEAD miniatura / GET arquivo de erro
        API->>DB: UPDATE status WHERE status = 'PROCESSANDO'
    end
    API-->>C: 200 {status, miniatura_url}
```

---

## 4. Decisões arquiteturais

| # | Decisão | Alternativas consideradas | Por que esta |
|---|---------|---------------------------|--------------|
| 1 | Novo módulo **`fotos`** com schema próprio, sem chave estrangeira para `agenda` | Colunas novas em `agenda.medicos` | Mantém a regra do CliniFlow: cada módulo é dono dos seus dados e conversa pela interface pública. Também permite guardar o histórico de envios. |
| 2 | **A API não recebe a imagem**: devolve uma URL pré-assinada, e o arquivo passa pelo **Worker** antes de ir ao S3 | (a) Upload pela API Express; (b) cliente direto no Worker sem passar pela API | (a) carregaria os bytes no servidor e deixaria a borda sem função. Em (b), o Worker não alcança a API local para registrar a foto. Na opção escolhida, a borda tem uma responsabilidade clara: validar e barrar arquivos ruins antes do armazenamento. |
| 3 | O Worker **não tem credenciais AWS** | Worker assina as requisições ao S3 com chave própria | Menor privilégio: a URL pré-assinada vale para uma única chave, por 5 minutos. Como a URL também poderia ser usada direto no S3, a Lambda repete a validação (defesa em profundidade). |
| 4 | **Dois buckets** (originais e miniaturas) | Um bucket com prefixos e filtro no gatilho | Gravar a miniatura nunca dispara a função de novo. Um erro de filtro de prefixo causaria um loop de invocações, e na nuvem real isso gera custo. |
| 5 | **Chave da miniatura sempre igual** para a mesma foto (`medicos/{medico}/{foto}.webp`) | Nome aleatório por execução | Torna o processamento idempotente: um evento repetido (o S3 entrega *at least once*) reescreve o mesmo objeto, e a Lambda ainda pula o trabalho se a miniatura já existe. |
| 6 | Status atualizado por **reconciliação sob demanda** na API | Lambda chama a API de volta; Lambda → SQS → CliniFlow | A API local não é acessível da nuvem, e um túnel (ngrok) é frágil para a demonstração. A troca: o status só muda quando alguém consulta. SQS fica como evolução para produção. |
| 7 | Estados **`PROCESSANDO → CONCLUIDO \| ERRO`**, finais, com tempo limite de 5 min | Estado extra `AGUARDANDO_UPLOAD` | Segue os três estados pedidos. O tempo limite cobre upload abandonado, upload recusado na borda e falha da Lambda sem arquivo de erro. |
| 8 | Falha **permanente** grava erro e encerra; falha **transitória** lança exceção e usa as retentativas da Lambda | Retentar sempre | Retentar um arquivo corrompido só gasta invocações. Retentar uma falha de rede costuma resolver. |
| 9 | Ambiente da PoC: **LocalStack + `wrangler dev`** | AWS e Cloudflare reais; MinIO; tudo na Cloudflare (R2 + Queues) | Sem créditos AWS. O LocalStack reproduz o gatilho S3 → Lambda real, e o mesmo código vai para a AWS. O MinIO foi descontinuado (2025). Gerar a miniatura dentro de um Worker esbarra no limite de 10 ms de CPU do plano gratuito. |

---

## 5. Limitações conhecidas da PoC

- **Latência de borda não é medida de verdade:** com `wrangler dev`, o Worker roda na própria
  máquina. O ganho de latência da borda só aparece com o Worker publicado na Cloudflare. As
  medições não devem presumir esse ganho.
- **Cold start emulado:** o LocalStack roda a Lambda em containers locais. Os tempos de
  inicialização não representam os da AWS.
- **Status só atualiza na consulta** (decisão 6).
- **Dependência de conta no LocalStack:** quem for executar a PoC precisa de uma conta gratuita
  (plano Hobby) e do próprio `LOCALSTACK_AUTH_TOKEN`.
