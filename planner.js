// Gera o plano diário da PLEX a partir das rotinas da GRD.
// Regras: roda seg–sex às 05:00 (America/Sao_Paulo); não sobrescreve dia já planejado;
// rotinas QP (quando preciso) ficam de fora — registre-as pelo bot ("nova ... HH:MM HH:MM").
const cron = require('node-cron');

// Catálogo na ordem do dia: duração em minutos e âncora opcional ("não começa antes de").
// Horários derivados do histórico de planos salvos (maio/2026).
const CATALOGO = [
  { a: 'Realização de dds com equipe', dur: 25, anchor: '05:50' },
  { a: 'Le e responder email', dur: 60, anchor: '07:00' },
  { a: 'Le e responder telegram/ whatsapp', dur: 20 },
  { a: 'Reunião do Livro', dur: 120 },
  { a: 'Reunião com Gerente de operações', dur: 60 },
  { a: 'Planejamento das manutenções preventivas', dur: 30 },
  { a: 'Aprovação de ponto + Tratativa de Faltas/Extras', dur: 60 },
  { a: 'Verificar e acompanhar postagem de troca de turno no grupo', dur: 20 },
  { a: 'Verificar e validar escala', dur: 20 },
  { a: 'Acompanhar a realização das trocas de turnos', dur: 20 },
  { a: 'Verificar documentos de frota (Licenças vencidas, Inspeções, CIV, CIPP, Etc.)', dur: 30 },
  { a: 'Verificar equipamento em CC', dur: 30 },
  { a: 'Realização e acompanhamento da programação de equipamentos', dur: 30 },
  { a: 'Analisar e tratar no BI de diesel/pneu/manutenção', dur: 30 },
  { a: 'Indisponibilidade Operacional e Manutenção', dur: 30 },
  { a: 'Demandas manutenção (SC, orçamento...)', dur: 30 },
  { a: 'Intervalo', dur: 60, anchor: '12:00' },
  { a: 'Analisar orçamento da unidade', dur: 30 },
  { a: 'Realizar AUDICOMP', dur: 30 },
  { a: 'Contagem de cabeça', dur: 30 },
  { a: 'Elaboração de escala', dur: 60 },
  { a: 'Planejamento de  férias', dur: 30 },
  { a: 'Realizar VCP', dur: 30 },
  { a: 'Planejamento compra programada', dur: 30 },
  { a: 'Reunião do Comitê', dur: 60, anchor: '14:30' },
  { a: 'Alimentar relatorios de gestão operacional', dur: 30 },
  { a: 'Tratativas de desvios com a equipe', dur: 30 },
  { a: 'Verificar disponibilidade dos equipamentos - turno noturno', dur: 30 },
  { a: 'Elaboração e postagem da PLEX', dur: 20 },
  { a: 'Atualização da relação de equipamentos e postagem no grupo de supervisão', dur: 15 },
  { a: 'BDEs da unidade estão 100%  organizados no D+1', dur: 15 },
  { a: 'Seguir as normas de envio de formulario  de combustiveis ao fim do dia', dur: 5 },
  { a: 'Seguir as normas de envio de formulário de  calibragem de pneus  ao fim do dia', dur: 5 },
  { a: 'Seguir as normas de envio de formulario de  coleta de sulco de pneus ao fim do dia', dur: 5 },
  { a: 'Seguir as normas de envio de formulario de movimentação de Pneus ao fim do dia', dur: 5 },
  { a: 'Seguir as normas de envio de formularios e programação, execução de manutenção  e pneus.', dur: 5 },
];

const norm = (s) => (s || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
const CATALOGO_IDX = new Map(CATALOGO.map((c, i) => [norm(c.a), i]));

let deps = null; // { axios, PLEX_BASE, getToken, bot, TG_CHAT_ID, todayStr, saveDay, fetchTodayActivities }

async function fetchRotinas() {
  const token = await deps.getToken();
  const res = await deps.axios.get(`${deps.PLEX_BASE}/api/plex/rotinas`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.data?.data?.rotinas || [];
}

// dia_semana na GRD: 1=domingo … 7=sábado
function rotinaAplicaNoDia(rot, dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay(); // 0=domingo
  switch (rot.periodicidade) {
    case 'DIARIO':     return true;
    case 'SEMANAL':    return Number(rot.dia_semana) === dow + 1;
    case 'MENSAL':
    case 'QUINZENAL':  return Number(rot.dia_mes) === d;
    case 'QP':         return false; // quando preciso — entra manualmente
    default:           return false;
  }
}

function hhmmToMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function minToHHMM(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
function durFmt(min) { return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}:00`; }

function montarRows(rotinas, dateStr) {
  const aplicaveis = rotinas.filter((r) => rotinaAplicaNoDia(r, dateStr));
  // ordena pelo catálogo; desconhecidas vão para o fim na ordem da GRD
  aplicaveis.sort((r1, r2) => {
    const i1 = CATALOGO_IDX.get(norm(r1.atividade)) ?? 999;
    const i2 = CATALOGO_IDX.get(norm(r2.atividade)) ?? 999;
    return i1 - i2;
  });

  let cur = hhmmToMin('05:50');
  return aplicaveis.map((rot) => {
    const cat = CATALOGO[CATALOGO_IDX.get(norm(rot.atividade))] || { dur: 30 };
    if (cat.anchor) cur = Math.max(cur, hhmmToMin(cat.anchor));
    const ini = cur;
    const fim = cur + cat.dur;
    cur = fim;
    return {
      id: '',
      alocacao: rot.alocacao_nome || 'Rotina',
      prioridade: rot.prioridade_nome || 'Útil',
      atividade: rot.atividade,
      situacao_planejada: 'PLANEJADO',
      origem: 'CERTO',
      inicio_planejado: `${dateStr} ${minToHHMM(ini)}:00`,
      fim_planejado: `${dateStr} ${minToHHMM(fim)}:00`,
      total_planejado: durFmt(cat.dur),
      inicio_executado: null,
      fim_executado: null,
      total_executado: null,
      status: 'NÃO EXEC',
      sub_atividade: '',
    };
  });
}

async function gerarPlanoDoDia({ manual = false } = {}) {
  const date = deps.todayStr();
  const dow = (() => { const [y, m, d] = date.split('-').map(Number); return new Date(y, m - 1, d).getDay(); })();

  if (!manual && (dow === 0 || dow === 6)) return; // fim de semana só via /gerar

  try {
    const existentes = await deps.fetchTodayActivities(date);
    if (existentes.length > 0) {
      if (manual) {
        await deps.bot.sendMessage(deps.TG_CHAT_ID,
          `ℹ️ O dia ${date} já tem ${existentes.length} atividades planejadas — nada a gerar.`);
      }
      console.log(`[PLANNER] ${date} já planejado (${existentes.length} atividades)`);
      return;
    }

    const rotinas = await fetchRotinas();
    const rows = montarRows(rotinas, date);
    if (rows.length === 0) {
      if (manual) await deps.bot.sendMessage(deps.TG_CHAT_ID, `📭 Nenhuma rotina da GRD se aplica a ${date}.`);
      return;
    }

    await deps.saveDay(date, rows);
    const primeira = rows[0];
    await deps.bot.sendMessage(deps.TG_CHAT_ID,
      `📅 *Plano do dia criado!*\n` +
      `${rows.length} atividades para ${date}\n` +
      `Primeira: ${primeira.atividade} às ${primeira.inicio_planejado.slice(11, 16)}\n\n` +
      `Use /hoje para ver a lista completa.`,
      { parse_mode: 'Markdown' });
    console.log(`[PLANNER] Plano criado: ${date} — ${rows.length} atividades`);
  } catch (err) {
    console.error('[PLANNER] Erro ao gerar plano:', err.message);
    try {
      await deps.bot.sendMessage(deps.TG_CHAT_ID, `❌ Erro ao gerar o plano do dia: ${err.message}`);
    } catch (_) {}
  }
}

function initPlanner(d) {
  deps = d;
  cron.schedule('0 5 * * 1-5', () => gerarPlanoDoDia(), { timezone: 'America/Sao_Paulo' });
  // Recuperação: se reiniciou/deployou depois das 05:00 de um dia útil sem plano, gera agora
  gerarPlanoDoDia();
  console.log('[PLANNER] Agendador ativo — seg–sex 05:00 (America/Sao_Paulo)');
}

module.exports = { initPlanner, gerarPlanoDoDia };
