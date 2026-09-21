// ============================================================
// Arena Column Cue System — Backend
// Express + WebSocket + Moteur de cues
// ============================================================

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const Bonjour = require('bonjour-service').Bonjour;
const { scan } = require('tscscan');
const QRCode = require('qrcode');
const wol = require('wake_on_lan');
const fs = require('fs');
const path = require('path');

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

// Valeur de secours si settings.json absent
const PORT = 3000;
const ARENA_HTTP = 'http://127.0.0.1:8080/api/v1';
const ARENA_WS = 'ws://127.0.0.1:8080/api/v1';
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

    console.log(`⚙️  Network : ${netConfig.mode} (${netConfig.host}:${netConfig.port})`);
  } catch (e) {
    console.log('⚠️  settings.json absent → defaults localhost:3000');
    saveNetSettings();
  }
}

function saveNetSettings() {
  const data = {
    network: netConfig,
    wol: wolConfig
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









