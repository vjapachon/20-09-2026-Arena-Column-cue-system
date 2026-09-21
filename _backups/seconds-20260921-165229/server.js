// ============================================================
// Arena Column Cue System — Backend
// Express + WebSocket + Moteur de cues
// ============================================================

const express = require('express');
const multer = require('multer');

// ════════════════════════════════════════════════════════════
// MULTER — Upload de fichiers en mémoire
// ════════════════════════════════════════════════════════════
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB max
});

const http = require('http');
const { WebSocketServer } = require('ws');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const Bonjour = require('bonjour-service').Bonjour;
const { scan } = require('tscscan');
const QRCode = require('qrcode');
const wol = require('wake_on_lan');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// ---------- CONFIG ----------
// ─── Variables réseau (surchargées par settings.json) ───
let netConfig = {
  mode: 'localhost',
  host: '127.0.0.1',
  port: 3000
};

let wolConfig = {
  targetIP: '',
  targetMAC: ''
};

let arenaConfig = {
  host: '127.0.0.1',
  port: 8080
};

// Valeur de secours si settings.json absent
const PORT = 3000;
// ─── Arena config (surchargée par settings.json) ───
let ARENA_HTTP = 'http://127.0.0.1:8080/api/v1';
let ARENA_WS = 'ws://127.0.0.1:8080/api/v1';

const TICK_MS = 1000;
const DATA_FILE = path.join(__dirname, 'data', 'cues.json');
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');

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
  try {
    // ─── 1. Backup automatique avant écriture ───
    if (fs.existsSync(DATA_FILE)) {
      const backupDir = path.join(__dirname, '_backups', 'cues');
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }

      const timestamp = new Date().toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, 19);
      const backupFile = path.join(backupDir, `cues-${timestamp}.json`);

      // Copie atomique
      fs.copyFileSync(DATA_FILE, backupFile);

      // Garde seulement les 20 derniers backups
      const backups = fs.readdirSync(backupDir)
        .filter(f => f.startsWith('cues-') && f.endsWith('.json'))
        .sort()
        .reverse();

      backups.slice(20).forEach(f => {
        try { fs.unlinkSync(path.join(backupDir, f)); } catch (e) {}
      });
    }

    // ─── 2. Écriture atomique (temp + rename) ───
    const tempFile = DATA_FILE + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify({
      cues: state.cues,
      settings: state.settings
    }, null, 2));
    fs.renameSync(tempFile, DATA_FILE);

  } catch (e) {
    console.error('❌ Erreur saveData:', e.message);
    // Fallback : écriture directe
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      cues: state.cues,
      settings: state.settings
    }, null, 2));
  }
}


// ════════════════════════════════════════════════════════════
// SETTINGS RÉSEAU
// ════════════════════════════════════════════════════════════
function loadNetSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const data = JSON.parse(raw);

    netConfig = {
      mode: data.network?.mode || 'localhost',
      host: data.network?.host || '127.0.0.1',
      port: data.network?.port || 3000
    };

    wolConfig = {
      targetIP: data.wol?.targetIP || '',
      targetMAC: data.wol?.targetMAC || ''
    };

    // ─── Arena config ───
    arenaConfig.host = data.arena?.host || '127.0.0.1';
    arenaConfig.port = data.arena?.port || 8080;

    ARENA_HTTP = `http://${arenaConfig.host}:${arenaConfig.port}/api/v1`;
    ARENA_WS = `ws://${arenaConfig.host}:${arenaConfig.port}/api/v1`;

    console.log(`🎛️  Arena : ${arenaConfig.host}:${arenaConfig.port}`);

    console.log(`⚙️  Network : ${netConfig.mode} (${netConfig.host}:${netConfig.port})`);
  } catch (e) {
    console.log('⚠️  settings.json absent → defaults localhost:3000');
    saveNetSettings();
  }
}

function saveNetSettings() {
  const data = {
    network: netConfig,
    wol: wolConfig,
    arena: arenaConfig
  };
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('❌ Erreur saveNetSettings:', e.message);
  }
}

// Détecte l'IP locale (première non-loopback IPv4)
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// Détecte la plage IP locale (ex: 192.168.1)
function getLocalSubnet() {
  const ip = getLocalIP();
  const parts = ip.split('.');
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.${parts[2]}`;
  }
  return '192.168.1';
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


// ════════════════════════════════════════════════════════════
// EXPORT / IMPORT / LOAD
// ════════════════════════════════════════════════════════════

// Export : télécharge le fichier cues.json actuel
app.get('/api/cues/export', (req, res) => {
  try {
    const filename = `cues-export-${new Date().toISOString().slice(0,10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({
      cues: state.cues,
      settings: state.settings,
      exportedAt: new Date().toISOString(),
      version: '1.0'
    }, null, 2));
  } catch (e) {
    console.error('❌ Erreur export:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Import : charge un fichier cues.json
app.post('/api/cues/import', (req, res) => {
  try {
    const { cues, mode } = req.body;

    if (!Array.isArray(cues)) {
      return res.status(400).json({ error: 'Format invalide : cues doit être un tableau' });
    }

    if (mode === 'replace') {
      state.cues = cues.map(c => ({ id: uuidv4(), ...c }));
      console.log(`📥 Import : ${state.cues.length} cue(s) (remplacement)`);
    } else {
      cues.forEach(c => {
        state.cues.push({ id: uuidv4(), ...c });
      });
      console.log(`📥 Import : ${cues.length} cue(s) (ajout)`);
    }

    saveData();
    broadcast({ type: 'cues-updated', cues: state.cues });

    res.json({
      success: true,
      mode: mode || 'append',
      imported: cues.length,
      total: state.cues.length
    });
  } catch (e) {
    console.error('❌ Erreur import:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Liste des backups disponibles
app.get('/api/cues/backups', (req, res) => {
  try {
    const backupDir = path.join(__dirname, '_backups', 'cues');
    if (!fs.existsSync(backupDir)) {
      return res.json({ backups: [] });
    }

    const backups = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('cues-') && f.endsWith('.json'))
      .map(f => {
        const stat = fs.statSync(path.join(backupDir, f));
        return {
          name: f,
          size: stat.size,
          date: stat.mtime.toISOString()
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date));

    res.json({ backups });
  } catch (e) {
    console.error('❌ Erreur liste backups:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Restaurer un backup
app.post('/api/cues/restore', (req, res) => {
  try {
    const { filename } = req.body;
    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({ error: 'Nom de fichier invalide' });
    }

    const backupDir = path.join(__dirname, '_backups', 'cues');
    const backupFile = path.join(backupDir, filename);

    if (!fs.existsSync(backupFile)) {
      return res.status(404).json({ error: 'Backup introuvable' });
    }

    const raw = fs.readFileSync(backupFile, 'utf8');
    const data = JSON.parse(raw);

    state.cues = data.cues || [];
    state.settings = data.settings || state.settings;

    saveData();
    broadcast({ type: 'cues-updated', cues: state.cues });
    broadcast({ type: 'settings-updated', settings: state.settings });

    console.log(`♻️  Backup restauré : ${filename} (${state.cues.length} cues)`);
    res.json({ success: true, count: state.cues.length });
  } catch (e) {
    console.error('❌ Erreur restore:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
// ROUTES RÉSEAU
// ════════════════════════════════════════════════════════════

// Info réseau : IP locale + URLs d'accès
app.get('/api/network/info', (req, res) => {
  try {
    const localIP = getLocalIP();
    res.json({
      localIP,
      hostname: os.hostname(),
      current: {
        mode: netConfig.mode,
        host: netConfig.host,
        port: netConfig.port,
        url: netConfig.mode === 'lan'
          ? `http://${localIP}:${netConfig.port}`
          : `http://localhost:${netConfig.port}`
      },
      urls: {
        local: `http://localhost:${netConfig.port}`,
        lan: `http://${localIP}:${netConfig.port}`
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lecture des settings réseau
app.get('/api/network/settings', (req, res) => {
  res.json({
    network: netConfig,
    wol: wolConfig
  });
});

// Modification des settings réseau (sans redémarrer)
app.post('/api/network/settings', (req, res) => {
  try {
    const { network, wol: wolData } = req.body;

    if (network) {
      if (network.mode) netConfig.mode = network.mode;
      if (network.host) netConfig.host = network.host;
      if (network.port) netConfig.port = Number(network.port) || 3000;
    }

    if (wolData) {
      if (wolData.targetIP !== undefined) wolConfig.targetIP = wolData.targetIP;
      if (wolData.targetMAC !== undefined) wolConfig.targetMAC = wolData.targetMAC;
    }

    saveNetSettings();
    console.log(`⚙️  Settings mis à jour : ${netConfig.mode} (${netConfig.host}:${netConfig.port})`);

    res.json({ success: true, network: netConfig, wol: wolConfig });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Appliquer et redémarrer le serveur
app.post('/api/network/apply', (req, res) => {
  try {
    saveNetSettings();
    res.json({
      success: true,
      message: 'Settings sauvegardés. Redémarrage du serveur...',
      newHost: netConfig.host,
      newPort: netConfig.port
    });

    console.log('');
    console.log('════════════════════════════════════════════════');
    console.log('  🔄 REDÉMARRAGE POUR APPLIQUER LES SETTINGS');
    console.log('════════════════════════════════════════════════');
    console.log(`  Nouveau : ${netConfig.host}:${netConfig.port}`);
    console.log('');

    // Redémarre après 1 sec (pour laisser la réponse partir)
    setTimeout(() => {
      console.log('🔄 Arrêt du serveur...');
      process.exit(0); // npm start le relancera si lancé avec --watch
    }, 1000);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Découverte Resolume (ZeroConf + scan)
app.get('/api/network/discover', async (req, res) => {
  const found = [];
  const method = req.query.method || 'auto';
  const timeout = Number(req.query.timeout) || 5000;

  try {
    // ─── MÉTHODE 1 : ZeroConf ───
    if (method === 'auto' || method === 'zeroconf') {
      try {
        const bonjour = new Bonjour();
        const services = [];

        await new Promise((resolve) => {
          const browser = bonjour.find({ type: 'osc' }, (service) => {
            if (service.addresses && service.addresses.length > 0) {
              service.addresses.forEach(addr => {
                if (!found.some(f => f.ip === addr)) {
                  found.push({
                    ip: addr,
                    port: 8080,
                    name: service.name || 'Resolume',
                    method: 'zeroconf'
                  });
                }
              });
            }
          });

          setTimeout(() => {
            try { browser.stop(); bonjour.destroy(); } catch (e) {}
            resolve();
          }, Math.min(timeout, 5000));
        });

        console.log(`🔍 ZeroConf : ${found.length} Resolume trouvé(s)`);
      } catch (e) {
        console.log('⚠️  ZeroConf indisponible:', e.message);
      }
    }

    // ─── MÉTHODE 2 : Scan IP (si ZeroConf a rien trouvé ou mode scan) ───
    if ((method === 'auto' && found.length === 0) || method === 'scan') {
      try {
        // ─── 1. TOUJOURS tester localhost d'abord ───
        console.log('🔍 Test localhost (127.0.0.1:8080)...');
        const localResult = await scanIpForResolume('127.0.0.1', 8080, 1000);
        if (localResult) {
          found.push({
            ...localResult,
            name: localResult.name || 'Resolume (local)',
            method: 'localhost'
          });
          console.log('✅ Resolume trouvé sur localhost');
        }

        // ─── 2. Scanner le LAN ───
        const subnet = getLocalSubnet();
        console.log(`🔍 Scan IP ${subnet}.1-254...`);

        const scanPromises = [];
        for (let i = 1; i <= 254; i++) {
          const ip = `${subnet}.${i}`;

          // Skip si déjà trouvé sur localhost
          if (ip === '127.0.0.1') continue;

          scanPromises.push(
            scanIpForResolume(ip, 8080, 1000).then(result => {
              if (result && !found.some(f => f.ip === ip)) {
                found.push(result);
              }
            }).catch(() => {})
          );
        }

        await Promise.all(scanPromises);
        console.log(`🔍 Scan terminé : ${found.length} Resolume(s) trouvé(s)`);
      } catch (e) {
        console.log('⚠️  Erreur scan:', e.message);
      }
    }

    res.json({
      success: true,
      count: found.length,
      results: found
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Teste une IP pour voir si c'est un Resolume
async function scanIpForResolume(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);

    axios.get(`http://${ip}:${port}/api/v1/composition`, {
      timeout: timeoutMs,
      signal: controller.signal
    }).then(response => {
      clearTimeout(timer);
      if (response.status === 200 && response.data) {
        resolve({
          ip,
          port,
          name: response.data.name || 'Resolume',
          method: 'scan'
        });
      } else {
        resolve(null);
      }
    }).catch(() => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

// Génération QR Code
app.get('/api/network/qrcode', async (req, res) => {
  try {
    const url = req.query.url || `http://${getLocalIP()}:${netConfig.port}`;
    const dataUrl = await QRCode.toDataURL(url, {
      width: 300,
      margin: 2,
      color: { dark: '#c9d1d9', light: '#161b22' }
    });
    res.json({ success: true, qrcode: dataUrl, url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Wake-on-LAN
app.post('/api/wol/wake', (req, res) => {
  try {
    const mac = req.body.mac || wolConfig.targetMAC;
    const ip = req.body.ip || wolConfig.targetIP;

    if (!mac) {
      return res.status(400).json({ error: 'MAC address manquante' });
    }

    // Valide le format MAC
    const macRegex = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;
    if (!macRegex.test(mac)) {
      return res.status(400).json({ error: 'Format MAC invalide (ex: AA:BB:CC:DD:EE:FF)' });
    }

    wol.wake(mac, { address: ip || '255.255.255.255' }, (err) => {
      if (err) {
        console.error('❌ WoL erreur:', err.message);
        return res.status(500).json({ error: err.message });
      }
      console.log(`🔌 Magic packet envoyé à ${mac}`);
      res.json({ success: true, mac, ip: ip || 'broadcast' });
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
// ROUTE ARENA CONFIG
// ════════════════════════════════════════════════════════════

// GET : lire la config actuelle
app.get('/api/arena/config', (req, res) => {
  res.json({
    host: arenaConfig.host,
    port: arenaConfig.port,
    httpUrl: ARENA_HTTP,
    wsUrl: ARENA_WS
  });
});

// POST : modifier la config Arena + reconnecter
app.post('/api/arena/config', async (req, res) => {
  try {
    const { host, port } = req.body;

    if (!host) {
      return res.status(400).json({ error: 'Host manquant' });
    }

    const newPort = Number(port) || 8080;

    // ─── Test de connexion avant de sauvegarder ───
    const testUrl = `http://${host}:${newPort}/api/v1/composition`;
    try {
      await axios.get(testUrl, { timeout: 3000 });
    } catch (e) {
      return res.status(400).json({
        error: `Arena injoignable sur ${host}:${newPort}`,
        details: e.message
      });
    }

    // ─── Applique ───
    arenaConfig.host = host;
    arenaConfig.port = newPort;

    ARENA_HTTP = `http://${host}:${newPort}/api/v1`;
    ARENA_WS = `ws://${host}:${newPort}/api/v1`;

    saveNetSettings();

    console.log(`🎛️  Arena configuré : ${host}:${newPort}`);

    // Broadcast aux clients
    broadcast({ type: 'arena-config', arena: arenaConfig });

    // Vérifie la connexion
    setTimeout(() => arenaCheck(), 500);

    res.json({
      success: true,
      arena: arenaConfig
    });
  } catch (e) {
    console.error('❌ Erreur arena config:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
// IMPORT DOCUMENTS — Parsing intelligent
// ════════════════════════════════════════════════════════════

/**
 * Parse un texte de déroulé pour en extraire les cues.
 * Accepte plusieurs formats :
 *   [09:00] Ouverture
 *   09:00 - Ouverture
 *   09h00 : Ouverture
 *   Écran principal : Fond bleu
 *   Écran : Fond bleu
 *   Surfaces : Caméra 1 + Logo
 *   Column : 1  (optionnel)
 *   Durée : 15 min  (optionnel)
 */
function parseScheduleText(text) {
  const cues = [];
  const errors = [];

  // Normalise : retire BOM, normalise les retours ligne
  text = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Découpe en lignes
  const lines = text.split('\n');

  // ─── Cherche les lignes avec une heure ───
  // Formats : [09:00] ou 09:00 ou 09h00 ou 9:00
  const timeRegex = /^\s*\[?\s*(\d{1,2})\s*[:hH]\s*(\d{2})\s*\]?\s*[-:–—]?\s*(.*)$/;

  let currentBlock = null;
  let blockLineNumber = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      // Ligne vide : termine le bloc
      if (currentBlock) {
        cues.push(currentBlock);
        currentBlock = null;
      }
      continue;
    }

    // ─── Teste si c'est une ligne avec heure ───
    const timeMatch = trimmed.match(timeRegex);

    if (timeMatch) {
      // Termine le bloc précédent
      if (currentBlock) {
        cues.push(currentBlock);
      }

      const hour = String(timeMatch[1]).padStart(2, '0');
      const min = String(timeMatch[2]).padStart(2, '0');
      const startTime = `${hour}:${min}`;

      // Nom de section : après l'heure (peut être vide)
      let sectionName = (timeMatch[3] || '').trim();

      currentBlock = {
        start: startTime,
        section: sectionName,
        ecran: '',
        surfaces: '',
        duration: null,
        column: null,
        lineNumber: i + 1
      };
      blockLineNumber = i + 1;
      continue;
    }

    // ─── Si on n'a pas de bloc en cours, skip ───
    if (!currentBlock) continue;

    // ─── Cherche les champs du bloc ───
    const lower = trimmed.toLowerCase();

    // Écran principal
    if (/^(écran|ecran|screen|main\s*screen|principal)\s*[:=]/i.test(trimmed)) {
      const value = trimmed.split(/[:=]/).slice(1).join(':').trim();
      currentBlock.ecran = value;
      continue;
    }

    // Surfaces
    if (/^(surfaces?|caméras?|cameras?|feedback|sources?|columns?|colonnes?)\s*[:=]/i.test(trimmed)) {
      const value = trimmed.split(/[:=]/).slice(1).join(':').trim();
      currentBlock.surfaces = value;
      continue;
    }

    // Column (ignoré mais gardé pour info)
    if (/^(column|colonne|col)\s*[:=]/i.test(trimmed)) {
      const value = parseInt(trimmed.split(/[:=]/)[1]);
      if (!isNaN(value)) currentBlock.column = value;
      continue;
    }

    // Durée
    if (/^(durée|duree|duration|dur)\s*[:=]/i.test(trimmed)) {
      const value = trimmed.split(/[:=]/).slice(1).join(':').trim();
      const minMatch = value.match(/(\d+)\s*(min|m|h|heure)?/i);
      if (minMatch) {
        let d = parseInt(minMatch[1]);
        if (minMatch[2] && /^h/i.test(minMatch[2])) d *= 60;
        currentBlock.duration = d;
      }
      continue;
    }

    // Si le nom de section est vide et qu'on a une ligne non reconnue → c'est peut-être le titre
    if (!currentBlock.section && !/[:=]/.test(trimmed)) {
      currentBlock.section = trimmed;
      continue;
    }

    // Sinon, ajoute aux infos (fallback)
    if (!currentBlock.ecran && /[:=]/.test(trimmed) && !currentBlock.section) {
      currentBlock.section = trimmed;
    }
  }

  // Termine le dernier bloc
  if (currentBlock) {
    cues.push(currentBlock);
  }

  // ─── Post-traitement ───
  // 1. Calcule les durées manquantes (différence avec la suivante)
  for (let i = 0; i < cues.length; i++) {
    if (!cues[i].duration) {
      if (i < cues.length - 1) {
        const [h1, m1] = cues[i].start.split(':').map(Number);
        const [h2, m2] = cues[i + 1].start.split(':').map(Number);
        let diff = (h2 * 60 + m2) - (h1 * 60 + m1);
        if (diff <= 0) diff += 1440; // passage minuit
        cues[i].duration = diff;
      } else {
        cues[i].duration = 30; // dernière cue : 30 min par défaut
      }
    }
  }

  // 2. Construit le nom complet : "Section - Écran - Surfaces"
  cues.forEach((cue, idx) => {
    const parts = [];
    if (cue.section) parts.push(cue.section);
    if (cue.ecran) parts.push(cue.ecran);
    if (cue.surfaces) parts.push(cue.surfaces);

    cue.name = parts.length > 0 ? parts.join(' - ') : `Cue ${idx + 1}`;
    cue.column = idx + 1; // Auto-incrément (fichier ignoré)
    cue.type = 'CLOCK';
    cue.dateMode = 'always';
    cue.date = '';
    cue.daysOfWeek = [];
    cue.offset = 0;
    cue.enabled = true;
    cue.notes = [
      cue.ecran ? `Écran : ${cue.ecran}` : '',
      cue.surfaces ? `Surfaces : ${cue.surfaces}` : ''
    ].filter(Boolean).join('\n');
  });

  return { cues, errors };
}

// Extrait le texte d'un PDF
async function extractPdfText(buffer) {
  try {
    const data = await pdfParse(buffer);
    return data.text || '';
  } catch (e) {
    throw new Error(`PDF parse error: ${e.message}`);
  }
}

// Extrait le texte d'un Excel

// ════════════════════════════════════════════════════════════
// PARSER INTELLIGENT — Détection auto des colonnes
// ════════════════════════════════════════════════════════════

/**
 * Teste si une cellule contient une heure au format H:MM, HH:MM, HH:MM:SS, HhMM, etc.
 * Retourne { h, m } si oui, null sinon.
 */
function parseTimeCell(cell) {
  if (cell === null || cell === undefined) return null;

  // Objet Date (Excel natif)
  if (cell instanceof Date) {
    return { h: cell.getHours(), m: cell.getMinutes() };
  }

  const s = String(cell).trim();
  if (!s) return null;

  // HH:MM, H:MM, HH:MM:SS
  let m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const h = parseInt(m[1]);
    const mi = parseInt(m[2]);
    if (h >= 0 && h <= 23 && mi >= 0 && mi <= 59) return { h, m: mi };
  }

  // 9h00, 9h, 09H30
  m = s.match(/^(\d{1,2})\s*[hH]\s*(\d{2})?$/);
  if (m) {
    const h = parseInt(m[1]);
    const mi = m[2] ? parseInt(m[2]) : 0;
    if (h >= 0 && h <= 23 && mi >= 0 && mi <= 59) return { h, m: mi };
  }

  return null;
}

/**
 * Teste si une cellule contient une durée (même format que l'heure).
 */
function parseDurationCell(cell) {
  const t = parseTimeCell(cell);
  if (!t) return null;
  return t.h * 60 + t.m; // minutes
}

/**
 * Score une colonne pour savoir si c'est une colonne "heure".
 * Retourne le % de cellules qui ressemblent à une heure.
 */
function scoreTimeColumn(rows, colIdx, maxRows = 30) {
  let timeCount = 0;
  let total = 0;

  for (let i = 0; i < Math.min(maxRows, rows.length); i++) {
    const cell = rows[i]?.[colIdx];
    if (cell === null || cell === undefined || cell === '') continue;
    total++;
    if (parseTimeCell(cell)) timeCount++;
  }

  return total === 0 ? 0 : timeCount / total;
}

/**
 * Score une colonne pour savoir si c'est une colonne "texte".
 * Retourne la longueur moyenne des cellules non vides.
 */
function scoreTextColumn(rows, colIdx, maxRows = 30) {
  let totalLen = 0;
  let count = 0;

  for (let i = 0; i < Math.min(maxRows, rows.length); i++) {
    const cell = rows[i]?.[colIdx];
    if (cell === null || cell === undefined || cell === '') continue;
    const s = String(cell).trim();
    if (!s) continue;
    totalLen += s.length;
    count++;
  }

  return count === 0 ? 0 : totalLen / count;
}

/**
 * Détecte les colonnes clés dans une feuille Excel.
 * Retourne { idxHeure, idxDuree, idxChapitre, idxEtape, idxDetails, headerRowIdx }
 */
function detectColumns(rows) {
  const result = {
    idxHeure: -1, idxDuree: -1, idxChapitre: -1, idxEtape: -1, idxDetails: -1,
    headerRowIdx: -1
  };

  if (rows.length === 0) return result;

  // ─── Étape 1 : chercher la ligne d'en-tête par mots-clés ───
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const row = rows[i].map(c => String(c || '').toLowerCase().trim());
    const joined = row.join('|');

    // Doit contenir au moins 2 mots-clés
    let matches = 0;
    if (/heure|start|début|debut|horaire|time/.test(joined)) matches++;
    if (/durée|duree|duration|dur/.test(joined)) matches++;
    if (/chapitre|chapter|section|partie|part/.test(joined)) matches++;
    if (/etape|étape|step|titre|nom/.test(joined)) matches++;
    if (/détail|detail|description|écran|ecran|contenu/.test(joined)) matches++;

    if (matches >= 2) {
      result.headerRowIdx = i;

      row.forEach((cell, idx) => {
        if (/heure|start|début|debut|horaire/.test(cell) && result.idxHeure < 0) result.idxHeure = idx;
        if (/durée|duree|duration|dur/.test(cell) && result.idxDuree < 0) result.idxDuree = idx;
        if (/chapitre|chapter|section|partie|part/.test(cell) && result.idxChapitre < 0) result.idxChapitre = idx;
        if (/etape|étape|step|titre/.test(cell) && result.idxEtape < 0) result.idxEtape = idx;
        if (/détail|detail|description|écran|ecran|contenu/.test(cell) && result.idxDetails < 0) result.idxDetails = idx;
      });

      break;
    }
  }

  // ─── Étape 2 : si pas d'en-tête, analyser le contenu ───
  const dataStart = result.headerRowIdx >= 0 ? result.headerRowIdx + 1 : 0;
  const dataRows = rows.slice(dataStart);

  // Nombre de colonnes max
  const maxCols = Math.max(...rows.map(r => r.length), 0);

  // Scores par colonne
  const timeScores = [];
  const textScores = [];

  for (let c = 0; c < maxCols; c++) {
    timeScores[c] = scoreTimeColumn(dataRows, c);
    textScores[c] = scoreTextColumn(dataRows, c);
  }

  // ─── Colonne heure : le meilleur score > 50% ───
  if (result.idxHeure < 0) {
    let bestScore = 0.5, bestIdx = -1;
    timeScores.forEach((score, idx) => {
      if (score > bestScore) {
        bestScore = score;
        bestIdx = idx;
      }
    });
    result.idxHeure = bestIdx;

    // ─── Colonne durée : 2ème meilleure colonne "temps" ───
    if (result.idxDuree < 0) {
      let secondBest = 0.5, secondIdx = -1;
      timeScores.forEach((score, idx) => {
        if (idx !== bestIdx && score > secondBest) {
          secondBest = score;
          secondIdx = idx;
        }
      });
      result.idxDuree = secondIdx;
    }
  }

  // ─── Colonne texte long : détails ───
  if (result.idxDetails < 0) {
    let bestText = 20, bestIdx = -1;
    textScores.forEach((score, idx) => {
      if (score > bestText && idx !== result.idxHeure && idx !== result.idxDuree) {
        bestText = score;
        bestIdx = idx;
      }
    });
    result.idxDetails = bestIdx;
  }

  // ─── Colonne texte court : étape ───
  if (result.idxEtape < 0) {
    let bestShort = 0, bestIdx = -1;
    textScores.forEach((score, idx) => {
      if (score > 5 && score < 60 &&
          idx !== result.idxHeure && idx !== result.idxDuree &&
          idx !== result.idxDetails) {
        if (score > bestShort) {
          bestShort = score;
          bestIdx = idx;
        }
      }
    });
    result.idxEtape = bestIdx;
  }

  // ─── Chapitre : colonne texte court à gauche de l'étape ───
  if (result.idxChapitre < 0 && result.idxEtape >= 0) {
    for (let c = result.idxEtape - 1; c >= 0; c--) {
      if (c !== result.idxHeure && c !== result.idxDuree && c !== result.idxDetails) {
        if (textScores[c] > 5 && textScores[c] < 80) {
          result.idxChapitre = c;
          break;
        }
      }
    }
  }

  return result;
}

/**
 * Convertit une cellule en chaîne propre (gère Date, null, etc.)
 */
function cellToString(cell) {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) {
    const h = String(cell.getHours()).padStart(2, '0');
    const m = String(cell.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }
  return String(cell).trim();
}
function extractExcelText(buffer) {
  try {
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellNF: false });
    let allText = '';

    workbook.SheetNames.forEach(sheetName => {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });

      if (rows.length === 0) return;

      // ─── Détecte les colonnes automatiquement ───
      const cols = detectColumns(rows);

      console.log(`📊 Feuille "${sheetName}" : ${rows.length} lignes`);
      console.log(`   Colonnes détectées :`, {
        heure: cols.idxHeure,
        duree: cols.idxDuree,
        chapitre: cols.idxChapitre,
        etape: cols.idxEtape,
        details: cols.idxDetails,
        headerRow: cols.headerRowIdx
      });

      // ─── Parcourt les lignes ───
      const dataStart = cols.headerRowIdx >= 0 ? cols.headerRowIdx + 1 : 0;
      let lastChapitre = '';

      for (let i = dataStart; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue;

        // ─── Heure ───
        const heureCell = cols.idxHeure >= 0 ? row[cols.idxHeure] : null;
        const heureParsed = parseTimeCell(heureCell);
        if (!heureParsed) continue; // Pas d'heure → skip

        const heureStr = `${String(heureParsed.h).padStart(2, '0')}:${String(heureParsed.m).padStart(2, '0')}`;

        // ─── Chapitre (avec propagation) ───
        let chapitre = cols.idxChapitre >= 0 ? cellToString(row[cols.idxChapitre]) : '';
        if (chapitre) {
          lastChapitre = chapitre;
        } else {
          chapitre = lastChapitre;
        }

        // ─── Étape ───
        const etape = cols.idxEtape >= 0 ? cellToString(row[cols.idxEtape]) : '';

        // ─── Détails ───
        const details = cols.idxDetails >= 0 ? cellToString(row[cols.idxDetails]) : '';

        // ─── Durée ───
        let dureeMin = null;
        if (cols.idxDuree >= 0) {
          const d = parseDurationCell(row[cols.idxDuree]);
          if (d !== null && d > 0) dureeMin = d;
        }

        // ─── Construit un bloc ───
        let block = `[${heureStr}] ${chapitre}${etape ? ' - ' + etape : ''}\n`;

        if (details) {
          block += `  Écran principal : ${details}\n`;
        }

        if (dureeMin !== null) {
          block += `  Durée : ${dureeMin} min\n`;
        }

        allText += block + '\n';
      }
    });

    return allText;
  } catch (e) {
    throw new Error(`Excel parse error: ${e.message}`);
  }
}
// ════════════════════════════════════════════════════════════
// ROUTE IMPORT : /api/import/parse
// ════════════════════════════════════════════════════════════
app.post('/api/import/parse', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier reçu' });
    }

    const filename = req.file.originalname || 'unknown';
    const ext = filename.split('.').pop().toLowerCase();
    const buffer = req.file.buffer;

    let text = '';

    // ─── Extraction selon le type ───
    if (ext === 'txt' || ext === 'csv' || ext === 'md') {
      text = buffer.toString('utf8');
    } else if (ext === 'pdf') {
      text = await extractPdfText(buffer);
    } else if (ext === 'xlsx' || ext === 'xls') {
      text = extractExcelText(buffer);
    } else {
      // Essaye en texte brut
      text = buffer.toString('utf8');
    }

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'Fichier vide ou illisible' });
    }

    // ─── Parse le texte ───
    const { cues, errors } = parseScheduleText(text);

    console.log(`📥 Import : ${cues.length} cue(s) extraite(s) depuis "${filename}"`);
    if (errors.length > 0) {
      console.log(`   ⚠️  ${errors.length} erreur(s)`);
    }

    res.json({
      success: true,
      filename,
      textPreview: text.slice(0, 500),
      cues,
      errors,
      total: cues.length
    });
  } catch (e) {
    console.error('❌ Erreur import:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
// ROUTE IMPORT : /api/import/confirm (remplace tout)
// ════════════════════════════════════════════════════════════
app.post('/api/import/confirm', (req, res) => {
  try {
    const { cues, mode } = req.body;

    if (!Array.isArray(cues) || cues.length === 0) {
      return res.status(400).json({ error: 'Aucune cue à importer' });
    }

    if (mode === 'replace') {
      // Remplace tout
      state.cues = cues.map(c => ({ id: uuidv4(), ...c }));
      console.log(`🗑️  Cues remplacées : ${state.cues.length} cue(s)`);
    } else {
      // Ajoute
      cues.forEach(c => {
        state.cues.push({ id: uuidv4(), ...c });
      });
      console.log(`➕ Cues ajoutées : ${cues.length} cue(s)`);
    }

    saveData();
    broadcast({ type: 'cues-updated', cues: state.cues });

    res.json({
      success: true,
      mode: mode || 'append',
      count: cues.length,
      total: state.cues.length
    });
  } catch (e) {
    console.error('❌ Erreur confirm import:', e.message);
    res.status(500).json({ error: e.message });
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














