// ============================================================
// Arena Column Cue System — Backend
// Express + WebSocket + Moteur de cues
// ============================================================

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

// ---------- CONFIG ----------
const PORT = 3000;
const ARENA_HTTP = 'http://127.0.0.1:8080/api/v1';
const ARENA_WS = 'ws://127.0.0.1:8080/api/v1';
const TICK_MS = 1000;
const DATA_FILE = path.join(__dirname, 'data', 'cues.json');

// ---------- ÉTAT GLOBAL ----------
let state = {
  cues: [],
  settings: { globalOffset: 0, paused: false },
  running: false,
  currentCueId: null,
  currentCueStartedAt: null,
  stopwatchStartAt: null,
  arenaConnected: false
};

// ---------- PERSISTANCE ----------
function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    state.cues = data.cues || [];
    state.settings = data.settings || { globalOffset: 0, paused: false };
    console.log(`📂 ${state.cues.length} cue(s) chargée(s)`);
  } catch (e) {
    console.log('⚠️  Pas de fichier data, initialisation vide.');
  }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify({
    cues: state.cues,
    settings: state.settings
  }, null, 2));
}

// ---------- UTILS TEMPS ----------
function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function nowHHMMSS() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

function addMinutes(hhmm, minutes) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + minutes;
  const nh = Math.floor((((total % 1440) + 1440) % 1440) / 60);
  const nm = ((total % 60) + 60) % 60;
  return `${String(nh).padStart(2,'0')}:${String(nm).padStart(2,'0')}`;
}


// ════════════════════════════════════════════════════════════
// HELPERS DATES
// ════════════════════════════════════════════════════════════
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function todayDayOfWeek() {
  return new Date().getDay(); // 0 = dimanche, 1 = lundi, ..., 6 = samedi
}

/**
 * Vérifie si une cue doit s'exécuter aujourd'hui selon son dateMode :
 * - 'always' : tous les jours
 * - 'once'   : uniquement à la date spécifiée
 * - 'daily'  : tous les jours à partir de la date spécifiée
 * - 'weekly' : uniquement les jours de la semaine cochés
 */
function cueMatchesToday(cue) {
  const mode = cue.dateMode || 'always';

  if (mode === 'always') return true;

  if (mode === 'once') {
    return cue.date === todayISO();
  }

  if (mode === 'daily') {
    // Si pas de date de début, c'est toujours actif
    if (!cue.date) return true;
    return cue.date <= todayISO();
  }

  if (mode === 'weekly') {
    const days = cue.daysOfWeek || [];
    if (days.length === 0) return false;
    return days.includes(todayDayOfWeek());
  }

  return false;
}
// ---------- MOTEUR DE CUES ----------
let lastTickMinute = null;
let wss = null;

function tick() {
  if (!state.running || state.settings.paused) return;

  const currentHHMM = nowHHMM();
  if (currentHHMM === lastTickMinute) return;
  lastTickMinute = currentHHMM;

  const offset = state.settings.globalOffset;

  // Cues CLOCK dont l'heure réelle = maintenant
  const due = state.cues
    .filter(c => c.enabled && c.type === 'CLOCK' && c.start && cueMatchesToday(c))
    .map(c => ({ ...c, realStart: addMinutes(c.start, offset + (c.offset || 0)) }))
    .filter(c => c.realStart === currentHHMM);

  if (due.length === 0) return;

  // Règle : la dernière écrase les autres
  const cue = due[due.length - 1];
  console.log(`▶️  Déclenchement "${cue.name}" (${cue.realStart})`);
  triggerCue(cue);
}

async function triggerCue(cue) {
  state.currentCueId = cue.id;
  state.currentCueStartedAt = Date.now();

  broadcast({ type: 'cue-triggered', cue });

  const columnIndex = cue.column || 1;

  try {
    await axios.post(`${ARENA_HTTP}/composition/columns/${columnIndex}/connect`);
    console.log(`   ✅ Arena : column ${columnIndex} triggered`);
  } catch (e) {
    console.error(`   ❌ Erreur Arena column ${columnIndex}:`, e.message);
  }
}

// ---------- ARENA ----------
// arenaStop() supprimé — Resolume gère l'arrêt automatique des columns

async function arenaCheck() {
  try {
    await axios.get(`${ARENA_HTTP}/composition`, { timeout: 2000 });
    if (!state.arenaConnected) console.log('🟢 Arena connecté');
    state.arenaConnected = true;
  } catch {
    if (state.arenaConnected) console.log('🔴 Arena déconnecté');
    state.arenaConnected = false;
  }
  broadcast({ type: 'arena-status', connected: state.arenaConnected });
}

// ---------- WEBSOCKET BROADCAST ----------
function broadcast(msg) {
  if (!wss) return;
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(data);
  });
}

// ---------- EXPRESS ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- API cues ---
app.get('/api/cues', (req, res) => res.json(state.cues));

app.post('/api/cues', (req, res) => {
  const cue = { id: uuidv4(), enabled: true, ...req.body };
  state.cues.push(cue);
  saveData();
  broadcast({ type: 'cues-updated', cues: state.cues });
  console.log(`➕ Cue créée : ${cue.name}`);
  res.json(cue);
});

app.put('/api/cues/:id', (req, res) => {
  const idx = state.cues.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Cue introuvable' });
  state.cues[idx] = { ...state.cues[idx], ...req.body };
  saveData();
  broadcast({ type: 'cues-updated', cues: state.cues });
  console.log(`✏️  Cue modifiée : ${state.cues[idx].name}`);
  res.json(state.cues[idx]);
});

app.delete('/api/cues/:id', (req, res) => {
  const cue = state.cues.find(c => c.id === req.params.id);
  state.cues = state.cues.filter(c => c.id !== req.params.id);
  saveData();
  broadcast({ type: 'cues-updated', cues: state.cues });
  console.log(`🗑️  Cue supprimée : ${cue?.name || req.params.id}`);
  res.json({ ok: true });
});

// --- API state ---
app.get('/api/state', (req, res) => {
  res.json({
    cues: state.cues,
    settings: state.settings,
    running: state.running,
    currentCueId: state.currentCueId,
    time: nowHHMMSS(),
    arenaConnected: state.arenaConnected
  });
});

// --- Global Offset ---
app.post('/api/offset', (req, res) => {
  state.settings.globalOffset = Number(req.body.offset) || 0;
  saveData();
  broadcast({ type: 'settings-updated', settings: state.settings });
  console.log(`🌍 Global Offset : ${state.settings.globalOffset} min`);
  res.json(state.settings);
});

// --- Contrôles ---
app.post('/api/start', (req, res) => {
  state.running = true;
  lastTickMinute = null;
  broadcast({ type: 'state', running: true });
  console.log('▶️  Scheduler START');
  res.json({ running: true });
});

app.post('/api/stop', (req, res) => {
  state.running = false;
  state.currentCueId = null;
  broadcast({ type: 'state', running: false });
  console.log('⏹️  Scheduler STOP (temps continue)');
  res.json({ running: false });
});

app.post('/api/kill', (req, res) => {
  state.running = false;
  state.currentCueId = null;
  state.currentCueStartedAt = null;
  state.stopwatchStartAt = null;
  state.settings.paused = false;
  saveData();
  broadcast({ type: 'state', running: false, killed: true });
  broadcast({ type: 'settings-updated', settings: state.settings });
  console.log('🛑 TOUT ARRÊTÉ — reset complet');
  res.json({ killed: true });
});

app.post('/api/pause', (req, res) => {
  state.settings.paused = !state.settings.paused;
  saveData();
  broadcast({ type: 'settings-updated', settings: state.settings });
  console.log(state.settings.paused ? '⏸️  PAUSE' : '⏯️  RESUME');
  res.json(state.settings);
});

app.post('/api/trigger/:id', (req, res) => {
  const cue = state.cues.find(c => c.id === req.params.id);
  if (!cue) return res.status(404).json({ error: 'Cue introuvable' });
  console.log(`🎯 Trigger manuel : ${cue.name}`);
  triggerCue(cue);
  res.json({ ok: true });
});

// --- API columns Resolume ---
app.get('/api/arena/columns', async (req, res) => {
  try {
    const response = await axios.get(`${ARENA_HTTP}/composition`);
    const columns = response.data?.columns || [];
    const simplified = columns.map((col, idx) => {
      // Extrait le nom correctement (ParamString -> value)
      let name = `Column ${idx + 1}`;
      if (typeof col.name === 'string') {
        name = col.name;
      } else if (col.name && typeof col.name === 'object' && col.name.value) {
        name = col.name.value;
      }
      return {
        index: idx + 1,
        id: col.id,
        name: name
      };
    });
    res.json(simplified);
  } catch (e) {
    console.error('❌ Impossible de récupérer les columns:', e.message);
    res.status(500).json({ error: 'Arena non disponible' });
  }
});

// ---------- SERVEUR HTTP + WEBSOCKET ----------
const server = http.createServer(app);
wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  console.log('🔌 Client WebSocket connecté');
  ws.send(JSON.stringify({
    type: 'init',
    cues: state.cues,
    settings: state.settings,
    running: state.running,
    arenaConnected: state.arenaConnected
  }));
  ws.on('close', () => console.log('🔌 Client WebSocket déconnecté'));
});

// ---------- DÉMARRAGE ----------
loadData();
setInterval(tick, TICK_MS);
setInterval(arenaCheck, 5000);
arenaCheck();

server.listen(PORT, () => {
  console.log('');
  console.log('════════════════════════════════════════════════');
  console.log('  🎬 Arena Column Cue System — Backend');
  console.log('════════════════════════════════════════════════');
  console.log(`  🌐 Frontend  : http://localhost:${PORT}`);
  console.log(`  🎛️  Arena API : ${ARENA_HTTP}`);
  console.log(`  ⏱️  Tick      : ${TICK_MS} ms`);
  console.log('════════════════════════════════════════════════');
  console.log('');
});




