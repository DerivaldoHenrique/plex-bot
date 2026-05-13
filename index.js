require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');

// ─── Config ───────────────────────────────────────────────────────────────────
const PLEX_BASE    = process.env.PLEX_BASE_URL || 'https://plex.benellog.com.br';
const PLEX_EMAIL   = process.env.PLEX_EMAIL;
const PLEX_SENHA   = process.env.PLEX_SENHA;
const TG_TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const STATE_FILE   = '/tmp/plex-bot-state.json';

// ─── State ────────────────────────────────────────────────────────────────────
let plexToken       = null;
let tokenExpiry     = 0;
let todayActivities = [];
let alertedIds      = new Set();
let pendingConfirm  = null;
let lastLoadedDate  = null;

// ─── Persist state across restarts ────────────────────────────────────────────
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      pendingConfirm,
      alertedIds: [...alertedIds],
      lastLoadedDate,
    }));
  } catch (_) {}
}

function restoreState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const s = JSON.parse(raw);
    if (s.lastLoadedDate === todayStr()) {
      if (s.pendingConfirm) pendingConfirm = s.pendingConfirm;
      if (s.alertedIds)     alertedIds     = new Set(s.alertedIds);
      lastLoadedDate = s.lastLoadedDate;
      console.log(`[BOT] Estado restaurado — pendente: ${pendingConfirm?.atividade || 'nenhum'}, alertados: ${alertedIds.size}`);
    }
  } catch (_) {}
}

// Fallback: se o estado foi perdido, encontra a atividade mais recente que deveria
// ter sido alertada (início nos últimos 15 min, ainda não executada)
function findLastDueActivity() {
  const [ch, cm] = nowHHMM().split(':').map(Number);
  return todayActivities
    .filter(act => {
      if (act.status === 'EXECUTADO' || act.status === 'DESVIO') return false;
      const t = hhmm(act.inicio_planejado);
      if (!t) return false;
      const [ah, am] = t.split(':').map(Number);
      const diff = (ch * 60 + cm) - (ah * 60 + am);
      return diff >= 0 && diff <= 15;
    })
    .sort((a, b) => hhmm(b.inicio_planejado).localeCompare(hhmm(a.inicio_planejado)))[0] || null;
}

// ─── Telegram ─────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TG_TOKEN, { polling: true });

// ─── PLEX API ─────────────────────────────────────────────────────────────────
async function plexLogin() {
  const res = await axios.post(`${PLEX_BASE}/auth/login`, {
    email: PLEX_EMAIL,
    senha: PLEX_SENHA,
  });
  if (!res.data?.data?.token) throw new Error('Login falhou: ' + JSON.stringify(res.data));
  plexToken  = res.data.data.token;
  tokenExpiry = Date.now() + 11 * 60 * 60 * 1000; // 11h (token dura 12h)
  console.log('[PLEX] Login OK');
}

async function getToken() {
  if (!plexToken || Date.now() > tokenExpiry) await plexLogin();
  return plexToken;
}

async function fetchTodayActivities(dateStr) {
  const token = await getToken();
  const res = await axios.get(`${PLEX_BASE}/api/plex`, {
    params: { data: dateStr },
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.data?.data?.data || [];
}

async function saveDay(dateStr, rows) {
  const token = await getToken();
  const res = await axios.post(
    `${PLEX_BASE}/api/plex`,
    { data: dateStr, rows },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return res.data;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const TZ = 'America/Sao_Paulo';

function _intlParts(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date);
}

function todayStr() {
  // Returns 'YYYY-MM-DD' in Brasília time
  const p = _intlParts(new Date());
  const get = (t) => p.find(x => x.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function nowHHMM() {
  // Returns 'HH:MM' in Brasília time
  const p = _intlParts(new Date());
  const get = (t) => p.find(x => x.type === t).value;
  return `${get('hour')}:${get('minute')}`;
}

function nowDateTimeStr() {
  // Returns 'YYYY-MM-DD HH:MM:SS' in Brasília time
  const p = _intlParts(new Date());
  const get = (t) => p.find(x => x.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function hhmm(dateTimeStr) {
  // "2026-05-12 05:50:00" → "05:50"
  return dateTimeStr?.slice(11, 16) || '';
}

function buildDateTimeStr(dateStr, timeStr) {
  // dateStr="2026-05-12", timeStr="05:52" → "2026-05-12 05:52:00"
  return `${dateStr} ${timeStr}:00`;
}

function parseTimeInput(text) {
  // Accepts: "ok", "05:52", "05:52 06:18", "feito 05:52 06:18", "desvio 05:52 06:18"
  const clean = text.trim().toLowerCase();
  let status = 'EXECUTADO';
  if (clean.startsWith('desvio')) status = 'DESVIO';

  const times = clean.match(/\d{1,2}:\d{2}/g);
  return { status, times };
}

function activityEmoji(ativ) {
  const a = ativ.toLowerCase();
  if (a.includes('dds'))          return '👥';
  if (a.includes('email'))        return '📧';
  if (a.includes('telegram') || a.includes('whatsapp')) return '💬';
  if (a.includes('reunião'))      return '📋';
  if (a.includes('intervalo'))    return '🍽️';
  if (a.includes('aprovação') || a.includes('ponto')) return '✅';
  if (a.includes('manutenção'))   return '🔧';
  if (a.includes('escala'))       return '📅';
  if (a.includes('plex'))         return '📊';
  if (a.includes('audicomp'))     return '🔍';
  if (a.includes('frota') || a.includes('equipamento')) return '🚛';
  return '🔔';
}

// ─── Load today's plan ────────────────────────────────────────────────────────
async function loadTodayPlan({ force = false } = {}) {
  const date = todayStr();

  // Reset alerted IDs on new day
  if (lastLoadedDate !== date) {
    alertedIds    = new Set();
    pendingConfirm = null;
  }

  try {
    const activities = await fetchTodayActivities(date);
    todayActivities = activities;
    lastLoadedDate  = date;
    console.log(`[PLEX] Plano atualizado: ${date} — ${activities.length} atividades`);
  } catch (err) {
    console.error('[PLEX] Erro ao carregar plano:', err.message);
  }
}

// ─── Send alert ───────────────────────────────────────────────────────────────
async function sendAlert(activity) {
  const emoji  = activityEmoji(activity.atividade);
  const inicio = hhmm(activity.inicio_planejado);
  const fim    = hhmm(activity.fim_planejado);
  const durMin = calcDuracao(activity.inicio_planejado, activity.fim_planejado);

  const msg =
    `${emoji} *${inicio} — ${activity.atividade}*\n` +
    `⏱ Previsão: ${inicio}–${fim} (${durMin} min)\n\n` +
    `Responda:\n` +
    `• \`ok\` — confirma com horários planejados\n` +
    `• \`HH:MM HH:MM\` — início e fim real\n` +
    `• \`HH:MM\` — apenas início (fim = agora)\n` +
    `• \`desvio HH:MM HH:MM\` — marca como desvio`;

  await bot.sendMessage(TG_CHAT_ID, msg, { parse_mode: 'Markdown' });
  pendingConfirm = activity;
  alertedIds.add(activity.id);
  saveState();
  console.log(`[BOT] Alerta enviado: ${activity.atividade} (${inicio})`);
}

function calcDuracao(inicio, fim) {
  if (!inicio || !fim) return '?';
  const [h1, m1] = inicio.slice(11, 16).split(':').map(Number);
  const [h2, m2] = fim.slice(11, 16).split(':').map(Number);
  return (h2 * 60 + m2) - (h1 * 60 + m1);
}

// ─── Cron: every minute — fetch fresh data then check alerts ─────────────────
cron.schedule('* * * * *', async () => {
  try {
    await loadTodayPlan(); // sempre busca dados frescos — captura qualquer mudança no PLEX

    const currentHHMM = nowHHMM();

    for (const act of todayActivities) {
      if (alertedIds.has(act.id)) continue;
      if (act.status === 'EXECUTADO' || act.status === 'DESVIO') continue;

      const actHHMM = hhmm(act.inicio_planejado);
      if (actHHMM === currentHHMM) {
        await sendAlert(act);
        break; // um alerta por vez
      }
    }
  } catch (err) {
    console.error('[CRON] Erro:', err.message);
  }
});

// ─── Meia-noite: log de novo dia (reset feito automaticamente no loadTodayPlan)
cron.schedule('0 0 * * *', () => {
  console.log('[BOT] Novo dia em Brasília');
}, { timezone: 'America/Sao_Paulo' });

// ─── Handle Telegram replies ──────────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (String(msg.chat.id) !== String(TG_CHAT_ID)) return;

  const text = msg.text?.trim();
  if (!text) return;

  // Command: /hoje — list today's activities
  if (text === '/hoje') {
    await sendTodaySummary();
    return;
  }

  // Command: /status — show pending
  if (text === '/status') {
    if (!pendingConfirm) {
      await bot.sendMessage(TG_CHAT_ID, '✅ Nenhuma atividade aguardando confirmação.');
    } else {
      await bot.sendMessage(TG_CHAT_ID,
        `⏳ Aguardando confirmação: *${pendingConfirm.atividade}*\nPlanejado: ${hhmm(pendingConfirm.inicio_planejado)}–${hhmm(pendingConfirm.fim_planejado)}`,
        { parse_mode: 'Markdown' });
    }
    return;
  }

  // Command: /pular — skip current pending
  if (text === '/pular') {
    if (pendingConfirm) {
      await bot.sendMessage(TG_CHAT_ID, `⏭ Pulando: ${pendingConfirm.atividade}`);
      pendingConfirm = null;
    }
    return;
  }

  // Handle confirmation of pending activity
  // Se pendingConfirm for null (bot reiniciou), tenta recuperar pelo fallback
  if (!pendingConfirm) {
    await loadTodayPlan();
    pendingConfirm = findLastDueActivity();
    if (pendingConfirm) {
      console.log(`[BOT] Fallback: usando atividade "${pendingConfirm.atividade}" como pendente`);
    }
  }

  if (pendingConfirm) {
    await handleConfirmation(text, pendingConfirm);
    pendingConfirm = null;
    saveState();
    return;
  }

  await bot.sendMessage(TG_CHAT_ID,
    'Nenhuma atividade aguardando confirmação.\n\nComandos:\n/hoje — resumo do dia\n/status — atividade pendente\n/pular — pular confirmação atual');
});

// ─── Handle confirmation ──────────────────────────────────────────────────────
async function handleConfirmation(text, activity) {
  const date = todayStr();
  const { status, times } = parseTimeInput(text);

  let inicioExe, fimExe;
  const agoraHHMM = nowHHMM();

  if (!times || times.length === 0) {
    // "ok" — use planned times
    inicioExe = activity.inicio_planejado;
    fimExe    = activity.fim_planejado;
  } else if (times.length === 1) {
    // "HH:MM" — custom start, fim = now
    inicioExe = buildDateTimeStr(date, times[0]);
    fimExe    = buildDateTimeStr(date, agoraHHMM);
  } else {
    // "HH:MM HH:MM" — custom start and end
    inicioExe = buildDateTimeStr(date, times[0]);
    fimExe    = buildDateTimeStr(date, times[1]);
  }

  // Reload fresh data from API
  let rows;
  try {
    const fresh = await fetchTodayActivities(date);
    todayActivities = fresh;
    lastLoadedDate  = date;

    rows = fresh.map(act => ({
      id:                String(act.id),
      alocacao:          act.alocacao_nome,
      prioridade:        act.prioridade_nome,
      atividade:         act.atividade,
      situacao_planejada: act.situacao_planejada,
      origem:            act.origem,
      inicio_planejado:  act.inicio_planejado,
      fim_planejado:     act.fim_planejado,
      total_planejado:   act.total_planejado,
      inicio_executado:  act.id === activity.id ? inicioExe : (act.inicio_executado || null),
      fim_executado:     act.id === activity.id ? fimExe    : (act.fim_executado || null),
      total_executado:   act.total_executado || null,
      status:            act.id === activity.id ? status    : (act.status || 'NÃO EXEC'),
      sub_atividade:     act.sub_atividade || '',
    }));
  } catch (err) {
    await bot.sendMessage(TG_CHAT_ID, `❌ Erro ao buscar dados: ${err.message}`);
    return;
  }

  // Save
  try {
    const result = await saveDay(date, rows);
    if (result.success !== false) {
      const dur = calcDuracao(inicioExe, fimExe);
      const emoji = status === 'EXECUTADO' ? '✅' : '⚠️';
      await bot.sendMessage(TG_CHAT_ID,
        `${emoji} *${activity.atividade}*\n` +
        `Registrado: ${inicioExe.slice(11,16)}–${fimExe.slice(11,16)} (${dur} min)\n` +
        `Status: ${status}`,
        { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(TG_CHAT_ID, `⚠️ Aviso do servidor: ${result.message}`);
    }
  } catch (err) {
    await bot.sendMessage(TG_CHAT_ID, `❌ Erro ao salvar: ${err.message}`);
  }
}

// ─── Today summary ────────────────────────────────────────────────────────────
async function sendTodaySummary() {
  await loadTodayPlan();
  if (todayActivities.length === 0) {
    await bot.sendMessage(TG_CHAT_ID, '📭 Nenhuma atividade planejada para hoje.');
    return;
  }

  const lines = todayActivities.map(act => {
    const inicio = hhmm(act.inicio_planejado);
    const fim    = hhmm(act.fim_planejado);
    let icon = '⬜';
    if (act.status === 'EXECUTADO')  icon = '✅';
    if (act.status === 'DESVIO')     icon = '⚠️';
    if (act.status === 'NÃO EXEC')   icon = '❌';
    return `${icon} ${inicio}–${fim} ${act.atividade}`;
  });

  const total    = todayActivities.length;
  const feito    = todayActivities.filter(a => a.status === 'EXECUTADO' || a.status === 'DESVIO').length;
  const header   = `📅 *Plano de hoje — ${todayStr()}*\n${feito}/${total} concluídas\n\n`;

  await bot.sendMessage(TG_CHAT_ID, header + lines.join('\n'), { parse_mode: 'Markdown' });
}

// ─── Startup ──────────────────────────────────────────────────────────────────
(async () => {
  console.log('[BOT] Iniciando PLEX Bot...');
  try {
    await plexLogin();
    await loadTodayPlan();
    restoreState(); // restaura pendingConfirm e alertedIds após restart
    await bot.sendMessage(TG_CHAT_ID,
      `🤖 *PLEX Bot iniciado!*\n` +
      `📅 Plano carregado: ${todayActivities.length} atividades\n\n` +
      `Comandos:\n/hoje — resumo do dia\n/status — atividade pendente\n/pular — pular confirmação`,
      { parse_mode: 'Markdown' });
    console.log(`[BOT] Pronto. ${todayActivities.length} atividades carregadas.`);
  } catch (err) {
    console.error('[BOT] Erro na inicialização:', err.message);
    process.exit(1);
  }
})();
