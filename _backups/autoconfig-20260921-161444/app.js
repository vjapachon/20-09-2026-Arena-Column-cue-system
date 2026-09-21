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
  zoomMinutes: 1440,
  shortcutsEnabled: false,
  shortcutMap: {} // { cueId: 'touche' }
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

  // ─── État ───
  const isRunning = state.running && !state.settings?.paused;
  const isPaused = state.settings?.paused;

  // ─── Barre d'état géante ───
  if (el && txt) {
    el.classList.remove('running', 'paused', 'stopped');

    if (isPaused) {
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

  // ─── Boutons START / PAUSE / STOP ───
  const btnStart = document.getElementById('btnStart');
  const btnPause = document.getElementById('btnPause');
  const btnStop  = document.getElementById('btnStop');

  if (btnStart) btnStart.classList.remove('active-green', 'active-yellow', 'active-red');
  if (btnPause) btnPause.classList.remove('active-green', 'active-yellow', 'active-red');
  if (btnStop)  btnStop.classList.remove('active-green', 'active-yellow', 'active-red');

  if (isPaused) {
    if (btnPause) btnPause.classList.add('active-yellow');
  } else if (state.running) {
    if (btnStart) btnStart.classList.add('active-green');
  } else {
    if (btnStop) btnStop.classList.add('active-red');
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
        <td>${renderShortcutBadge(cue.id)}</td>
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

    // ─── Filtre cues visibles pour cette date ───
    const visibleCues = state.cues
      .filter(cue => {
        if (!cue.start) return false;
        try { return cueMatchesDate(cue, selectedDate); }
        catch (e) { return false; }
      })
      .sort((a, b) => {
        const [ah, am] = a.start.split(':').map(Number);
        const [bh, bm] = b.start.split(':').map(Number);
        return (ah * 60 + am) - (bh * 60 + bm);
      });

    // ─── Label + compteur ───
    const labelEl = document.getElementById('timelineDateLabel');
    if (labelEl) {
      labelEl.textContent = formatDateLabel(selectedDate) + (selectedIsToday ? ' (Aujourd\'hui)' : '');
    }
    const countEl = document.getElementById('timelineCount');
    if (countEl) {
      countEl.textContent = `${visibleCues.length} cue(s) à cette date`;
    }

    // ════════════════════════════════════════════════════════════
    // ZOOM RÉEL : lit state.zoomMinutes
    // ════════════════════════════════════════════════════════════
    let totalMin = Number(state.zoomMinutes) || 480; // 8h par défaut
    if (totalMin < 10) totalMin = 480;
    if (totalMin > 1440) totalMin = 1440;

    const HALF_WINDOW = totalMin / 2;

    // ─── Point de référence (NOW ou 1ère cue) ───
    let centerMin;
    if (selectedIsToday) {
      const now = new Date();
      centerMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
    } else if (visibleCues.length > 0) {
      const first = visibleCues[0];
      const [h, m] = first.start.split(':').map(Number);
      centerMin = h * 60 + m;
    } else {
      centerMin = 12 * 60;
    }

    const rangeStart = centerMin - HALF_WINDOW;
    const rangeEnd   = centerMin + HALF_WINDOW;

    const wrapperWidth = wrapper.clientWidth || 1200;
    const pxPerMin = wrapperWidth / totalMin;

    header.style.width = `${wrapperWidth}px`;
    header.style.minWidth = `${wrapperWidth}px`;
    header.style.position = 'relative';
    header.style.height = '36px';

    body.style.width = `${wrapperWidth}px`;
    body.style.minWidth = `${wrapperWidth}px`;
    body.style.position = 'relative';

    // ─── Pas des graduations selon le zoom ───
    let stepMin = 60;
    if (totalMin <= 720) stepMin = 60;
    if (totalMin <= 360) stepMin = 30;
    if (totalMin <= 120) stepMin = 15;
    if (totalMin <= 60)  stepMin = 10;
    if (totalMin <= 30)  stepMin = 5;
    if (totalMin <= 15)  stepMin = 1;
    if (totalMin <= 10)  stepMin = 1;

    // ─── Header graduations ───
    for (let i = 0; i <= totalMin; i += stepMin) {
      const absMin = rangeStart + i;
      const normMin = ((absMin % 1440) + 1440) % 1440;
      // ⚠️ FIX FLOAT : Math.floor sur h ET m
      const h = Math.floor(normMin / 60);
      const m = Math.floor(normMin % 60);

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

    // ─── Blocs cues ───
    const lanesEnd = [];

    visibleCues.forEach((cue, idx) => {
      const [h, m] = cue.start.split(':').map(Number);
      const startMin = h * 60 + m
                     + (cue.offset || 0)
                     + (state.settings?.globalOffset || 0);

      // ═══ DURÉE INTELLIGENTE ═══
      const nextCue = visibleCues[idx + 1];

      let endMin;
      let isAutoExtended = false;

      if (nextCue) {
        const [nh, nm] = nextCue.start.split(':').map(Number);
        endMin = nh * 60 + nm
               + (nextCue.offset || 0)
               + (state.settings?.globalOffset || 0);
        isAutoExtended = true;
      } else {
        endMin = startMin + (cue.duration || 30);
      }

      const dur = endMin - startMin;

      // Hors fenêtre ?
      if (endMin < rangeStart - 30 || startMin > rangeEnd + 30) return;

      const posX = (startMin - rangeStart) * pxPerMin;
      const width = Math.max(dur * pxPerMin, 80);

      let lane = 0;
      for (let i = 0; i < 8; i++) {
        if (!lanesEnd[i] || lanesEnd[i] <= posX) {
          lane = i;
          lanesEnd[i] = posX + width;
          break;
        }
      }

      // État temporel
      let stateClass = 'state-upcoming';
      if (!cue.enabled) stateClass = 'state-disabled';
      else if (selectedIsToday) {
        if (centerMin >= startMin && centerMin < endMin) stateClass = 'state-active';
        else if (centerMin >= endMin) stateClass = 'state-past';
        else if (startMin - centerMin <= 5) stateClass = 'state-imminent';
      }

      const block = document.createElement('div');
      block.className = `cue-block ${stateClass}`;
      block.style.position = 'absolute';
      block.style.left = `${posX}px`;
      block.style.width = `${width}px`;
      block.style.top = `${lane * 52 + 8}px`;
      block.style.height = '46px';
      block.style.display = 'flex';
      block.style.flexDirection = 'column';
      block.style.justifyContent = 'center';
      block.style.padding = '4px 8px';
      block.style.overflow = 'hidden';
      block.dataset.id = cue.id;

      // Format HH:MM
      const fmt = (min) => {
        const mm = ((Math.floor(min) % 1440) + 1440) % 1440;
        const hh = Math.floor(mm / 60);
        const mi = Math.floor(mm % 60);
        return `${String(hh).padStart(2,'0')}:${String(mi).padStart(2,'0')}`;
      };

      const startStr = fmt(startMin);
      const endStr = fmt(endMin);

      if (width < 140) {
        const line = document.createElement('div');
        line.style.fontSize = '0.7rem';
        line.style.fontWeight = '600';
        line.style.whiteSpace = 'nowrap';
        line.style.overflow = 'hidden';
        line.style.textOverflow = 'ellipsis';
        line.textContent = `${cue.name || 'Cue'} • ${startStr} • Col ${cue.column || 1}`;
        block.appendChild(line);
      } else {
        const line1 = document.createElement('div');
        line1.style.display = 'flex';
        line1.style.justifyContent = 'space-between';
        line1.style.alignItems = 'center';
        line1.style.gap = '6px';
        line1.style.fontSize = '0.78rem';
        line1.style.fontWeight = '600';
        line1.style.overflow = 'hidden';

        const nameEl = document.createElement('span');
        nameEl.style.whiteSpace = 'nowrap';
        nameEl.style.overflow = 'hidden';
        nameEl.style.textOverflow = 'ellipsis';
        nameEl.style.flex = '1';
        nameEl.textContent = cue.name || 'Cue';

        const colEl = document.createElement('span');
        colEl.style.fontSize = '0.65rem';
        colEl.style.opacity = '0.85';
        colEl.style.whiteSpace = 'nowrap';
        colEl.style.background = 'rgba(0,0,0,0.3)';
        colEl.style.padding = '1px 5px';
        colEl.style.borderRadius = '3px';
        colEl.textContent = `Col ${cue.column || 1}`;

        line1.appendChild(nameEl);
        line1.appendChild(colEl);

        const line2 = document.createElement('div');
        line2.style.fontSize = '0.65rem';
        line2.style.opacity = '0.9';
        line2.style.fontVariantNumeric = 'tabular-nums';
        line2.style.whiteSpace = 'nowrap';
        line2.style.overflow = 'hidden';
        line2.style.textOverflow = 'ellipsis';

        let durText;
        if (dur >= 60) {
          const dh = Math.floor(dur / 60);
          const dm = Math.floor(dur % 60);
          durText = dm > 0 ? `${dh}h${String(dm).padStart(2,'0')}` : `${dh}h`;
        } else {
          durText = `${Math.floor(dur)}m`;
        }

        const extMark = isAutoExtended ? '→' : '•';
        line2.textContent = `${startStr} → ${endStr} ${extMark} ${durText}`;

        block.appendChild(line1);
        block.appendChild(line2);
      }

      if (stateClass === 'state-active') {
        const progress = ((centerMin - startMin) / dur) * 100;
        const bar = document.createElement('div');
        bar.className = 'progress-bar';
        bar.style.width = `${Math.min(100, Math.max(0, progress))}%`;
        block.appendChild(bar);
      }

      // Mini-badge raccourci (coin supérieur droit)
      const scLabel = getShortcutLabel(cue.id);
      if (scLabel) {
        const mini = document.createElement('div');
        mini.className = 'shortcut-mini';
        mini.textContent = scLabel;
        block.appendChild(mini);
      }

      block.title = `${cue.name || 'Cue'}\n${startStr} → ${endStr}\nDurée : ${dur} min\nColumn : ${cue.column || 1}`;

      block.ondblclick = () => editCue(cue.id);
      body.appendChild(block);
    });

    // ─── Ligne NOW ───
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
    body.style.height = `${maxLanes * 52 + 20}px`;

  } catch (err) {
    console.error('renderTimeline error:', err);
  }
}

// ════════════════════════════════════════════════════════════
// AUTO-FIT RÉEL : calcule la plage des cues visibles
// ════════════════════════════════════════════════════════════
function autoFitTimeline() {
  try {
    const selectedDate = getTimelineDate();
    const visibleCues = state.cues
      .filter(cue => {
        if (!cue.start) return false;
        try { return cueMatchesDate(cue, selectedDate); }
        catch (e) { return false; }
      })
      .sort((a, b) => a.start.localeCompare(b.start));

    if (visibleCues.length === 0) {
      // Pas de cues → zoom 8h par défaut
      state.zoomMinutes = 480;
      const sel = document.getElementById('zoomSelect');
      if (sel) sel.value = '480';
      renderTimeline();
      return;
    }

    // Calcule la durée totale (1ère cue → dernière cue)
    const firstCue = visibleCues[0];
    const lastCue = visibleCues[visibleCues.length - 1];

    const [fh, fm] = firstCue.start.split(':').map(Number);
    const [lh, lm] = lastCue.start.split(':').map(Number);

    const firstMin = fh * 60 + fm;
    const lastMin = lh * 60 + lm + (lastCue.duration || 30);

    const span = lastMin - firstMin;

    // Ajoute une marge de 30 min de chaque côté
    const totalWithMargin = span + 60;

    // Arrondit au niveau de zoom le plus proche
    const zoomLevels = [10, 15, 30, 60, 360, 720, 1440];
    let bestZoom = 1440;
    for (const z of zoomLevels) {
      if (z >= totalWithMargin) { bestZoom = z; break; }
    }

    state.zoomMinutes = bestZoom;

    // Met à jour le sélecteur
    const sel = document.getElementById('zoomSelect');
    if (sel) sel.value = String(bestZoom);

    console.log(`🎯 Auto-fit : ${span} min de cues → zoom ${bestZoom} min`);
    renderTimeline();
  } catch (err) {
    console.error('autoFitTimeline error:', err);
  }
}
// ════════════════════════════════════════════════════════════
// TOPBAR — COMPTEURS + ALERTES
// ════════════════════════════════════════════════════════════
function updateTopbarCounters() {
  const elActive = document.getElementById('cueActive');
  const elNext = document.getElementById('cueNext');
  if (!elActive || !elNext) return;

  const now = new Date();
  const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const offsetSec = (state.settings?.globalOffset || 0) * 60;

  // ─── FILTRE : cues actives aujourd'hui ───
  const todayCues = state.cues.filter(c => {
    if (!c || !c.start || !c.enabled) return false;
    try {
      return cueMatchesDate(c, todayISOLocal());
    } catch (e) { return false; }
  });

  // ─── CUE ACTIVE : start <= now < start + duration ───
  let activeCue = null;
  todayCues.forEach(c => {
    const [h, m] = c.start.split(':').map(Number);
    const startSec = h * 3600 + m * 60 + (c.offset || 0) * 60 + offsetSec;
    const endSec = startSec + (c.duration || 0) * 60;
    if (nowSec >= startSec && nowSec < endSec) {
      activeCue = c;
    }
  });

  // ─── NEXT CUE : première cue future ───
  const sorted = [...todayCues].sort((a, b) => {
    const [ah, am] = a.start.split(':').map(Number);
    const [bh, bm] = b.start.split(':').map(Number);
    return (ah * 60 + am) - (bh * 60 + bm);
  });

  let nextCue = null;
  for (const c of sorted) {
    const [h, m] = c.start.split(':').map(Number);
    const startSec = h * 3600 + m * 60 + (c.offset || 0) * 60 + offsetSec;
    if (startSec > nowSec) {
      nextCue = c;
      break;
    }
  }

  // ─── AFFICHAGE ACTIVE ───
  if (activeCue) {
    const [h, m] = activeCue.start.split(':').map(Number);
    const startSec = h * 3600 + m * 60 + (activeCue.offset || 0) * 60 + offsetSec;
    const elapsed = nowSec - startSec;
    const total = (activeCue.duration || 0) * 60;
    // Affiche "MM:SS restant" dans la cue active (compte à rebours)
    const remaining = Math.max(0, total - elapsed);
    elActive.textContent = formatHMS(remaining);
  } else {
    elActive.textContent = '--:--:--';
  }

  // ─── AFFICHAGE NEXT ───
  if (nextCue) {
    const [h, m] = nextCue.start.split(':').map(Number);
    const startSec = h * 3600 + m * 60 + (nextCue.offset || 0) * 60 + offsetSec;
    const diff = startSec - nowSec;
    elNext.textContent = diff > 0 ? formatHMS(diff) : '--:--:--';
  } else {
    // ⚠️ Si pas de next → --:-- (pas de boucle 24h)
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

// ════════════════════════════════════════════════════════════
// RACCOURCIS CLAVIER — AZERTY
// ════════════════════════════════════════════════════════════

// Clavier AZERTY complet (4 lignes × 10 touches = 40)
const AZERTY_KEYS = [
  // Ligne 1
  '&', 'é', '"', "'", '(', '-', 'è', '_', 'ç', 'à',
  // Ligne 2
  'a', 'z', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p',
  // Ligne 3
  'q', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm',
  // Ligne 4
  'w', 'x', 'c', 'v', 'b', 'n', ',', ';', ':', '!'
];

// Génère la liste complète des raccourcis disponibles (120 max)
function buildShortcutList() {
  const list = [];
  const MAX = 120;

  // Niveau 1 : touches simples (40)
  AZERTY_KEYS.forEach(k => {
    if (list.length < MAX) list.push({ key: k, label: k, level: 'simple' });
  });

  // Niveau 2 : Shift + touche (40)
  AZERTY_KEYS.forEach(k => {
    if (list.length < MAX) list.push({ key: 'Shift+' + k, label: '⇧' + k, level: 'shift' });
  });

  // Niveau 3 : Ctrl + touche (40)
  AZERTY_KEYS.forEach(k => {
    if (list.length < MAX) list.push({ key: 'Ctrl+' + k, label: '⌃' + k, level: 'ctrl' });
  });

  return list;
}

// Mappe les raccourcis aux cues (ordre chronologique)
function mapShortcuts() {
  // Filtre les cues activées qui ont un start
  const cues = state.cues
    .filter(c => c && c.start && c.enabled !== false)
    .sort((a, b) => {
      const [ah, am] = a.start.split(':').map(Number);
      const [bh, bm] = b.start.split(':').map(Number);
      return (ah * 60 + am) - (bh * 60 + bm);
    });

  if (cues.length === 0) {
    alert('Aucune cue à mapper.');
    return;
  }

  const shortcuts = buildShortcutList();

  if (cues.length > shortcuts.length) {
    alert(`⚠️ Trop de cues (${cues.length}). Maximum : ${shortcuts.length}.\nSeules les ${shortcuts.length} premières seront mappées.`);
  }

  // Réinitialise le mapping
  state.shortcutMap = {};

  // Assigne dans l'ordre chronologique
  cues.forEach((cue, idx) => {
    if (idx < shortcuts.length) {
      state.shortcutMap[cue.id] = shortcuts[idx];
    }
  });

  const mapped = Object.keys(state.shortcutMap).length;
  console.log(`🎹 ${mapped} raccourci(s) mappé(s) sur ${cues.length} cue(s)`);

  // Re-render pour afficher les badges
  renderAll();

  alert(`✅ ${mapped} raccourci(s) assigné(s) par ordre chronologique.`);
}

// Toggle ON/OFF des raccourcis
function toggleShortcuts() {
  state.shortcutsEnabled = !state.shortcutsEnabled;
  updateShortcutButton();
  console.log(state.shortcutsEnabled ? '⚡ Raccourcis ACTIVÉS' : '⚡ Raccourcis DÉSACTIVÉS');
}

// Met à jour le bouton toggle
function updateShortcutButton() {
  const btn = document.getElementById('btnToggleShortcuts');
  if (!btn) return;

  if (state.shortcutsEnabled) {
    btn.classList.remove('shortcuts-off');
    btn.classList.add('shortcuts-on');
    btn.textContent = '⚡ Raccourcis ON';
  } else {
    btn.classList.remove('shortcuts-on');
    btn.classList.add('shortcuts-off');
    btn.textContent = '⚡ Raccourcis OFF';
  }
}

// Retourne le label d'un raccourci pour une cue
function getShortcutLabel(cueId) {
  const sc = state.shortcutMap[cueId];
  return sc ? sc.label : '';
}

// Retourne le level d'un raccourci
function getShortcutLevel(cueId) {
  const sc = state.shortcutMap[cueId];
  return sc ? sc.level : '';
}

// Gestionnaire clavier global
function handleKeyboard(e) {
  // Ignore si raccourcis désactivés
  if (!state.shortcutsEnabled) return;

  // Ignore si on tape dans un champ
  const tag = (e.target.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.target.isContentEditable) return;

  // Ignore si dans le modal
  const modal = document.getElementById('modal');
  if (modal && !modal.classList.contains('hidden')) return;

  // Construit la clé pressée
  let key = e.key;

  // Normalise : Shift+& retourne '1' sur AZERTY (le caractère change)
  // On utilise e.code pour avoir la touche physique
  const isShift = e.shiftKey;
  const isCtrl = e.ctrlKey || e.metaKey;

  // Cherche la touche AZERTY correspondante
  const azKey = getAzertyKey(e.code, isShift);

  if (!azKey) return;

  // Construit la signature
  let signature = azKey;
  if (isCtrl) signature = 'Ctrl+' + azKey;
  else if (isShift) signature = 'Shift+' + azKey;

  // Cherche la cue avec ce raccourci
  let targetCueId = null;
  for (const [cueId, sc] of Object.entries(state.shortcutMap)) {
    if (sc.key === signature) {
      targetCueId = cueId;
      break;
    }
  }

  if (!targetCueId) return;

  // Empêche le comportement par défaut
  e.preventDefault();
  e.stopPropagation();

  // Trigger la cue
  console.log(`⚡ Raccourci "${signature}" → cue ${targetCueId}`);
  triggerCue(targetCueId);

  // Effet visuel
  const block = document.querySelector(`.cue-block[data-id="${targetCueId}"]`);
  if (block) {
    block.classList.add('shortcut-fired');
    setTimeout(() => block.classList.remove('shortcut-fired'), 600);
  }
}

// Convertit e.code en touche AZERTY (sans Shift)
function getAzertyKey(code, isShift) {
  // Mapping code physique → touche AZERTY (sans Shift)
  const map = {
    // Ligne chiffres (sans Shift)
    'Digit1': '&', 'Digit2': 'é', 'Digit3': '"', 'Digit4': "'", 'Digit5': '(',
    'Digit6': '-', 'Digit7': 'è', 'Digit8': '_', 'Digit9': 'ç', 'Digit0': 'à',
    // Ligne 2
    'KeyA': 'a', 'KeyZ': 'z', 'KeyE': 'e', 'KeyR': 'r', 'KeyT': 't',
    'KeyY': 'y', 'KeyU': 'u', 'KeyI': 'i', 'KeyO': 'o', 'KeyP': 'p',
    // Ligne 3
    'KeyQ': 'q', 'KeyS': 's', 'KeyD': 'd', 'KeyF': 'f', 'KeyG': 'g',
    'KeyH': 'h', 'KeyJ': 'j', 'KeyK': 'k', 'KeyL': 'l', 'KeyM': 'm',
    // Ligne 4
    'KeyW': 'w', 'KeyX': 'x', 'KeyC': 'c', 'KeyV': 'v', 'KeyB': 'b',
    'KeyN': 'n', 'Comma': ',', 'Semicolon': ';', 'Quote': ':', 'Slash': '!'
  };

  return map[code] || null;
}
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

  // ─── Raccourcis clavier ───
  bind('btnMapShortcuts', () => mapShortcuts());

  // ─── Export / Import / Backups ───
  bind('btnExport', () => exportCues());
  bind('btnImport', () => openImportDialog());
  bind('btnBackups', () => showBackups());

  // ─── Réseau ───
  bind('btnNetwork', () => openNetworkModal());
  bind('btnCloseNetwork', () => document.getElementById('modalNetwork')?.classList.add('hidden'));
  bind('btnNetApply', () => applyNetworkSettings());
  bind('btnGenQr', () => generateQrCode());
  bind('btnCopyLan', () => copyLanUrl());
  bind('btnDiscover', () => discoverResolume());
  bind('btnWolWake', () => wakeOnLan());

  // Radio mode → toggle LAN line
  document.querySelectorAll('input[name="netMode"]').forEach(r => {
    r.addEventListener('change', updateLanVisibility);
  });
  bind('btnCloseBackups', () => document.getElementById('modalBackups')?.classList.add('hidden'));

  const importInput = document.getElementById('importFileInput');
  if (importInput) importInput.onchange = handleImportFile;
  bind('btnToggleShortcuts', () => toggleShortcuts());

  // Écoute clavier global
  document.addEventListener('keydown', handleKeyboard);

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







// Génère le HTML du badge raccourci pour le tableau
function renderShortcutBadge(cueId) {
  const sc = state.shortcutMap[cueId];
  if (!sc) return '<span style="color:#484f58;font-size:0.75rem;">—</span>';

  let cls = 'shortcut-badge';
  if (sc.level === 'shift') cls += ' level-shift';
  if (sc.level === 'ctrl') cls += ' level-ctrl';

  return `<span class="${cls}">${sc.label}</span>`;
}

// ════════════════════════════════════════════════════════════
// EXPORT / IMPORT / BACKUPS
// ════════════════════════════════════════════════════════════

// Export : télécharge un fichier cues.json
function exportCues() {
  try {
    window.location.href = '/api/cues/export';
    console.log('💾 Export déclenché');
  } catch (e) {
    alert('❌ Erreur export : ' + e.message);
  }
}

// Import : ouvre le sélecteur de fichier
function openImportDialog() {
  const input = document.getElementById('importFileInput');
  if (!input) return;
  input.value = '';
  input.click();
}

// Gestionnaire d'import de fichier
async function handleImportFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    // Accepte soit { cues: [...] } soit directement [...]
    const cues = Array.isArray(data) ? data : (data.cues || []);

    if (cues.length === 0) {
      alert('⚠️ Aucune cue trouvée dans le fichier.');
      return;
    }

    // Demande le mode
    const mode = confirm(
      `📥 ${cues.length} cue(s) trouvée(s).\n\n` +
      `OK = REMPLACER les cues existantes\n` +
      `Annuler = AJOUTER aux cues existantes`
    ) ? 'replace' : 'append';

    const res = await fetch('/api/cues/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues, mode })
    });

    const result = await res.json();
    if (result.success) {
      alert(`✅ ${result.imported} cue(s) importée(s) (${result.mode}).\nTotal : ${result.total}`);
    } else {
      alert('❌ Erreur : ' + (result.error || 'inconnue'));
    }
  } catch (e) {
    alert('❌ Fichier invalide : ' + e.message);
  }
}

// Affiche la liste des backups
async function showBackups() {
  const modal = document.getElementById('modalBackups');
  const list = document.getElementById('backupsList');
  if (!modal || !list) return;

  modal.classList.remove('hidden');
  list.innerHTML = '<p style="color:#8b949e;">Chargement...</p>';

  try {
    const res = await fetch('/api/cues/backups');
    const data = await res.json();
    const backups = data.backups || [];

    if (backups.length === 0) {
      list.innerHTML = '<p style="color:#8b949e;">Aucun backup disponible.</p>';
      return;
    }

    list.innerHTML = '';
    backups.forEach(b => {
      const size = Math.round(b.size / 1024);
      const date = new Date(b.date).toLocaleString('fr-FR');

      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.justifyContent = 'space-between';
      row.style.alignItems = 'center';
      row.style.padding = '0.5rem';
      row.style.borderBottom = '1px solid var(--border)';
      row.style.gap = '0.5rem';

      const info = document.createElement('div');
      info.style.flex = '1';
      info.innerHTML = `
        <div style="font-size:0.8rem;font-family:monospace;">${b.name}</div>
        <div style="font-size:0.7rem;color:#8b949e;">${date} • ${size} KB</div>
      `;

      const btn = document.createElement('button');
      btn.className = 'btn small';
      btn.textContent = '♻️ Restaurer';
      btn.onclick = () => restoreBackup(b.name);

      row.appendChild(info);
      row.appendChild(btn);
      list.appendChild(row);
    });
  } catch (e) {
    list.innerHTML = '<p style="color:#f85149;">❌ Erreur chargement backups.</p>';
  }
}

// Restaure un backup
async function restoreBackup(filename) {
  if (!confirm(`♻️ Restaurer "${filename}" ?\n\nLes cues actuelles seront REMPLACÉES.`)) return;

  try {
    const res = await fetch('/api/cues/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename })
    });

    const result = await res.json();
    if (result.success) {
      alert(`✅ Backup restauré : ${result.count} cue(s)`);
      document.getElementById('modalBackups')?.classList.add('hidden');
    } else {
      alert('❌ Erreur : ' + (result.error || 'inconnue'));
    }
  } catch (e) {
    alert('❌ Erreur : ' + e.message);
  }
}

// ════════════════════════════════════════════════════════════
// UI PARAMÈTRES RÉSEAU
// ════════════════════════════════════════════════════════════

// Ouvre le modal réseau + charge les données
async function openNetworkModal() {
  const modal = document.getElementById('modalNetwork');
  if (!modal) return;

  modal.classList.remove('hidden');

  try {
    // ─── Charge les settings réseau ───
    const settingsRes = await fetch('/api/network/settings');
    const settings = await settingsRes.json();

    // ─── Charge les infos réseau ───
    const infoRes = await fetch('/api/network/info');
    const info = await infoRes.json();

    // ─── Remplit le formulaire ───
    const mode = settings.network?.mode || 'localhost';
    document.querySelectorAll('input[name="netMode"]').forEach(r => {
      r.checked = r.value === mode;
    });

    const portEl = document.getElementById('netPort');
    if (portEl) portEl.value = settings.network?.port || 3000;

    // ─── Affiche les URLs ───
    document.getElementById('netUrlLocal').textContent = info.urls?.local || '—';
    document.getElementById('netUrlLan').textContent = info.urls?.lan || '—';
    document.getElementById('netLocalIP').textContent = info.localIP || '—';
    document.getElementById('netHostname').textContent = info.hostname || '—';

    // Affiche la ligne LAN seulement si mode = lan
    const lanLine = document.getElementById('netUrlLanLine');
    if (lanLine) {
      lanLine.style.display = (mode === 'lan') ? 'flex' : 'none';
    }

    // ─── Charge les paramètres WoL ───
    const wolIP = document.getElementById('wolIP');
    const wolMAC = document.getElementById('wolMAC');
    if (wolIP) wolIP.value = settings.wol?.targetIP || '';
    if (wolMAC) wolMAC.value = settings.wol?.targetMAC || '';

  } catch (e) {
    console.error('❌ Erreur chargement réseau:', e);
    alert('Impossible de charger les paramètres réseau.');
  }
}

// Change la visibilité de la ligne LAN selon le mode
function updateLanVisibility() {
  const mode = document.querySelector('input[name="netMode"]:checked')?.value || 'localhost';
  const lanLine = document.getElementById('netUrlLanLine');
  if (lanLine) {
    lanLine.style.display = (mode === 'lan') ? 'flex' : 'none';
  }
}

// Applique les settings réseau + redémarre
async function applyNetworkSettings() {
  const mode = document.querySelector('input[name="netMode"]:checked')?.value || 'localhost';
  const port = Number(document.getElementById('netPort')?.value) || 3000;

  if (port < 1024 || port > 65535) {
    alert('⚠️ Le port doit être entre 1024 et 65535.');
    return;
  }

  if (!confirm(`Appliquer ces paramètres ?\n\nMode : ${mode}\nPort : ${port}\n\nLe serveur va redémarrer.`)) {
    return;
  }

  try {
    const res = await fetch('/api/network/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        network: {
          mode,
          host: mode === 'lan' ? '0.0.0.0' : '127.0.0.1',
          port
        }
      })
    });

    const result = await res.json();
    if (result.success) {
      alert('✅ Paramètres sauvegardés.\n\nLe serveur va redémarrer.\nRecharge la page dans quelques secondes.');
      // Le serveur va s'arrêter → il faut le relancer manuellement
    } else {
      alert('❌ Erreur : ' + (result.error || 'inconnue'));
    }
  } catch (e) {
    alert('❌ Erreur : ' + e.message);
  }
}

// Génère un QR Code
async function generateQrCode() {
  const img = document.getElementById('netQrImg');
  const placeholder = document.getElementById('netQrPlaceholder');

  try {
    const infoRes = await fetch('/api/network/info');
    const info = await infoRes.json();

    const url = info.current?.mode === 'lan'
      ? info.urls?.lan
      : info.urls?.local;

    const res = await fetch(`/api/network/qrcode?url=${encodeURIComponent(url)}`);
    const result = await res.json();

    if (result.success) {
      img.src = result.qrcode;
      img.style.display = 'block';
      placeholder.style.display = 'none';
    } else {
      alert('❌ Erreur QR Code : ' + (result.error || 'inconnue'));
    }
  } catch (e) {
    alert('❌ Erreur : ' + e.message);
  }
}

// Copie l'URL LAN dans le presse-papier
async function copyLanUrl() {
  const url = document.getElementById('netUrlLan')?.textContent;
  if (!url) return;

  try {
    await navigator.clipboard.writeText(url);
    alert('✅ URL copiée : ' + url);
  } catch (e) {
    alert('URL : ' + url);
  }
}

// Lance la découverte Resolume
async function discoverResolume() {
  const method = document.getElementById('netDiscoverMethod')?.value || 'auto';
  const results = document.getElementById('discoverResults');
  const status = document.getElementById('discoverStatus');
  const list = document.getElementById('discoverList');

  if (!results || !status || !list) return;

  results.style.display = 'block';
  status.textContent = '🔍 Recherche en cours... (peut prendre 30 sec)';
  list.innerHTML = '';
  list.innerHTML = '<p style="color:#8b949e;font-size:0.8rem;">Recherche en cours...</p>';

  try {
    const res = await fetch(`/api/network/discover?method=${method}&timeout=10000`);
    const data = await res.json();

    if (data.success) {
      status.textContent = `✅ ${data.count} instance(s) trouvée(s)`;

      if (data.count === 0) {
        list.innerHTML = '<p style="color:#8b949e;font-size:0.8rem;">Aucune instance Resolume trouvée.</p>';
        return;
      }

      list.innerHTML = '';
      data.results.forEach(r => {
        const item = document.createElement('div');
        item.className = 'discover-item';
        item.innerHTML = `
          <div class="info">${r.ip}:${r.port} <strong>${r.name || ''}</strong></div>
          <div class="method">${r.method}</div>
        `;
        item.onclick = () => {
          // Remplit l'IP Resolume (à ajouter plus tard)
          alert(`Sélectionné : ${r.ip}:${r.port}`);
        };
        list.appendChild(item);
      });
    } else {
      status.textContent = '❌ Erreur : ' + (data.error || 'inconnue');
    }
  } catch (e) {
    status.textContent = '❌ Erreur : ' + e.message;
  }
}

// Envoie un magic packet WoL
async function wakeOnLan() {
  const ip = document.getElementById('wolIP')?.value?.trim();
  const mac = document.getElementById('wolMAC')?.value?.trim();
  const status = document.getElementById('wolStatus');

  if (!mac) {
    alert('⚠️ MAC address manquante.');
    return;
  }

  if (!/^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/.test(mac)) {
    alert('⚠️ Format MAC invalide. Exemple : AA:BB:CC:DD:EE:FF');
    return;
  }

  status.textContent = '🔌 Envoi du magic packet...';
  status.className = 'wol-status';

  try {
    const res = await fetch('/api/wol/wake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, mac })
    });

    const data = await res.json();
    if (data.success) {
      status.textContent = `✅ Magic packet envoyé à ${data.mac}`;
      status.className = 'wol-status success';
    } else {
      status.textContent = '❌ Erreur : ' + (data.error || 'inconnue');
      status.className = 'wol-status error';
    }
  } catch (e) {
    status.textContent = '❌ Erreur : ' + e.message;
    status.className = 'wol-status error';
  }
}
