// ============================================================
// Arena Column Cue System — Frontend (version propre)
// ============================================================

const API = '';
let arenaColumns = [];

let state = {
  cues: [],
  settings: { globalOffset: 0, paused: false },
  running: false,
  arenaConnected: false,
  currentCueId: null,
  zoomMinutes: 1440
};
// ════════════════════════════════════════════════════════════
// HELPERS DATE — Filtre timeline
// ════════════════════════════════════════════════════════════

// Retourne la date sélectionnée dans le sélecteur (format YYYY-MM-DD)
function getTimelineDate() {
  const el = document.getElementById('timelineDate');
  if (!el || !el.value) return todayISOLocal();
  return el.value;
}

// Date du jour au format YYYY-MM-DD (heure locale)
function todayISOLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Vérifie si une cue doit s'afficher à une date donnée (YYYY-MM-DD)
function cueMatchesDate(cue, dateISO) {
  const mode = cue.dateMode || 'always';
  const target = new Date(dateISO + 'T12:00:00');
  const targetDay = target.getDay(); // 0 = dim, 1 = lun...

  if (mode === 'always') return true;
  if (mode === 'once')   return cue.date === dateISO;
  if (mode === 'daily')  return !cue.date || cue.date <= dateISO;
  if (mode === 'weekly') {
    const days = cue.daysOfWeek || [];
    return days.includes(targetDay);
  }
  return false;
}

// Formate la date affichée (label à droite du sélecteur)
function formatDateLabel(dateISO) {
  if (!dateISO) return '';
  const d = new Date(dateISO + 'T12:00:00');
  const days = ['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'];
  const months = ['Jan','Fév','Mar','Avr','Mai','Juin','Juil','Août','Sep','Oct','Nov','Déc'];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

// Vérifie si une date = aujourd'hui
function isToday(dateISO) {
  return dateISO === todayISOLocal();
}

// ════════════════════════════════════════════════════════════
// WEBSOCKET
// ════════════════════════════════════════════════════════════
let ws;
function connectWS() {
  try {
    ws = new WebSocket(`ws://${location.host}`);
  } catch (e) {
    console.error('WS error:', e);
    setTimeout(connectWS, 2000);
    return;
  }

  ws.onmessage = e => {
    try {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case 'init':
          state.cues = msg.cues || [];
          state.settings = msg.settings || state.settings;
          state.running = msg.running;
          state.arenaConnected = msg.arenaConnected;
          renderAll();
          break;
        case 'cues-updated':
          state.cues = msg.cues;
          renderAll();
          break;
        case 'settings-updated':
          state.settings = msg.settings;
          updateOffsetInput();
          updateBigStatus();
          break;
        case 'state':
          state.running = msg.running;
          updateBigStatus();
          break;
        case 'arena-status':
          state.arenaConnected = msg.connected;
          updateArenaStatus();
          break;
        case 'cue-triggered':
          state.currentCueId = msg.cue?.id || null;
          renderTimeline();
          break;
      }
    } catch (err) {
      console.error('WS parse error:', err);
    }
  };

  ws.onclose = () => setTimeout(connectWS, 2000);
  ws.onerror = () => {};
}

// ════════════════════════════════════════════════════════════
// API
// ════════════════════════════════════════════════════════════
async function api(path, options = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  return res.json();
}

// ════════════════════════════════════════════════════════════
// RENDER ALL
// ════════════════════════════════════════════════════════════
function renderAll() {
  renderTable();
  renderTimeline();
  updateArenaStatus();
  updateOffsetInput();
  updateBigStatus();
}

// ════════════════════════════════════════════════════════════
// UTILS TEMPS
// ════════════════════════════════════════════════════════════
function formatHMS(totalSeconds) {
  if (totalSeconds < 0) return '--:--:--';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function secondsUntil(targetHHMM, offsetMin = 0) {
  if (!targetHHMM || !targetHHMM.includes(':')) return -99999;
  const [h, m] = targetHHMM.split(':').map(Number);
  const now = new Date();
  const target = new Date();
  target.setHours(h, m + offsetMin, 0, 0);
  let diff = Math.floor((target - now) / 1000);
  if (diff < -60) diff += 86400;
  return diff;
}

// ════════════════════════════════════════════════════════════
// ARENA COLUMNS
// ════════════════════════════════════════════════════════════
async function loadArenaColumns() {
  try {
    const res = await fetch('/api/arena/columns');
    const data = await res.json();
    const columns = Array.isArray(data) ? data : (data.columns || []);
    arenaColumns = columns;

    const select = document.getElementById('cueColumn');
    if (select) {
      const currentVal = select.value;
      select.innerHTML = '';
      columns.forEach((col, idx) => {
        const index = col.index || (idx + 1);
        let name = `Column ${index}`;
        if (typeof col.name === 'string' && col.name.trim()) name = col.name;
        else if (col.name && typeof col.name === 'object' && col.name.value) name = col.name.value;

        const opt = document.createElement('option');
        opt.value = index;
        opt.textContent = `Column ${index} — ${name}`;
        select.appendChild(opt);
      });
      if (currentVal) select.value = currentVal;
    }
  } catch (e) {
    console.error('loadArenaColumns error:', e);
  }
}

function formatArenaColumn(colIndex) {
  if (!colIndex) return '-';
  const col = arenaColumns.find(c => Number(c.index) === Number(colIndex));
  if (!col) return `Column ${colIndex}`;
  let name = col.name;
  if (name && typeof name === 'object' && name.value) name = name.value;
  return `Column ${col.index} — ${name || ''}`;
}

// ════════════════════════════════════════════════════════════
// STATUT ARENA
// ════════════════════════════════════════════════════════════
function updateArenaStatus() {
  const dot = document.getElementById('arenaStatus');
  const txt = document.getElementById('arenaStatusText');
  if (dot) {
    dot.classList.toggle('online', state.arenaConnected);
    dot.classList.toggle('offline', !state.arenaConnected);
  }
  if (txt) txt.textContent = state.arenaConnected ? 'Arena connecté' : 'Arena hors ligne';
}

// ════════════════════════════════════════════════════════════
// STATUT GÉANT
// ════════════════════════════════════════════════════════════
function updateBigStatus() {
  const el = document.getElementById('bigStatus');
  const txt = document.getElementById('bigStatusText');
  if (!el || !txt) return;

  el.classList.remove('running', 'paused', 'stopped');

  if (state.settings?.paused) {
    el.classList.add('paused');
    txt.textContent = '🟠 PAUSED';
  } else if (state.running) {
    el.classList.add('running');
    txt.textContent = '🟢 CUE SYSTEM ON';
  } else {
    el.classList.add('stopped');
    txt.textContent = '🔴 STOPPED';
  }
}

// ════════════════════════════════════════════════════════════
// TABLEAU
// ════════════════════════════════════════════════════════════
function renderTable() {
  try {
    const tbody = document.getElementById('cuesTbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!Array.isArray(state.cues) || state.cues.length === 0) {
      tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;color:#8b949e;padding:2rem;">Aucune cue. Cliquez sur "+ Nouvelle Cue"</td></tr>';
      return;
    }

    const sorted = [...state.cues]
      .filter(c => c && c.start)
      .sort((a, b) => (a.start || '').localeCompare(b.start || ''));

    state.cues.forEach(cue => {
      if (!cue) return;

      let reste = '--:--:--';
      if (cue.start) {
        const sec = secondsUntil(cue.start, (cue.offset || 0) + (state.settings?.globalOffset || 0));
        reste = sec <= 0 ? 'MAINTENANT' : formatHMS(sec);
      }

      let next = '--:--:--';
      const idx = sorted.findIndex(c => c.id === cue.id);
      if (idx >= 0 && idx < sorted.length - 1) {
        const nc = sorted[idx + 1];
        const sec = secondsUntil(nc.start, (nc.offset || 0) + (state.settings?.globalOffset || 0));
        next = sec <= 0 ? 'MAINTENANT' : formatHMS(sec);
      }

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${cue.name || '-'}</td>
        <td>${cue.type || 'CLOCK'}</td>
        <td class="arena-cell">${formatArenaColumn(cue.column)}</td>
        <td>${formatCueDate(cue)}</td>
        <td>${cue.start || '-'}</td>
        <td>${cue.end || '-'}</td>
        <td>${cue.duration ? cue.duration + 'm' : '-'}</td>
        <td>${cue.offset || 0}</td>
        <td class="countdown-cell">${reste}</td>
        <td class="countdown-cell">${next}</td>
        <td>${cue.enabled ? 'READY' : 'OFF'}</td>
        <td>
          <button class="btn small" data-action="edit" data-id="${cue.id}">✎</button>
          <button class="btn small primary" data-action="trigger" data-id="${cue.id}">▶</button>
          <button class="btn small danger" data-action="delete" data-id="${cue.id}">✕</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('button[data-action]').forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.id;
        if (btn.dataset.action === 'edit') editCue(id);
        if (btn.dataset.action === 'trigger') triggerCue(id);
        if (btn.dataset.action === 'delete') deleteCue(id);
      };
    });
  } catch (err) {
    console.error('renderTable error:', err);
  }
}

// ════════════════════════════════════════════════════════════
// TIMELINE
// ════════════════════════════════════════════════════════════
function renderTimeline() {
  try {
    const header = document.getElementById('timelineHeader');
    const body = document.getElementById('timelineBody');
    const wrapper = document.querySelector('.timeline-wrapper');
    if (!header || !body || !wrapper) return;

    header.innerHTML = '';
    body.innerHTML = '';

    // ─── Date sélectionnée ───
    const selectedDate = getTimelineDate();
    const selectedIsToday = isToday(selectedDate);
    const selectedDay = new Date(selectedDate + 'T12:00:00').getDay();

    // ─── Filtre les cues selon la date sélectionnée ───
    const visibleCues = state.cues.filter(cue => {
      if (!cue.start) return false;
      return cueMatchesDate(cue, selectedDate);
    });

    // ─── Met à jour le label de date + compteur ───
    const labelEl = document.getElementById('timelineDateLabel');
    if (labelEl) {
      labelEl.textContent = formatDateLabel(selectedDate) + (selectedIsToday ? ' (Aujourd\'hui)' : '');
    }
    const countEl = document.getElementById('timelineCount');
    if (countEl) {
      countEl.textContent = `${visibleCues.length} cue(s) à cette date`;
    }

    // ─── Fenêtre glissante 8h centrée sur MAINTENANT (ou fixe si autre date) ───
    const WINDOW_HOURS = 8;
    const HALF_WINDOW = WINDOW_HOURS / 2;

    let nowMin;
    if (selectedIsToday) {
      const now = new Date();
      nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
    } else {
      // Pour une autre date, on centre sur la 1ère cue (ou 12h par défaut)
      if (visibleCues.length > 0) {
        const first = visibleCues[0];
        const [h, m] = first.start.split(':').map(Number);
        nowMin = h * 60 + m;
      } else {
        nowMin = 12 * 60; // 12h par défaut
      }
    }

    const rangeStart = nowMin - HALF_WINDOW * 60;
    const rangeEnd   = nowMin + HALF_WINDOW * 60;
    const totalMin   = WINDOW_HOURS * 60;

    const wrapperWidth = wrapper.clientWidth || 1200;
    const pxPerMin = wrapperWidth / totalMin;

    header.style.width = `${wrapperWidth}px`;
    header.style.minWidth = `${wrapperWidth}px`;
    header.style.position = 'relative';
    header.style.height = '36px';

    body.style.width = `${wrapperWidth}px`;
    body.style.minWidth = `${wrapperWidth}px`;
    body.style.position = 'relative';

    // ─── Header : graduations toutes les 30 min ───
    const stepMin = 30;
    for (let i = 0; i <= totalMin; i += stepMin) {
      const absMin = rangeStart + i;
      const normMin = ((absMin % 1440) + 1440) % 1440;
      const h = Math.floor(normMin / 60);
      const m = normMin % 60;

      const div = document.createElement('div');
      div.className = 'hour-tick';
      div.style.position = 'absolute';
      div.style.left = `${i * pxPerMin}px`;
      div.style.height = '100%';
      div.style.display = 'flex';
      div.style.alignItems = 'center';
      div.style.paddingLeft = '6px';
      div.style.borderLeft = '1px solid var(--border)';
      div.style.fontSize = '0.72rem';
      div.style.color = 'var(--text-dim)';
      div.style.fontVariantNumeric = 'tabular-nums';
      div.style.boxSizing = 'border-box';
      div.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
      header.appendChild(div);
    }

    // ─── Blocs cues (filtrés) ───
    const lanesEnd = [];

    visibleCues.forEach((cue) => {
      const [h, m] = cue.start.split(':').map(Number);
      const startMin = h * 60 + m
                     + (cue.offset || 0)
                     + (state.settings?.globalOffset || 0);
      const dur = cue.duration || 30;
      const endMin = startMin + dur;

      if (endMin < rangeStart - 30 || startMin > rangeEnd + 30) return;

      const posX = (startMin - rangeStart) * pxPerMin;
      const width = Math.max(dur * pxPerMin, 60);

      let lane = 0;
      for (let i = 0; i < 8; i++) {
        if (!lanesEnd[i] || lanesEnd[i] <= posX) {
          lane = i;
          lanesEnd[i] = posX + width;
          break;
        }
      }

      // État temporel (seulement pertinent si on regarde aujourd'hui)
      let stateClass = 'state-upcoming';
      if (!cue.enabled) stateClass = 'state-disabled';
      else if (selectedIsToday) {
        if (nowMin >= startMin && nowMin < endMin) stateClass = 'state-active';
        else if (nowMin >= endMin) stateClass = 'state-past';
        else if (startMin - nowMin <= 5) stateClass = 'state-imminent';
      }

      const block = document.createElement('div');
      block.className = `cue-block ${stateClass}`;
      block.style.position = 'absolute';
      block.style.left = `${posX}px`;
      block.style.width = `${width}px`;
      block.style.top = `${lane * 44 + 8}px`;
      block.style.height = '38px';
      block.style.display = 'flex';
      block.style.flexDirection = 'column';
      block.style.justifyContent = 'center';
      block.style.padding = '4px 8px';
      block.dataset.id = cue.id;

      const nameEl = document.createElement('div');
      nameEl.style.fontWeight = '600';
      nameEl.style.fontSize = '0.82rem';
      nameEl.style.whiteSpace = 'nowrap';
      nameEl.style.overflow = 'hidden';
      nameEl.style.textOverflow = 'ellipsis';
      nameEl.textContent = cue.name || 'Cue';

      const timeEl = document.createElement('div');
      timeEl.style.fontSize = '0.68rem';
      timeEl.style.opacity = '0.85';
      timeEl.style.fontVariantNumeric = 'tabular-nums';
      timeEl.textContent = `${cue.start} → ${cue.end || '?'}`;

      block.appendChild(nameEl);
      block.appendChild(timeEl);

      if (stateClass === 'state-active') {
        const progress = ((nowMin - startMin) / dur) * 100;
        const bar = document.createElement('div');
        bar.className = 'progress-bar';
        bar.style.width = `${Math.min(100, Math.max(0, progress))}%`;
        block.appendChild(bar);
      }

      block.ondblclick = () => editCue(cue.id);
      body.appendChild(block);
    });

    // ─── Ligne rouge MAINTENANT (seulement si on regarde aujourd'hui) ───
    if (selectedIsToday) {
      const nowLine = document.createElement('div');
      nowLine.className = 'now-line-center';
      body.appendChild(nowLine);

      const nowLabel = document.createElement('div');
      nowLabel.className = 'now-label';
      const now = new Date();
      nowLabel.textContent = `NOW ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
      body.appendChild(nowLabel);
    }

    const maxLanes = Math.min(Math.max(lanesEnd.length, 3), 8);
    body.style.height = `${maxLanes * 44 + 20}px`;

  } catch (err) {
    console.error('renderTimeline error:', err);
  }
}
function autoFitTimeline() {
  renderTimeline();
}

// ════════════════════════════════════════════════════════════
// TOPBAR — COMPTEURS + ALERTES
// ════════════════════════════════════════════════════════════
function updateTopbarCounters() {
  const elActive = document.getElementById('cueActive');
  const elNext = document.getElementById('cueNext');
  if (!elActive || !elNext) return;

  const sorted = [...state.cues]
    .filter(c => c.start)
    .sort((a, b) => a.start.localeCompare(b.start));

  const now = new Date();
  const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

  let activeCue = null;
  sorted.forEach(c => {
    const [h, m] = c.start.split(':').map(Number);
    const startSec = h * 3600 + m * 60;
    const endSec = startSec + (c.duration || 0) * 60;
    if (nowSec >= startSec && nowSec < endSec) activeCue = c;
  });

  let nextCue = null;
  for (const c of sorted) {
    const sec = secondsUntil(c.start, (c.offset || 0) + (state.settings?.globalOffset || 0));
    if (sec > 0) { nextCue = c; break; }
  }

  if (activeCue) {
    const sec = nowSec - (parseInt(activeCue.start.split(':')[0]) * 3600 + parseInt(activeCue.start.split(':')[1]) * 60);
    elActive.textContent = formatHMS(sec);
  } else {
    elActive.textContent = '--:--:--';
  }

  if (nextCue) {
    const sec = secondsUntil(nextCue.start, (nextCue.offset || 0) + (state.settings?.globalOffset || 0));
    elNext.textContent = formatHMS(sec);
  } else {
    elNext.textContent = '--:--:--';
  }
}

function updateTopbarAlert() {
  const topbar = document.querySelector('.topbar');
  if (!topbar) return;

  topbar.classList.remove('alert-5min', 'alert-1min');

  const sorted = [...state.cues]
    .filter(c => c.start && c.enabled)
    .sort((a, b) => a.start.localeCompare(b.start));

  for (const c of sorted) {
    const sec = secondsUntil(c.start, (c.offset || 0) + (state.settings?.globalOffset || 0));
    if (sec > 0 && sec <= 60)  { topbar.classList.add('alert-1min'); return; }
    if (sec > 0 && sec <= 300) { topbar.classList.add('alert-5min'); return; }
  }
}

// ════════════════════════════════════════════════════════════
// OFFSET
// ════════════════════════════════════════════════════════════
function updateOffsetInput() {
  const el = document.getElementById('globalOffset');
  if (el) el.value = state.settings?.globalOffset || 0;
}

// ════════════════════════════════════════════════════════════
// MODAL
// ════════════════════════════════════════════════════════════
function openModal(cue = null) {
  const modal = document.getElementById('modal');
  if (!modal) { console.error('modal not found'); return; }

  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  const setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };

  const title = document.getElementById('modalTitle');
  if (title) title.textContent = cue ? 'Modifier Cue' : 'Nouvelle Cue';

  setVal('cueId', cue?.id || '');
  setVal('cueName', cue?.name || '');
  setVal('cueStart', cue?.start || '');
  setVal('cueDuration', cue?.duration || '');
  setVal('cueOffset', cue?.offset || 0);
  setVal('cueNotes', cue?.notes || '');
  setChk('cueEnabled', cue?.enabled !== false);

  const colSelect = document.getElementById('cueColumn');
  if (colSelect) colSelect.value = cue?.column || 1;

  // ─── DATE MODE ───
  const dateMode = cue?.dateMode || 'always';
  const modeSel = document.getElementById('cueDateMode');
  if (modeSel) modeSel.value = dateMode;

  // Remplit les champs date
  setVal('cueDate', cue?.date);
  setVal('cueDateStart', cue?.date);

  // Décoche puis coche les jours
  document.querySelectorAll('.day-check').forEach(cb => {
    cb.checked = false;
  });
  const days = cue?.daysOfWeek || [];
  days.forEach(d => {
    const cb = document.querySelector(`.day-check[value="${d}"]`);
    if (cb) cb.checked = true;
  });

  updateDateFieldsVisibility();
  modal.classList.remove('hidden');
}

// ─── Affiche/cache les champs selon le mode ───
function updateDateFieldsVisibility() {
  const modeSel = document.getElementById('cueDateMode');
  const mode = modeSel ? modeSel.value : 'always';

  // Cache tous les groupes
  ['dateFieldOnce', 'dateFieldDaily', 'dateFieldWeekly'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });

  // Affiche celui qui correspond
  if (mode === 'once') {
    document.getElementById('dateFieldOnce')?.classList.remove('hidden');
  } else if (mode === 'daily') {
    document.getElementById('dateFieldDaily')?.classList.remove('hidden');
  } else if (mode === 'weekly') {
    document.getElementById('dateFieldWeekly')?.classList.remove('hidden');
  }
}

function closeModal() {
  const modal = document.getElementById('modal');
  if (modal) modal.classList.add('hidden');
}

// ════════════════════════════════════════════════════════════
// CRUD
// ════════════════════════════════════════════════════════════
async function editCue(id) {
  const cue = state.cues.find(c => c.id === id);
  if (cue) openModal(cue);
}

async function deleteCue(id) {
  if (!confirm('Supprimer cette cue ?')) return;
  await api(`/api/cues/${id}`, { method: 'DELETE' });
}

async function triggerCue(id) {
  await api(`/api/trigger/${id}`, { method: 'POST' });
}

// ════════════════════════════════════════════════════════════
// HORLOGE
// ════════════════════════════════════════════════════════════
setInterval(() => {
  const el = document.getElementById('clock');
  if (!el) return;
  const d = new Date();
  el.textContent = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}, 1000);

// ════════════════════════════════════════════════════════════
// TICK 1s
// ════════════════════════════════════════════════════════════
setInterval(() => {
  renderTable();
  updateTopbarCounters();
  updateTopbarAlert();
  renderTimeline();
}, 1000);

setInterval(loadArenaColumns, 10000);

// ════════════════════════════════════════════════════════════
// BINDINGS (exécuté après DOMContentLoaded)
// ════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  const bind = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.onclick = fn;
    else console.warn(`⚠️  Élément #${id} introuvable`);
  };

  bind('btnAddCue', () => openModal());
  bind('btnCancel', () => closeModal());
  bind('btnStart', () => api('/api/start', { method: 'POST' }));
  bind('btnPause', () => api('/api/pause', { method: 'POST' }));
  bind('btnStop',  () => api('/api/stop',  { method: 'POST' }));
  bind('btnKill',  () => { if (confirm('TOUT ARRÊTER ?')) api('/api/kill', { method: 'POST' }); });
  bind('btnAutoFit', () => autoFitTimeline());

  // ─── Sélecteur de date timeline ───
  const dateInput = document.getElementById('timelineDate');
  if (dateInput) {
    // Initialise avec aujourd'hui
    dateInput.value = todayISOLocal();
    dateInput.onchange = () => renderTimeline();
  }

  bind('btnToday', () => {
    const el = document.getElementById('timelineDate');
    if (el) { el.value = todayISOLocal(); renderTimeline(); }
  });

  bind('btnPrevDay', () => {
    const el = document.getElementById('timelineDate');
    if (!el || !el.value) return;
    const d = new Date(el.value + 'T12:00:00');
    d.setDate(d.getDate() - 1);
    el.value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    renderTimeline();
  });

  bind('btnNextDay', () => {
    const el = document.getElementById('timelineDate');
    if (!el || !el.value) return;
    const d = new Date(el.value + 'T12:00:00');
    d.setDate(d.getDate() + 1);
    el.value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    renderTimeline();
  });
  bind('btnSkip', async () => {
    const sorted = [...state.cues].filter(c => c.start && c.enabled).sort((a, b) => a.start.localeCompare(b.start));
    for (const c of sorted) {
      const sec = secondsUntil(c.start, (c.offset || 0) + (state.settings?.globalOffset || 0));
      if (sec > 0) { await triggerCue(c.id); return; }
    }
  });

  bind('btnApplyOffset', () => {
    const el = document.getElementById('globalOffset');
    const offset = Number(el?.value) || 0;
    api('/api/offset', { method: 'POST', body: JSON.stringify({ offset }) });
  });

  const zoomSel = document.getElementById('zoomSelect');
  if (zoomSel) {
    zoomSel.onchange = e => {
      state.zoomMinutes = Number(e.target.value);
      renderTimeline();
    };
  }

  // Affiche/cache les champs date quand on change de mode
  const modeSel = document.getElementById('cueDateMode');
  if (modeSel) {
    modeSel.onchange = updateDateFieldsVisibility;
  }

  const form = document.getElementById('cueForm');
  if (form) {
    form.onsubmit = async e => {
      e.preventDefault();
      const getV = id => document.getElementById(id)?.value || '';
      const getC = id => document.getElementById(id)?.checked || false;

      const id = getV('cueId');
      const dateMode = getV('cueDateMode') || 'always';

      // Jours cochés (pour weekly)
      const days = [];
      document.querySelectorAll('.day-check:checked').forEach(cb => {
        days.push(Number(cb.value));
      });

      const payload = {
        name: getV('cueName'),
        column: Number(getV('cueColumn')) || 1,
        type: 'CLOCK',
        start: getV('cueStart'),
        duration: Number(getV('cueDuration')) || 0,
        offset: Number(getV('cueOffset')) || 0,
        enabled: getC('cueEnabled'),
        notes: getV('cueNotes'),
        dateMode: dateMode,
        date: dateMode === 'once'
              ? getV('cueDate')
              : dateMode === 'daily'
              ? getV('cueDateStart')
              : '',
        daysOfWeek: dateMode === 'weekly' ? days : []
      };

      if (id) await api(`/api/cues/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      else    await api('/api/cues',      { method: 'POST', body: JSON.stringify(payload) });

      closeModal();
    };
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
  });

  // Boot
  window.addEventListener('resize', renderTimeline);

  // Initialise le sélecteur de date à aujourd'hui
  const dateInputBoot = document.getElementById('timelineDate');
  if (dateInputBoot) dateInputBoot.value = todayISOLocal();

  loadArenaColumns();
  connectWS();
});



// ════════════════════════════════════════════════════════════
// FORMAT DATE pour affichage
// ════════════════════════════════════════════════════════════
function formatCueDate(cue) {
  const mode = cue.dateMode || 'always';
  const dayNames = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];

  // Helper pour afficher JJ/MM
  const formatShort = (iso) => {
    if (!iso) return '?';
    const parts = iso.split('-');
    if (parts.length !== 3) return iso;
    return `${parts[2]}/${parts[1]}`;
  };

  if (mode === 'always') {
    return `<span class="date-badge mode-always">Toujours</span>`;
  }

  if (mode === 'once') {
    return `<span class="date-badge mode-once">${formatShort(cue.date)}</span>`;
  }

  if (mode === 'daily') {
    if (!cue.date) return `<span class="date-badge mode-daily">Quotidien</span>`;
    return `<span class="date-badge mode-daily">≥ ${formatShort(cue.date)}</span>`;
  }

  if (mode === 'weekly') {
    const days = cue.daysOfWeek || [];
    if (days.length === 0) return `<span class="date-badge mode-weekly">?</span>`;
    // Trie les jours dans l'ordre Lun→Dim
    const ordered = [1,2,3,4,5,6,0];
    const sorted = ordered.filter(d => days.includes(d));
    const labels = sorted.map(d => dayNames[d]).join(' ');
    return `<span class="date-badge mode-weekly">${labels}</span>`;
  }

  return '-';
}



