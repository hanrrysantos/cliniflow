// CliniFlow: frontend sem build, servido pelo gateway em /app/ (mesma origem da API, sem CORS).

const $ = (seletor) => document.querySelector(seletor);

function el(tag, props, ...filhos) {
  const no = Object.assign(document.createElement(tag), props);
  no.append(...filhos.filter((f) => f != null && f !== false));
  return no;
}

const fmtDia = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtHora = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const quando = (iso) => `${fmtDia.format(new Date(iso))} às ${fmtHora.format(new Date(iso))}`;

// A API não lista pacientes, médicos nem consultas, então o navegador lembra os que passaram por ele.
// shortcut: só aparece o que foi cadastrado ou buscado neste navegador, trocar por GETs de listagem quando a API tiver.
const memoria = {
  ler(chave) {
    try {
      return JSON.parse(localStorage.getItem(`cliniflow.${chave}`)) || [];
    } catch {
      return [];
    }
  },
  gravar(chave, lista) {
    try {
      localStorage.setItem(`cliniflow.${chave}`, JSON.stringify(lista));
    } catch {
      // armazenamento bloqueado (navegação privada): a tela funciona, só não lembra
    }
  },
  guardar(chave, item) {
    this.gravar(chave, [...this.ler(chave).filter((i) => i.id !== item.id), item].sort((a, b) => a.id - b.id));
  },
  esquecer(chave, id) {
    this.gravar(chave, this.ler(chave).filter((i) => i.id !== id));
  },
};

async function api(metodo, caminho, corpo, headers = {}) {
  let res;
  try {
    res = await fetch(caminho, {
      method: metodo,
      headers: corpo ? { 'Content-Type': 'application/json', ...headers } : headers,
      body: corpo && JSON.stringify(corpo),
    });
  } catch {
    throw Object.assign(new Error('Sem conexão com a API. Confira se o CliniFlow está no ar.'), { status: 0 });
  }
  const dados = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(dados?.erro || `A API respondeu ${res.status}`), { status: res.status });
  return dados;
}

function avisar(texto, erro = false) {
  const aviso = $('#aviso');
  aviso.textContent = texto;
  aviso.className = erro ? 'erro' : '';
  aviso.hidden = false;
  clearTimeout(avisar.relogio);
  avisar.relogio = setTimeout(() => (aviso.hidden = true), 7000);
}

// Roda uma ação da interface. O botão fica ocupado (aria-busy) em vez de desabilitado,
// para não perder o foco do teclado; um segundo clique durante a chamada é ignorado.
async function tentar(botao, acao, aoFalhar = (err) => avisar(err.message, true)) {
  if (botao.hasAttribute('aria-busy')) return;
  botao.setAttribute('aria-busy', 'true');
  try {
    await acao();
  } catch (err) {
    aoFalhar(err);
  } finally {
    botao.removeAttribute('aria-busy');
  }
}

// Formulário: o erro aparece dentro dele, junto dos campos, e o foco volta para o primeiro campo.
function aoEnviar(form, acao) {
  const erro = form.appendChild(el('p', { className: 'erro-form', hidden: true }));
  erro.setAttribute('role', 'alert');
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    erro.hidden = true;
    tentar(
      form.querySelector('button'),
      async () => {
        await acao(Object.fromEntries(new FormData(form)));
        form.reset();
      },
      (err) => {
        erro.textContent = err.message;
        erro.hidden = false;
        form.querySelector('input').focus();
      },
    );
  });
}

const vazio = (texto) => el('li', { className: 'vazio', textContent: texto });

async function verSaude() {
  const saude = $('#saude');
  try {
    const { broker } = await api('GET', '/health');
    saude.textContent = broker === 'ok' ? 'Sistema no ar' : 'No ar, com a fila de e-mails indisponível';
    saude.className = broker === 'ok' ? 'ok' : 'alerta';
  } catch (err) {
    saude.textContent = err.status === 503 ? 'Banco de dados indisponível' : 'API fora do ar';
    saude.className = 'erro';
  }
}

// ---------- Horários e agendamento ----------

let horarios = [];

async function carregarHorarios() {
  horarios = await api('GET', '/horarios');
  // todo médico com horário é conhecido, mesmo que tenha sido cadastrado em outro navegador
  for (const h of horarios) memoria.guardar('medicos', { id: h.medico_id, nome: h.medico, especialidade: h.especialidade });
}

async function agendar(horario) {
  const paciente_id = Number($('#paciente').value);
  if (!paciente_id) throw new Error('Escolha o paciente antes de agendar.');
  // Uma Idempotency-Key por pedido. Se a resposta se perder (rede ou 5xx), o reenvio usa a mesma
  // chave e a API devolve a consulta já criada, em vez de responder 409 ou duplicar.
  // randomUUID só existe em contexto seguro (localhost ou HTTPS).
  const chave = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  try {
    let consulta;
    for (let tentativa = 1; !consulta; tentativa++) {
      try {
        consulta = await api('POST', '/consultas', { paciente_id, horario_id: horario.id }, { 'Idempotency-Key': chave });
      } catch (err) {
        if (tentativa === 3 || (err.status >= 400 && err.status < 500)) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    memoria.guardar('consultas', consulta);
    avisar(`Consulta nº ${consulta.id} agendada para ${quando(horario.data_hora)}. O e-mail de confirmação sai em seguida.`);
  } finally {
    mostrarAgenda().catch(() => {});
  }
}

function cartaoHorario(h) {
  const livre = h.status === 'LIVRE';
  const botao = livre && el('button', { textContent: 'Agendar', onclick: () => tentar(botao, () => agendar(h)) });
  return el(
    'li',
    { className: livre ? 'horario' : 'horario reservado' },
    el('time', { dateTime: h.data_hora, textContent: fmtHora.format(new Date(h.data_hora)) }),
    el('div', {}, el('strong', { textContent: h.medico }), el('span', { textContent: h.especialidade })),
    botao || el('span', { className: 'selo reservado', textContent: 'Reservado' }),
  );
}

async function mostrarAgenda() {
  const seletor = $('#paciente');
  const escolhido = seletor.value;
  const pacientes = memoria.ler('pacientes');
  seletor.replaceChildren(
    el('option', { value: '', textContent: pacientes.length ? 'Escolha o paciente' : 'Nenhum paciente neste navegador' }),
    ...pacientes.map((p) => el('option', { value: p.id, textContent: `${p.nome} (nº ${p.id})` })),
  );
  if (pacientes.some((p) => String(p.id) === escolhido)) seletor.value = escolhido;
  $('#sem-paciente').hidden = pacientes.length > 0;

  await carregarHorarios();
  const filtro = $('#filtro').value;
  const visiveis = horarios.filter((h) => filtro === 'TODOS' || h.status === filtro);
  if (!visiveis.length) {
    const link = el('a', { href: '#medicos', textContent: 'Crie horários na seção Médicos' });
    return $('#agenda').replaceChildren(el('p', { className: 'vazio' }, 'Nenhum horário para mostrar. ', link, '.'));
  }
  const dias = new Map(); // a API já devolve em ordem de data
  for (const h of visiveis) {
    const dia = fmtDia.format(new Date(h.data_hora));
    dias.set(dia, [...(dias.get(dia) || []), h]);
  }
  $('#agenda').replaceChildren(
    ...[...dias].map(([dia, lista]) => {
      const p = Object.fromEntries(fmtDia.formatToParts(new Date(lista[0].data_hora)).map((x) => [x.type, x.value]));
      const data = el(
        'h2',
        { className: 'data' },
        el('b', { textContent: p.day }),
        el('span', { textContent: p.weekday }),
        el('span', { textContent: `${p.month} de ${p.year}` }),
      );
      data.setAttribute('aria-label', dia);
      return el('section', { className: 'dia-grupo' }, data, el('ul', { className: 'dia' }, ...lista.map(cartaoHorario)));
    }),
  );
}

// ---------- Consultas ----------

async function mostrarConsultas() {
  await carregarHorarios();
  // shortcut: uma requisição por consulta lembrada; com dezenas delas o limite do gateway (20 req/s)
  // pode responder 503, trocar por um GET /consultas de listagem quando a API tiver.
  const consultas = await Promise.all(
    memoria.ler('consultas').map(async (c) => {
      try {
        const atual = await api('GET', `/consultas/${c.id}`);
        memoria.guardar('consultas', atual);
        return atual;
      } catch (err) {
        if (err.status !== 404) return c;
        memoria.esquecer('consultas', c.id); // o banco foi recriado
      }
    }),
  );
  const pacientes = memoria.ler('pacientes');
  const itens = consultas.filter(Boolean).reverse().map((c) => {
    const paciente = pacientes.find((p) => p.id === c.paciente_id);
    const horario = horarios.find((h) => h.id === c.horario_id);
    const confirmada = c.status === 'CONFIRMADA';
    const cancelar = confirmada && el('button', {
      className: 'perigo',
      textContent: 'Cancelar consulta',
      onclick: () => tentar(cancelar, async () => {
        if (!confirm(`Cancelar a consulta nº ${c.id}? O horário volta a ficar livre e o paciente recebe um e-mail de cancelamento.`)) return;
        memoria.guardar('consultas', await api('DELETE', `/consultas/${c.id}`));
        avisar(`Consulta nº ${c.id} cancelada. O horário voltou a ficar livre.`);
        await mostrarConsultas();
      }),
    });
    return el(
      'li',
      {},
      el(
        'div',
        { className: 'dados' },
        el('strong', { textContent: `Consulta nº ${c.id}` }),
        el('span', { textContent: paciente ? paciente.nome : `Paciente nº ${c.paciente_id}` }),
        el('span', { textContent: horario ? `${quando(horario.data_hora)}, com ${horario.medico}` : `Horário nº ${c.horario_id}` }),
      ),
      el('span', { className: confirmada ? 'selo' : 'selo cancelada', textContent: confirmada ? 'Confirmada' : 'Cancelada' }),
      cancelar,
    );
  });
  $('#consultas').replaceChildren(
    ...(itens.length ? itens : [vazio('Nenhuma consulta neste navegador. Agende uma ou busque pelo número.')]),
  );
}

aoEnviar($('#buscar-consulta'), async ({ id }) => {
  memoria.guardar('consultas', await api('GET', `/consultas/${id}`));
  await mostrarConsultas();
});

// ---------- Pacientes ----------

function mostrarPacientes() {
  const itens = memoria.ler('pacientes').map((p) =>
    el(
      'li',
      {},
      el(
        'div',
        { className: 'dados' },
        el('strong', { textContent: p.nome }),
        el('span', { textContent: p.telefone ? `${p.email}, ${p.telefone}` : p.email }),
      ),
      el('span', { className: 'vazio', textContent: `Paciente nº ${p.id}` }),
    ),
  );
  $('#pacientes').replaceChildren(
    ...(itens.length ? itens : [vazio('Nenhum paciente neste navegador. Cadastre um ou busque pelo número.')]),
  );
}

aoEnviar($('#novo-paciente'), async (dados) => {
  const paciente = await api('POST', '/pacientes', dados);
  memoria.guardar('pacientes', paciente);
  avisar(`Paciente cadastrado: ${paciente.nome}, nº ${paciente.id}.`);
  mostrarPacientes();
});

aoEnviar($('#buscar-paciente'), async ({ id }) => {
  memoria.guardar('pacientes', await api('GET', `/pacientes/${id}`));
  mostrarPacientes();
});

// ---------- Médicos, horários e foto ----------

// Pipeline de fotos (docs/CONTRATOS.md §2): a API devolve as instruções, o arquivo vai para o
// Worker de borda e a miniatura aparece quando a API passa a responder CONCLUIDO.
async function enviarFoto(medico, arquivo, estado) {
  const foto = await api('POST', `/medicos/${medico.id}/foto`, { content_type: arquivo.type, tamanho: arquivo.size });
  estado.textContent = 'Enviando o arquivo…';
  let res;
  try {
    res = await fetch(foto.upload.url, { method: foto.upload.metodo, headers: foto.upload.headers, body: arquivo });
  } catch {
    throw new Error('O serviço de upload não respondeu. Confira se o Worker está rodando (npm run dev na pasta edge).');
  }
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.erro || `O upload respondeu ${res.status}`);
  estado.textContent = 'Arquivo enviado. Gerando a miniatura…';
  // A API marca ERRO depois do tempo limite (5 min), mas não enquanto o S3 está fora do ar
  // (CONTRATOS §3). Por isso o navegador desiste sozinho um pouco depois.
  const limite = Date.now() + 6 * 60 * 1000;
  let atual = foto;
  while (atual.status === 'PROCESSANDO') {
    if (Date.now() > limite) {
      throw new Error('A miniatura não ficou pronta em 6 minutos. Confira se o LocalStack está no ar e recarregue a página para ver se a foto foi processada.');
    }
    await new Promise((r) => setTimeout(r, 2000));
    atual = await api('GET', foto.consulta);
  }
  if (atual.status === 'ERRO') throw new Error(`A foto não foi processada: ${atual.erro}`);
  return atual;
}

function cartaoMedico(m) {
  const retrato = el('div', { className: 'retrato', textContent: m.nome.replace(/^dra?\.\s*/i, '')[0] || '?' });
  const mostrarFoto = (foto) =>
    retrato.replaceChildren(el('img', { src: foto.miniatura_url, alt: `Foto de ${m.nome}`, width: 72, height: 72, loading: 'lazy' }));
  api('GET', `/medicos/${m.id}/foto`).then(mostrarFoto, () => {}); // 404: ainda sem foto

  let livres = horarios.filter((h) => h.medico_id === m.id && h.status === 'LIVRE').length;
  const contagem = el('span');
  const contar = () => (contagem.textContent = `${m.especialidade}, ${livres} ${livres === 1 ? 'horário livre' : 'horários livres'}`);
  contar();

  const novoHorario = el(
    'form',
    { className: 'linha' },
    el('label', {}, 'Novo horário', el('input', { name: 'data_hora', type: 'datetime-local', required: true })),
    el('button', { textContent: 'Criar horário' }),
  );
  aoEnviar(novoHorario, async ({ data_hora }) => {
    const h = await api('POST', `/medicos/${m.id}/horarios`, { data_hora: new Date(data_hora).toISOString() });
    livres += 1;
    contar();
    avisar(`Horário criado: ${quando(h.data_hora)}, com ${m.nome}.`);
  });

  const estado = el('p', { className: 'estado' });
  estado.setAttribute('role', 'status');
  const novaFoto = el(
    'form',
    { className: 'linha' },
    el(
      'label',
      {},
      'Foto de perfil (JPEG, PNG ou WebP, até 5 MB)',
      el('input', { name: 'foto', type: 'file', accept: 'image/jpeg,image/png,image/webp', required: true }),
    ),
    el('button', { textContent: 'Enviar foto' }),
  );
  aoEnviar(novaFoto, async ({ foto }) => {
    try {
      mostrarFoto(await enviarFoto(m, foto, estado));
      avisar(`Foto de ${m.nome} enviada.`);
    } finally {
      estado.textContent = '';
    }
  });

  return el(
    'li',
    { className: 'medico' },
    retrato,
    el('div', { className: 'dados' }, el('strong', { textContent: m.nome }), contagem),
    novoHorario,
    novaFoto,
    estado,
  );
}

async function mostrarMedicos() {
  await carregarHorarios();
  const medicos = memoria.ler('medicos');
  $('#medicos').replaceChildren(
    ...(medicos.length ? medicos.map(cartaoMedico) : [vazio('Nenhum médico ainda. Cadastre o primeiro acima.')]),
  );
}

aoEnviar($('#novo-medico'), async (dados) => {
  const medico = await api('POST', '/medicos', dados);
  memoria.guardar('medicos', medico);
  avisar(`Médico cadastrado: ${medico.nome}.`);
  await mostrarMedicos();
});

// ---------- Navegação ----------

const telas = { agendar: mostrarAgenda, consultas: mostrarConsultas, pacientes: mostrarPacientes, medicos: mostrarMedicos };

async function abrir() {
  const [pedido, parametros] = location.hash.slice(1).split('?');
  const nome = Object.hasOwn(telas, pedido) ? pedido : 'agendar';
  // o filtro da agenda fica na URL (#agendar?mostrar=RESERVADO): sobrevive à recarga e pode ser compartilhado
  const filtro = $('#filtro');
  filtro.value = new URLSearchParams(parametros).get('mostrar') ?? 'LIVRE';
  if (filtro.selectedIndex < 0) filtro.value = 'LIVRE';
  for (const secao of document.querySelectorAll('main > section')) secao.hidden = secao.id !== `tela-${nome}`;
  for (const link of document.querySelectorAll('nav a')) {
    if (link.hash === `#${nome}`) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  try {
    await telas[nome]();
  } catch (err) {
    avisar(err.message, true);
  }
}

$('#filtro').addEventListener('change', (ev) => {
  location.hash = ev.target.value === 'LIVRE' ? 'agendar' : `agendar?mostrar=${ev.target.value}`;
});
$('.pular').addEventListener('click', (ev) => {
  ev.preventDefault(); // o hash é usado pela navegação entre seções
  $('main').focus();
});
$('#esquecer').addEventListener('click', () => {
  if (!confirm('Esquecer os pacientes, médicos e consultas lembrados neste navegador? Nada é apagado do sistema.')) return;
  for (const chave of ['pacientes', 'medicos', 'consultas']) memoria.gravar(chave, []);
  abrir();
});
addEventListener('hashchange', abrir);
abrir();
verSaude();
setInterval(verSaude, 15000);
