// ATXXII Ban Picker & Match Timer
// Application Logic & Pop-Out Synchronized Timer
import { ATXXII_CONFIG, TOURNAMENT_SHIP_POOL, isShipBannable, getEligibleFlagships, isShipEligibleForFlagship, INELIGIBLE_FLAGSHIP_IDS } from './data/seasonRules.js';
import { NetworkManager, parseDeepLink } from './services/networkManager.js';
import { profileManager } from './services/profileManager.js';

export const networkManager = new NetworkManager();

// Safe invoke import: works both inside Tauri desktop runtime and browser dev preview
let invoke = null;
try {
  const tauriCore = await import('@tauri-apps/api/core');
  invoke = tauriCore.invoke;
} catch (e) {
  console.info('[ATXXII] Running in standard web mode without native Tauri IPC:', e);
}

// Check if current window was spawned as the Pop-Out overlay
let isPopoutMode = false;

try {
  const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const currentWin = getCurrentWebviewWindow();
  if (currentWin && currentWin.label === 'timer-popout') {
    isPopoutMode = true;
  }
} catch (e) {}

if (!isPopoutMode) {
  try {
    if (window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label === 'timer-popout') {
      isPopoutMode = true;
    }
  } catch (e) {}
}

if (!isPopoutMode) {
  const urlParams = new URLSearchParams(window.location.search);
  isPopoutMode = urlParams.has('popout') || window.location.hash.includes('popout');
}

if (isPopoutMode) {
  document.body.classList.add('is-popout');
  const popoutEl = document.getElementById('popout-container');
  if (popoutEl) popoutEl.classList.remove('hidden');
}

// Session & Role Permissions Management
const DEFAULT_SESSION_ID = 'AT-4821';
let currentSessionId = localStorage.getItem('atxxii_session_id') || DEFAULT_SESSION_ID;
let currentUserRole = localStorage.getItem('atxxii_user_role') || 'REFEREE'; // 'REFEREE' | 'TEAM_A' | 'TEAM_B' | 'SPECTATOR'

// Parse URL search params if present (e.g. from 1-click invite link: ?session=AT-4821&role=TEAM_A)
const initialUrlParams = new URLSearchParams(window.location.search);
if (initialUrlParams.has('session')) {
  const s = initialUrlParams.get('session').trim().toUpperCase();
  if (s) {
    currentSessionId = s;
    localStorage.setItem('atxxii_session_id', s);
  }
}
if (initialUrlParams.has('role')) {
  const r = initialUrlParams.get('role').trim().toUpperCase();
  if (['REFEREE', 'TEAM_A', 'TEAM_B', 'SPECTATOR'].includes(r)) {
    currentUserRole = r;
    localStorage.setItem('atxxii_user_role', r);
  }
}

// Multi-Window Synchronization Channel (Scoped per tournament session)
let syncChannel = null;

function initSyncChannel(sessionId) {
  if (syncChannel) {
    try {
      syncChannel.close();
    } catch (e) {}
  }
  const channelName = `atxxii_session_${sessionId}`;
  syncChannel = new BroadcastChannel(channelName);
  syncChannel.onmessage = handleSyncMessage;

  try {
    syncChannel.postMessage({ type: 'REQUEST_SESSION_SYNC' });
  } catch (e) {}
}

// Global Timer State
const TOTAL_MATCH_MS = 10 * 60 * 1000; // 10 minutes = 600,000 ms

const timerState = {
  phase: 'STANDBY', // STANDBY, WARMUP, MATCH, RESIGNED, MATCH OVER
  warmupMsRemaining: 60000,
  matchMsRemaining: TOTAL_MATCH_MS,
  resignedMessage: '',
  resignedTime: '',
};

let timerInterval = null;
let lastTick = performance.now();

function formatTime(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function updateTimerDisplays() {
  const formattedMatch = formatTime(timerState.matchMsRemaining);
  const formattedWarmup = formatTime(timerState.warmupMsRemaining);

  // Main UI
  const mainMatchClock = document.getElementById('main-match-timer');
  const warmupClock = document.getElementById('warmup-clock');
  const matchBadge = document.getElementById('match-status-badge');
  const resultBanner = document.getElementById('result-banner');
  const resultTitle = document.getElementById('result-title');
  const resultTimestamp = document.getElementById('result-timestamp');
  const warmupBox = document.getElementById('warmup-box');

  if (mainMatchClock) mainMatchClock.textContent = formattedMatch;
  if (warmupClock) warmupClock.textContent = formattedWarmup;
  if (matchBadge) matchBadge.textContent = timerState.phase;

  if (resultBanner && resultTitle && resultTimestamp) {
    if (timerState.phase === 'RESIGNED') {
      resultBanner.classList.remove('hidden');
      resultTitle.textContent = timerState.resignedMessage;
      resultTimestamp.textContent = `Scrim ended ${timerState.resignedTime}`;
    } else if (timerState.phase === 'MATCH OVER') {
      resultBanner.classList.remove('hidden');
      resultTitle.textContent = 'SCRIM TIME EXPIRED';
      resultTimestamp.textContent = 'Scrim reached 00:00 limit';
    } else {
      resultBanner.classList.add('hidden');
    }
  }

  // Popout UI: Always display the 10-minute scrim clock (10:00) until the scrim starts!
  const popoutMainClock = document.getElementById('popout-main-clock');
  const popoutPhaseBadge = document.getElementById('popout-phase-badge');
  const popoutWarmupDisplay = document.getElementById('popout-warmup-display');

  if (popoutMainClock) {
    popoutMainClock.textContent = formattedMatch;
  }

  if (popoutPhaseBadge) {
    popoutPhaseBadge.textContent = timerState.phase;
    if (timerState.phase === 'RESIGNED' || timerState.phase === 'MATCH OVER') {
      popoutPhaseBadge.style.color = 'var(--accent-rose)';
      popoutPhaseBadge.style.borderColor = 'var(--accent-rose)';
    } else if (timerState.phase === 'MATCH') {
      popoutPhaseBadge.style.color = 'var(--accent-emerald)';
      popoutPhaseBadge.style.borderColor = 'var(--accent-emerald)';
    } else {
      popoutPhaseBadge.style.color = 'var(--accent-cyan)';
      popoutPhaseBadge.style.borderColor = 'var(--accent-cyan)';
    }
  }

  if (popoutWarmupDisplay) {
    if (timerState.phase === 'WARMUP') {
      popoutWarmupDisplay.textContent = `WARMUP: ${formattedWarmup}`;
      popoutWarmupDisplay.style.display = 'inline-block';
    } else if (timerState.phase === 'MATCH') {
      popoutWarmupDisplay.textContent = 'SCRIM RUNNING';
      popoutWarmupDisplay.style.display = 'inline-block';
    } else if (timerState.phase === 'RESIGNED') {
      popoutWarmupDisplay.textContent = timerState.resignedMessage;
      popoutWarmupDisplay.style.display = 'inline-block';
    } else if (timerState.phase === 'MATCH OVER') {
      popoutWarmupDisplay.textContent = 'TIME EXPIRED';
      popoutWarmupDisplay.style.display = 'inline-block';
    } else {
      popoutWarmupDisplay.textContent = 'STANDBY';
      popoutWarmupDisplay.style.display = 'inline-block';
    }
  }
}

function broadcastState() {
  syncChannel?.postMessage({ type: 'SYNC_STATE', payload: timerState });
}

let autonomousTimerInterval = null;

function startAutonomousTimer() {
  if (autonomousTimerInterval) clearInterval(autonomousTimerInterval);
  autonomousTimerInterval = setInterval(runAutonomousTimerTick, 100);
}

function runAutonomousTimerTick() {
  const timing = networkManager.session?.matchTiming;
  if (!timing || !timing.matchStartUtc || timing.phase === 'STANDBY' || timing.phase === 'RESIGNED' || timing.phase === 'MATCH OVER') {
    return;
  }

  const now = networkManager.getCorrectedNow();
  if (now < timing.matchStartUtc) {
    // Warmup phase countdown to exact shared target timestamp
    timerState.phase = 'WARMUP';
    timerState.warmupMsRemaining = Math.max(0, timing.matchStartUtc - now);
    timerState.matchMsRemaining = TOTAL_MATCH_MS;
  } else {
    // Live match running locally
    const elapsed = now - timing.matchStartUtc;
    if (elapsed >= TOTAL_MATCH_MS) {
      timerState.phase = 'MATCH OVER';
      timerState.warmupMsRemaining = 0;
      timerState.matchMsRemaining = 0;
      timing.phase = 'MATCH OVER';
      if (autonomousTimerInterval) clearInterval(autonomousTimerInterval);
      autonomousTimerInterval = null;
      onMatchCompleted();
    } else {
      timerState.phase = 'MATCH';
      timerState.warmupMsRemaining = 0;
      timerState.matchMsRemaining = TOTAL_MATCH_MS - elapsed;
    }
  }

  const curSet = getActiveSet();
  if (curSet && curSet.timer) Object.assign(curSet.timer, timerState);

  updateTimerDisplays();
  updateTimerSetsNavBadges();
}

function startWarmup() {
  if (currentUserRole === 'SPECTATOR') {
    showTacticalToast('👁️ Spectator Mode: Live session is read-only.', 'warning');
    return;
  }

  if (networkManager.session) {
    const res = networkManager.triggerWarmupStart(60);
    if (!res.allowed) {
      showTacticalToast(`⛔ ${res.reason}`, 'danger');
      return;
    }
    startAutonomousTimer();
    showTacticalToast(`⏱️ 60-Second Match Warmup Started! Target Match Start: ${new Date(res.timing.matchStartUtc).toLocaleTimeString()}`, 'info');
  } else {
    // Standalone local fallback
    if (timerInterval) clearInterval(timerInterval);
    timerState.phase = 'WARMUP';
    timerState.warmupMsRemaining = 60000;
    timerState.matchMsRemaining = TOTAL_MATCH_MS;
    timerState.resignedMessage = '';
    lastTick = performance.now();

    const curSet = getActiveSet();
    if (curSet && curSet.timer) Object.assign(curSet.timer, timerState);
    updateTimerSetsNavBadges();

    timerInterval = setInterval(() => {
      const now = performance.now();
      const delta = now - lastTick;
      lastTick = now;

      if (timerState.phase === 'WARMUP') {
        timerState.warmupMsRemaining -= delta;
        if (timerState.warmupMsRemaining <= 0) {
          timerState.warmupMsRemaining = 0;
          timerState.phase = 'MATCH';
        }
      } else if (timerState.phase === 'MATCH') {
        timerState.matchMsRemaining -= delta;
        if (timerState.matchMsRemaining <= 0) {
          timerState.matchMsRemaining = 0;
          timerState.phase = 'MATCH OVER';
          clearInterval(timerInterval);
          timerInterval = null;
          onMatchCompleted();
        }
      }

      const setObj = getActiveSet();
      if (setObj && setObj.timer) Object.assign(setObj.timer, timerState);

      updateTimerDisplays();
      updateTimerSetsNavBadges();
      broadcastState();
    }, 100);

    updateTimerDisplays();
    updateTimerSetsNavBadges();
    broadcastState();
  }
}

function resignMatch(team = 'TEAM B') {
  if (networkManager.session) {
    const targetTeam = (team === 'TEAM A' || team === teamState.teamA.name) ? 'TEAM_A' : 'TEAM_B';
    const res = networkManager.triggerResign(targetTeam);
    if (!res.allowed) {
      showTacticalToast(`⛔ ${res.reason}`, 'danger');
      return;
    }
  } else {
    // Standalone local fallback
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
    timerState.phase = 'RESIGNED';
    timerState.resignedMessage = `${team} RESIGNED`;
    const elapsedMs = Math.max(0, TOTAL_MATCH_MS - timerState.matchMsRemaining);
    timerState.resignedTime = `${formatTime(elapsedMs)} (${formatTime(timerState.matchMsRemaining)} remaining)`;

    const curSet = getActiveSet();
    if (curSet && curSet.timer) Object.assign(curSet.timer, timerState);

    updateTimerDisplays();
    updateTimerSetsNavBadges();
    broadcastState();
    onMatchCompleted();
  }
}

function resetTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  if (autonomousTimerInterval) clearInterval(autonomousTimerInterval);
  autonomousTimerInterval = null;

  if (networkManager.session) {
    networkManager.triggerResetMatch();
  }

  timerState.phase = 'STANDBY';
  timerState.warmupMsRemaining = 60000;
  timerState.matchMsRemaining = TOTAL_MATCH_MS;
  timerState.resignedMessage = '';

  const curSet = getActiveSet();
  if (curSet && curSet.timer) Object.assign(curSet.timer, timerState);

  updateTimerDisplays();
  updateTimerSetsNavBadges();
  broadcastState();
}

function onMatchCompleted() {
  const currentSet = getActiveSet();
  if (currentSet && currentSet.timer) Object.assign(currentSet.timer, timerState);
  updateTimerSetsNavBadges();

  // Reset the pop-out window each time a match is completed per user requirement
  syncChannel?.postMessage({
    type: 'RESET_POPOUT_HUD',
    payload: {
      completedSetNumber: currentSet ? currentSet.setNumber : 1
    }
  });

  if (isPopoutMode) {
    resetPopoutWindowToStandby();
  } else {
    showTacticalToast(`🏁 Match ${currentSet ? currentSet.setNumber : ''} concluded (${timerState.phase}). Pop-out timer reset to 10:00 ready for next match.`, 'info');
  }
}

function resetPopoutWindowToStandby() {
  const popoutMainClock = document.getElementById('popout-main-clock');
  const popoutPhaseBadge = document.getElementById('popout-phase-badge');
  const popoutWarmupDisplay = document.getElementById('popout-warmup-display');
  if (popoutMainClock) popoutMainClock.textContent = '10:00';
  if (popoutPhaseBadge) {
    popoutPhaseBadge.textContent = 'STANDBY';
    popoutPhaseBadge.style.color = 'var(--accent-cyan)';
    popoutPhaseBadge.style.borderColor = 'var(--accent-cyan)';
  }
  if (popoutWarmupDisplay) {
    popoutWarmupDisplay.textContent = 'WARMUP: 01:00';
    popoutWarmupDisplay.style.display = 'inline-block';
  }
}

// Synchronization message handler scoped to active tournament session
function handleSyncMessage(event) {
  const { type, payload } = event.data || {};
  if (type === 'REQUEST_SESSION_SYNC') {
    broadcastState();
    broadcastSetsState();
    if (typeof teamState !== 'undefined') {
      syncChannel?.postMessage({
        type: 'SYNC_TEAMS_STATE',
        payload: teamState,
      });
    }
  } else if (type === 'SYNC_STATE' && payload) {
    Object.assign(timerState, payload);
    updateTimerDisplays();
  } else if (type === 'RESET_POPOUT_HUD') {
    if (isPopoutMode) {
      resetPopoutWindowToStandby();
    }
  } else if (type === 'SYNC_SETS_STATE' && payload) {
    if (typeof payload.activeSetIndex === 'number') activeSetIndex = payload.activeSetIndex;
    if (Array.isArray(payload.scrimSets)) {
      payload.scrimSets.forEach((s, idx) => {
        if (scrimSets[idx]) Object.assign(scrimSets[idx], s);
      });
    }
    updateBanUI();
    renderShipPool();
    updateTimerSetsNavBadges();
    renderRefereeSlots('TEAM_A');
    renderRefereeSlots('TEAM_B');
    renderTimerMatchBans();
  } else if (type === 'SYNC_TEAMS_STATE' && payload) {
    if (payload.teamA && payload.teamB) {
      teamState.teamA = { ...teamState.teamA, ...payload.teamA };
      teamState.teamB = { ...teamState.teamB, ...payload.teamB };
      populateTeamInputs();
      applyTeamState(false);
      updateSessionRoleUI();
    }
  } else if (type === 'COMMAND') {
    if (payload === 'START_WARMUP') startWarmup();
    else if (payload === 'RESIGN') resignMatch('TEAM B');
    else if (payload === 'RESET') resetTimer();
  }
}

// Connect to initial session channel
initSyncChannel(currentSessionId);

// UI Triggers for Timer Operations (Role-enforced)
document.getElementById('btn-start-warmup')?.addEventListener('click', () => {
  if (currentUserRole === 'SPECTATOR') {
    showTacticalToast('👁️ Spectator Mode: Live session is read-only. Match timer cannot be started.', 'warning');
    return;
  }
  startWarmup();
});

document.getElementById('btn-concede')?.addEventListener('click', () => {
  if (currentUserRole === 'SPECTATOR') {
    showTacticalToast('👁️ Spectator Mode: Live session is read-only.', 'warning');
    return;
  }
  const concedingTeam = (currentUserRole === 'TEAM_A') ? teamState.teamA.name : teamState.teamB.name;
  resignMatch(concedingTeam);
});

document.getElementById('btn-reset-match')?.addEventListener('click', () => {
  if (currentUserRole !== 'REFEREE') {
    showTacticalToast('⛔ Permission Denied: Only Tournament Referees can reset match clocks.', 'danger');
    return;
  }
  resetTimer();
});

// Popout Window Controls
document.getElementById('popout-btn-start')?.addEventListener('click', () => {
  startWarmup();
  syncChannel?.postMessage({ type: 'COMMAND', payload: 'START_WARMUP' });
});

document.getElementById('popout-btn-resign')?.addEventListener('click', () => {
  resignMatch('TEAM B');
  syncChannel?.postMessage({ type: 'COMMAND', payload: 'RESIGN' });
});

document.getElementById('popout-btn-reset')?.addEventListener('click', () => {
  resetTimer();
  syncChannel?.postMessage({ type: 'COMMAND', payload: 'RESET' });
});

// Pop-out Window Opening Handlers (Session & Role aware)
async function triggerTimerPopout() {
  const popoutUrl = `index.html?popout=true&session=${encodeURIComponent(currentSessionId)}&role=${encodeURIComponent(currentUserRole)}`;
  if (invoke) {
    try {
      await invoke('open_timer_popout');
    } catch (err) {
      console.error('[ATXXII] Error launching popout window:', err);
      // Fallback
      window.open(popoutUrl, '_blank', 'width=360,height=180');
    }
  } else {
    // Browser fallback
    window.open(popoutUrl, '_blank', 'width=360,height=180');
  }
}

document.getElementById('btn-popout-timer')?.addEventListener('click', triggerTimerPopout);
document.getElementById('btn-popout-timer-secondary')?.addEventListener('click', triggerTimerPopout);

// Popout close / dock back
document.getElementById('popout-btn-close')?.addEventListener('click', async () => {
  if (invoke) {
    try {
      await invoke('close_timer_popout');
    } catch (e) {
      window.close();
    }
  } else {
    window.close();
  }
});

// Headless window controls
document.getElementById('btn-win-min')?.addEventListener('click', async () => {
  if (invoke) {
    try {
      await invoke('minimize_window');
    } catch (e) {
      console.error(e);
    }
  }
});

document.getElementById('btn-win-max')?.addEventListener('click', async () => {
  try {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const win = getCurrentWebviewWindow();
    if (win) {
      await win.toggleMaximize();
      return;
    }
  } catch (e) {}

  if (invoke) {
    try {
      await invoke('toggle_maximize_window');
    } catch (e) {
      console.error(e);
    }
  }
});

document.getElementById('btn-win-close')?.addEventListener('click', async () => {
  if (invoke) {
    try {
      await invoke('close_window');
    } catch (e) {
      window.close();
    }
  } else {
    window.close();
  }
});

document.getElementById('popout-btn-min')?.addEventListener('click', async () => {
  if (invoke) {
    try {
      await invoke('minimize_window');
    } catch (e) {
      console.error(e);
    }
  }
});

// Window Dragging Handling (Rock-solid Win32 window dragging)
async function initiateWindowDrag(e) {
  if (e.button !== 0) return;
  if (e.target.closest('button, input, select, a, .filter-chips')) return;
  if (invoke) {
    try {
      await invoke('start_dragging');
    } catch (err) {
      // Ignored if cancelled
    }
  }
}

document.querySelector('.app-header')?.addEventListener('mousedown', initiateWindowDrag);
document.getElementById('popout-container')?.addEventListener('mousedown', initiateWindowDrag);
document.querySelector('.popout-drag-bar')?.addEventListener('mousedown', initiateWindowDrag);

// State & Always On Top
let isAlwaysOnTop = false;
let isPopoutPinned = true;
let activeTab = 'landing';

const pinBtn = document.getElementById('btn-always-on-top');
const popoutPinBtn = document.getElementById('popout-btn-pin');

async function toggleAlwaysOnTop() {
  const nextState = !isAlwaysOnTop;
  if (invoke) {
    try {
      await invoke('toggle_always_on_top', { enabled: nextState });
      isAlwaysOnTop = nextState;
    } catch (err) {
      console.error('[ATXXII] Failed to toggle always on top:', err);
    }
  } else {
    isAlwaysOnTop = nextState;
  }
  updatePinUI();
}

function updatePinUI() {
  if (pinBtn) {
    pinBtn.classList.toggle('pinned', isAlwaysOnTop);
    pinBtn.title = isAlwaysOnTop ? 'Always-on-Top: ON' : 'Always-on-Top: OFF';
  }
}

async function togglePopoutPin() {
  const nextState = !isPopoutPinned;
  if (invoke) {
    try {
      await invoke('toggle_popout_always_on_top', { enabled: nextState });
      isPopoutPinned = nextState;
    } catch (err) {
      console.error('[ATXXII] Failed to toggle popout pin:', err);
    }
  } else {
    isPopoutPinned = nextState;
  }
  updatePopoutPinUI();
}

function updatePopoutPinUI() {
  if (popoutPinBtn) {
    popoutPinBtn.classList.toggle('pinned', isPopoutPinned);
    popoutPinBtn.title = isPopoutPinned ? 'Always-on-Top: ON' : 'Always-on-Top: OFF';
  }
}

pinBtn?.addEventListener('click', toggleAlwaysOnTop);
popoutPinBtn?.addEventListener('click', togglePopoutPin);
updatePopoutPinUI();

// ============================================================================
// TEAM REGISTRATION & LANDING SETUP
// ============================================================================
const DEFAULT_TEAMS = {
  teamA: {
    name: 'BLUE FLEET',
    captain: 'Captain Alpha',
    ticker: 'BLU',
  },
  teamB: {
    name: 'RED FLEET',
    captain: 'Captain Bravo',
    ticker: 'RED',
  }
};

let teamState = {
  teamA: { ...DEFAULT_TEAMS.teamA },
  teamB: { ...DEFAULT_TEAMS.teamB },
};

function loadSavedTeams() {
  try {
    const saved = localStorage.getItem('atxxii_teams');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.teamA && parsed.teamB) {
        teamState.teamA = { ...DEFAULT_TEAMS.teamA, ...parsed.teamA };
        teamState.teamB = { ...DEFAULT_TEAMS.teamB, ...parsed.teamB };
      }
    }
  } catch (e) {
    console.warn('[ATXXII] Failed to read saved teams from localStorage:', e);
  }
}

function saveTeamsToStorage() {
  try {
    localStorage.setItem('atxxii_teams', JSON.stringify(teamState));
  } catch (e) {
    console.warn('[ATXXII] Failed to write teams to localStorage:', e);
  }
}

function populateTeamInputs() {
  const inputA = document.getElementById('input-team-a-name');
  const inputACap = document.getElementById('input-team-a-captain');
  const inputATick = document.getElementById('input-team-a-ticker');
  const inputB = document.getElementById('input-team-b-name');
  const inputBCap = document.getElementById('input-team-b-captain');
  const inputBTick = document.getElementById('input-team-b-ticker');

  if (inputA) inputA.value = teamState.teamA.name || '';
  if (inputACap) inputACap.value = teamState.teamA.captain || '';
  if (inputATick) inputATick.value = teamState.teamA.ticker || '';
  if (inputB) inputB.value = teamState.teamB.name || '';
  if (inputBCap) inputBCap.value = teamState.teamB.captain || '';
  if (inputBTick) inputBTick.value = teamState.teamB.ticker || '';

  const canEditA = (currentUserRole === 'REFEREE' || currentUserRole === 'TEAM_A');
  const canEditB = (currentUserRole === 'REFEREE' || currentUserRole === 'TEAM_B');

  [inputA, inputACap, inputATick].forEach(el => {
    if (el) {
      el.disabled = !canEditA;
      if (!canEditA) el.title = 'Only Team A Captain or Referee can edit Team A details.';
      else el.removeAttribute('title');
    }
  });

  [inputB, inputBCap, inputBTick].forEach(el => {
    if (el) {
      el.disabled = !canEditB;
      if (!canEditB) el.title = 'Only Team B Captain or Referee can edit Team B details.';
      else el.removeAttribute('title');
    }
  });
}

function readTeamInputs() {
  const inputA = document.getElementById('input-team-a-name');
  const inputACap = document.getElementById('input-team-a-captain');
  const inputATick = document.getElementById('input-team-a-ticker');
  const inputB = document.getElementById('input-team-b-name');
  const inputBCap = document.getElementById('input-team-b-captain');
  const inputBTick = document.getElementById('input-team-b-ticker');

  const canEditA = (currentUserRole === 'REFEREE' || currentUserRole === 'TEAM_A');
  const canEditB = (currentUserRole === 'REFEREE' || currentUserRole === 'TEAM_B');

  if (canEditA) {
    const nameA = inputA?.value.trim() || DEFAULT_TEAMS.teamA.name;
    const capA = inputACap?.value.trim() || DEFAULT_TEAMS.teamA.captain;
    const tickA = inputATick?.value.trim().toUpperCase() || DEFAULT_TEAMS.teamA.ticker;
    teamState.teamA = { name: nameA, captain: capA, ticker: tickA };
  }

  if (canEditB) {
    const nameB = inputB?.value.trim() || DEFAULT_TEAMS.teamB.name;
    const capB = inputBCap?.value.trim() || DEFAULT_TEAMS.teamB.captain;
    const tickB = inputBTick?.value.trim().toUpperCase() || DEFAULT_TEAMS.teamB.ticker;
    teamState.teamB = { name: nameB, captain: capB, ticker: tickB };
  }
}

function applyTeamState(broadcast = true) {
  const nameAEl = document.getElementById('team-a-name');
  const capAEl = document.getElementById('team-a-captain');
  const nameBEl = document.getElementById('team-b-name');
  const capBEl = document.getElementById('team-b-captain');

  const displayNameA = teamState.teamA.ticker ? `${teamState.teamA.name} [${teamState.teamA.ticker}]` : teamState.teamA.name;
  const displayNameB = teamState.teamB.ticker ? `${teamState.teamB.name} [${teamState.teamB.ticker}]` : teamState.teamB.name;

  if (nameAEl) nameAEl.textContent = displayNameA;
  if (capAEl) capAEl.textContent = `CAPTAIN: ${teamState.teamA.captain ? teamState.teamA.captain.toUpperCase() : 'UNASSIGNED'}`;

  if (nameBEl) nameBEl.textContent = displayNameB;
  if (capBEl) capBEl.textContent = `CAPTAIN: ${teamState.teamB.captain ? teamState.teamB.captain.toUpperCase() : 'UNASSIGNED'}`;

  const timerHudA = document.getElementById('timer-hud-team-a-label');
  const timerHudB = document.getElementById('timer-hud-team-b-label');
  if (timerHudA) timerHudA.textContent = `TEAM A (${teamState.teamA.name})`;
  if (timerHudB) timerHudB.textContent = `TEAM B (${teamState.teamB.name})`;

  saveTeamsToStorage();
  updateLogoDisplays();

  if (broadcast) {
    syncChannel?.postMessage({
      type: 'SYNC_TEAMS_STATE',
      payload: teamState,
    });
  }

  // Trigger UI refresh
  updateBanUI();
}

// EVE ESI Alliance & Corporation Resolver (Resolves Logo, Full Name & Official Ticker)
async function resolveAllianceLogos() {
  const namesToLookup = [];

  function addCandidates(name, ticker) {
    if (name && name !== 'BLUE FLEET' && name !== 'RED FLEET') {
      namesToLookup.push(name);
      if (!name.endsWith('.')) namesToLookup.push(name + '.');
    }
    if (ticker && ticker !== 'BLU' && ticker !== 'RED' && !namesToLookup.includes(ticker)) {
      namesToLookup.push(ticker);
    }
  }

  addCandidates(teamState.teamA.name, teamState.teamA.ticker);
  addCandidates(teamState.teamB.name, teamState.teamB.ticker);

  if (namesToLookup.length === 0) {
    updateLogoDisplays();
    return;
  }

  try {
    const res = await fetch('https://esi.evetech.net/latest/universe/ids/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(namesToLookup)
    });

    if (res.ok) {
      const data = await res.json();
      const alliances = data.alliances || [];
      const corps = data.corporations || [];

      // Resolve Team A
      if (teamState.teamA.name && teamState.teamA.name !== 'BLUE FLEET') {
        const targetAName = teamState.teamA.name.toLowerCase();
        const targetATick = (teamState.teamA.ticker || '').toLowerCase();
        const matchA = alliances.find(a => 
          a.name.toLowerCase() === targetAName || 
          a.name.toLowerCase() === (targetAName + '.') || 
          (targetATick && targetATick.length >= 2 && a.name.toLowerCase().startsWith(targetATick))
        ) || corps.find(c => 
          c.name.toLowerCase() === targetAName || 
          c.name.toLowerCase() === (targetAName + '.') ||
          (targetATick && targetATick.length >= 2 && c.name.toLowerCase().startsWith(targetATick))
        );

        if (matchA) {
          const isCorp = corps.some(c => c.id === matchA.id);
          const endpoint = isCorp
            ? `https://esi.evetech.net/latest/corporations/${matchA.id}/`
            : `https://esi.evetech.net/latest/alliances/${matchA.id}/`;

          try {
            const detailRes = await fetch(endpoint);
            if (detailRes.ok) {
              const detail = await detailRes.json();
              if (detail.ticker) {
                teamState.teamA.ticker = detail.ticker;
                const inputATick = document.getElementById('input-team-a-ticker');
                if (inputATick) inputATick.value = detail.ticker;
              }
              if (detail.name) {
                teamState.teamA.resolvedEntity = detail.name;
              }
            }
          } catch (e) {
            console.warn('[ATXXII] Failed to fetch Team A detail:', e);
          }

          teamState.teamA.logoUrl = isCorp
            ? `https://images.evetech.net/corporations/${matchA.id}/logo?size=128`
            : `https://images.evetech.net/alliances/${matchA.id}/logo?size=128`;
          if (!teamState.teamA.resolvedEntity) {
            teamState.teamA.resolvedEntity = matchA.name;
          }
        }
      }

      // Resolve Team B
      if (teamState.teamB.name && teamState.teamB.name !== 'RED FLEET') {
        const targetBName = teamState.teamB.name.toLowerCase();
        const targetBTick = (teamState.teamB.ticker || '').toLowerCase();
        const matchB = alliances.find(a => 
          a.name.toLowerCase() === targetBName || 
          a.name.toLowerCase() === (targetBName + '.') ||
          (targetBTick && targetBTick.length >= 2 && a.name.toLowerCase().startsWith(targetBTick))
        ) || corps.find(c => 
          c.name.toLowerCase() === targetBName || 
          c.name.toLowerCase() === (targetBName + '.') ||
          (targetBTick && targetBTick.length >= 2 && c.name.toLowerCase().startsWith(targetBTick))
        );

        if (matchB) {
          const isCorp = corps.some(c => c.id === matchB.id);
          const endpoint = isCorp
            ? `https://esi.evetech.net/latest/corporations/${matchB.id}/`
            : `https://esi.evetech.net/latest/alliances/${matchB.id}/`;

          try {
            const detailRes = await fetch(endpoint);
            if (detailRes.ok) {
              const detail = await detailRes.json();
              if (detail.ticker) {
                teamState.teamB.ticker = detail.ticker;
                const inputBTick = document.getElementById('input-team-b-ticker');
                if (inputBTick) inputBTick.value = detail.ticker;
              }
              if (detail.name) {
                teamState.teamB.resolvedEntity = detail.name;
              }
            }
          } catch (e) {
            console.warn('[ATXXII] Failed to fetch Team B detail:', e);
          }

          teamState.teamB.logoUrl = isCorp
            ? `https://images.evetech.net/corporations/${matchB.id}/logo?size=128`
            : `https://images.evetech.net/alliances/${matchB.id}/logo?size=128`;
          if (!teamState.teamB.resolvedEntity) {
            teamState.teamB.resolvedEntity = matchB.name;
          }
        }
      }

      saveTeamsToStorage();
      updateLogoDisplays();

      // Refresh displayed team names to include the resolved ticker
      const nameAEl = document.getElementById('team-a-name');
      const nameBEl = document.getElementById('team-b-name');
      if (nameAEl) {
        nameAEl.textContent = teamState.teamA.ticker ? `${teamState.teamA.name} [${teamState.teamA.ticker}]` : teamState.teamA.name;
      }
      if (nameBEl) {
        nameBEl.textContent = teamState.teamB.ticker ? `${teamState.teamB.name} [${teamState.teamB.ticker}]` : teamState.teamB.name;
      }
    }
  } catch (err) {
    console.warn('[ATXXII] Failed to resolve alliance logos and tickers from ESI:', err);
    updateLogoDisplays();
  }
}

function updateLogoDisplays() {
  // Landing Page Team A
  const landingLogoA = document.getElementById('landing-logo-team-a');
  const landingFallbackA = document.getElementById('landing-logo-fallback-a');
  const landingStatusA = document.getElementById('landing-logo-status-a');
  const landingSubA = document.getElementById('landing-logo-sub-a');

  if (teamState.teamA.logoUrl && landingLogoA && landingFallbackA) {
    landingLogoA.src = teamState.teamA.logoUrl;
    landingLogoA.classList.remove('hidden');
    landingFallbackA.style.display = 'none';
    if (landingStatusA) landingStatusA.textContent = teamState.teamA.resolvedEntity || teamState.teamA.name;
    if (landingSubA) landingSubA.textContent = 'Verified EVE Alliance Insignia';
  } else if (landingLogoA && landingFallbackA) {
    landingLogoA.classList.add('hidden');
    landingFallbackA.style.display = 'inline';
    landingFallbackA.textContent = (teamState.teamA.ticker || teamState.teamA.name.slice(0, 3) || 'A').toUpperCase();
    if (landingStatusA) landingStatusA.textContent = 'ALLIANCE INSIGNIA';
    if (landingSubA) landingSubA.textContent = 'Auto-resolves from EVE ESI';
  }

  // Landing Page Team B
  const landingLogoB = document.getElementById('landing-logo-team-b');
  const landingFallbackB = document.getElementById('landing-logo-fallback-b');
  const landingStatusB = document.getElementById('landing-logo-status-b');
  const landingSubB = document.getElementById('landing-logo-sub-b');

  if (teamState.teamB.logoUrl && landingLogoB && landingFallbackB) {
    landingLogoB.src = teamState.teamB.logoUrl;
    landingLogoB.classList.remove('hidden');
    landingFallbackB.style.display = 'none';
    if (landingStatusB) landingStatusB.textContent = teamState.teamB.resolvedEntity || teamState.teamB.name;
    if (landingSubB) landingSubB.textContent = 'Verified EVE Alliance Insignia';
  } else if (landingLogoB && landingFallbackB) {
    landingLogoB.classList.add('hidden');
    landingFallbackB.style.display = 'inline';
    landingFallbackB.textContent = (teamState.teamB.ticker || teamState.teamB.name.slice(0, 3) || 'B').toUpperCase();
    if (landingStatusB) landingStatusB.textContent = 'ALLIANCE INSIGNIA';
    if (landingSubB) landingSubB.textContent = 'Auto-resolves from EVE ESI';
  }

  // Bans Header Team A Logo
  const headerLogoA = document.getElementById('team-a-header-logo');
  const headerFallbackA = document.getElementById('team-a-header-fallback');
  if (teamState.teamA.logoUrl && headerLogoA && headerFallbackA) {
    headerLogoA.src = teamState.teamA.logoUrl;
    headerLogoA.classList.remove('hidden');
    headerFallbackA.style.display = 'none';
  } else if (headerLogoA && headerFallbackA) {
    headerLogoA.classList.add('hidden');
    headerFallbackA.style.display = 'inline';
    headerFallbackA.textContent = (teamState.teamA.ticker || teamState.teamA.name.slice(0, 1) || 'A').toUpperCase();
  }

  // Bans Header Team B Logo
  const headerLogoB = document.getElementById('team-b-header-logo');
  const headerFallbackB = document.getElementById('team-b-header-fallback');
  if (teamState.teamB.logoUrl && headerLogoB && headerFallbackB) {
    headerLogoB.src = teamState.teamB.logoUrl;
    headerLogoB.classList.remove('hidden');
    headerFallbackB.style.display = 'none';
  } else if (headerLogoB && headerFallbackB) {
    headerLogoB.classList.add('hidden');
    headerFallbackB.style.display = 'inline';
    headerFallbackB.textContent = (teamState.teamB.ticker || teamState.teamB.name.slice(0, 1) || 'B').toUpperCase();
  }

  // Referee Panel Team A Logo & Name
  const refLogoA = document.getElementById('ref-team-a-logo');
  const refFallbackA = document.getElementById('ref-team-a-fallback');
  const refNameA = document.getElementById('ref-team-a-name');
  if (refNameA) refNameA.textContent = teamState.teamA.ticker ? `${teamState.teamA.name} [${teamState.teamA.ticker}]` : teamState.teamA.name;
  if (teamState.teamA.logoUrl && refLogoA && refFallbackA) {
    refLogoA.src = teamState.teamA.logoUrl;
    refLogoA.classList.remove('hidden');
    refFallbackA.style.display = 'none';
  } else if (refLogoA && refFallbackA) {
    refLogoA.classList.add('hidden');
    refFallbackA.style.display = 'inline';
    refFallbackA.textContent = (teamState.teamA.ticker || teamState.teamA.name.slice(0, 1) || 'A').toUpperCase();
  }

  // Referee Panel Team B Logo & Name
  const refLogoB = document.getElementById('ref-team-b-logo');
  const refFallbackB = document.getElementById('ref-team-b-fallback');
  const refNameB = document.getElementById('ref-team-b-name');
  if (refNameB) refNameB.textContent = teamState.teamB.ticker ? `${teamState.teamB.name} [${teamState.teamB.ticker}]` : teamState.teamB.name;
  if (teamState.teamB.logoUrl && refLogoB && refFallbackB) {
    refLogoB.src = teamState.teamB.logoUrl;
    refLogoB.classList.remove('hidden');
    refFallbackB.style.display = 'none';
  } else if (refLogoB && refFallbackB) {
    refLogoB.classList.add('hidden');
    refFallbackB.style.display = 'inline';
    refFallbackB.textContent = (teamState.teamB.ticker || teamState.teamB.name.slice(0, 1) || 'B').toUpperCase();
  }
}

// Tab Switching
const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanes = document.querySelectorAll('.tab-pane');

function switchTab(targetTab) {
  activeTab = targetTab;
  tabButtons.forEach(btn => {
    const isTarget = btn.dataset.tab === targetTab;
    btn.classList.toggle('active', isTarget);
    btn.setAttribute('aria-selected', isTarget ? 'true' : 'false');
  });

  tabPanes.forEach(pane => {
    const isTarget = pane.id === `tab-content-${targetTab}`;
    pane.classList.toggle('active', isTarget);
  });
}

tabButtons.forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// Landing Page Event Listeners
document.getElementById('btn-launch-scrim')?.addEventListener('click', async () => {
  readTeamInputs();
  applyTeamState(true);
  await resolveAllianceLogos();
  switchTab('bans');
  showTacticalToast(`🚀 Scrim initialized: ${teamState.teamA.name} vs ${teamState.teamB.name}`, 'info');
});

document.getElementById('btn-launch-timer-direct')?.addEventListener('click', async () => {
  readTeamInputs();
  applyTeamState(true);
  await resolveAllianceLogos();
  switchTab('timer');
  showTacticalToast(`⏱ Deployed to Scrim Timer: ${teamState.teamA.name} vs ${teamState.teamB.name}`, 'info');
});

document.getElementById('btn-reset-team-defaults')?.addEventListener('click', () => {
  teamState = {
    teamA: { ...DEFAULT_TEAMS.teamA },
    teamB: { ...DEFAULT_TEAMS.teamB },
  };
  populateTeamInputs();
  applyTeamState(true);
  updateLogoDisplays();
  showTacticalToast('↺ Team configurations reset to defaults.', 'info');
});

document.getElementById('btn-swap-teams')?.addEventListener('click', async () => {
  readTeamInputs();
  const temp = { ...teamState.teamA };
  teamState.teamA = { ...teamState.teamB };
  teamState.teamB = temp;
  populateTeamInputs();
  applyTeamState(true);
  await resolveAllianceLogos();
  showTacticalToast('⇄ Fleet sides swapped (Team A ↔ Team B).', 'info');
});

document.getElementById('btn-edit-teams')?.addEventListener('click', () => {
  populateTeamInputs();
  switchTab('landing');
});

// Auto-resolve logos when user stops typing alliance name (on blur)
document.getElementById('input-team-a-name')?.addEventListener('blur', () => {
  readTeamInputs();
  resolveAllianceLogos();
});
document.getElementById('input-team-a-ticker')?.addEventListener('blur', () => {
  readTeamInputs();
  resolveAllianceLogos();
});
document.getElementById('input-team-b-name')?.addEventListener('blur', () => {
  readTeamInputs();
  resolveAllianceLogos();
});
document.getElementById('input-team-b-ticker')?.addEventListener('blur', () => {
  readTeamInputs();
  resolveAllianceLogos();
});

// Keyboard Shortcuts (1 = Teams, 2 = Bans, 3 = Timer, T = Pin, P = Popout)
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === '1') switchTab('landing');
  if (e.key === '2') switchTab('bans');
  if (e.key === '3') switchTab('timer');
  if (e.key === 't' || e.key === 'T') toggleAlwaysOnTop();
  if (e.key === 'p' || e.key === 'P') triggerTimerPopout();
});

// Live Footer Clock (UTC)
const footerClock = document.getElementById('local-clock');
function updateFooterClock() {
  const now = new Date();
  if (footerClock) {
    footerClock.textContent = `${now.toUTCString().slice(17, 25)} UTC`;
  }
}
setInterval(updateFooterClock, 1000);
updateFooterClock();

// Ready toggle demo
const btnReady = document.getElementById('btn-ready-toggle');
let isReady = false;
btnReady?.addEventListener('click', () => {
  isReady = !isReady;
  btnReady.classList.toggle('btn-primary', isReady);
  btnReady.classList.toggle('btn-secondary', !isReady);
  btnReady.querySelector('span:last-child').textContent = isReady ? 'READY (CONFIRMED)' : 'READY UP';
  const readyCountEl = document.getElementById('timer-ready-count');
  if (readyCountEl) readyCountEl.textContent = isReady ? '1 / 1 Ready' : '0 / 1 Ready';
});

// ============================================================================
// 5 SCRIM SETS BAN ENGINE & FLAGSHIP RULES
// Ingested from CCP's Official ATXXII Points Calculator Google Sheet
// Rules Enforced:
// 1. 5 Independent Scrim Sets (Set 1 to Set 5)
// 2. Serpentine Ban Order: A -> B -> B -> A -> A -> B (Turns 1, 4, 5 for Team A; 2, 3, 6 for Team B)
// 3. Flagships CANNOT be banned under Alliance Tournament rules.
// 4. Duplicate bans prohibited per set.
// ============================================================================

// Tactical Toast Notification Helper
let toastTimeout = null;
function showTacticalToast(message, type = 'info') {
  const toast = document.getElementById('tactical-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `tactical-toast ${type}`;
  toast.classList.remove('hidden');

  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.add('hidden');
  }, 3500);
}

// Factory function for an independent Scrim Set
function createDefaultSet(setNum) {
  return {
    setNumber: setNum,
    status: 'IDLE', // 'IDLE' | 'ACTIVE' | 'COMPLETE'
    currentTurnIndex: 0,
    turnSecondsRemaining: 30,
    bans: {
      TEAM_A: [null, null, null],
      TEAM_B: [null, null, null],
    },
    flagships: {
      TEAM_A: null, // Designated Battleship
      TEAM_B: null,
    },
    timer: {
      phase: 'STANDBY',
      warmupMsRemaining: 60000,
      matchMsRemaining: TOTAL_MATCH_MS,
      resignedMessage: '',
      resignedTime: '',
    },
    comp: {
      TEAM_A: Array(10).fill(null),
      TEAM_B: Array(10).fill(null),
    }
  };
}

// 5 Scrim Sets State
let activeSetIndex = 0; // 0 to 4 (Set 1 to Set 5)
const scrimSets = [
  createDefaultSet(1),
  createDefaultSet(2),
  createDefaultSet(3),
  createDefaultSet(4),
  createDefaultSet(5),
];

function getActiveSet() {
  return scrimSets[activeSetIndex];
}

// Official Serpentine Ban Order: A -> B -> B -> A -> A -> B
// Official Serpentine Ban Order alternating per Scrim Set:
// Set 1, 3, 5: A -> B -> B -> A -> A -> B (Team A First Ban)
// Set 2, 4:    B -> A -> A -> B -> B -> A (Team B First Ban)
function getBanSequenceForSet(setIndex) {
  const isTeamAFirst = (setIndex % 2 === 0);
  const first = isTeamAFirst ? 'TEAM_A' : 'TEAM_B';
  const second = isTeamAFirst ? 'TEAM_B' : 'TEAM_A';

  return [
    { turn: 1, team: first, slot: 0, label: `TURN 1: ${first === 'TEAM_A' ? 'TEAM A' : 'TEAM B'} BAN 1` },
    { turn: 2, team: second, slot: 0, label: `TURN 2: ${second === 'TEAM_A' ? 'TEAM A' : 'TEAM B'} BAN 1` },
    { turn: 3, team: second, slot: 1, label: `TURN 3: ${second === 'TEAM_A' ? 'TEAM A' : 'TEAM B'} BAN 2` },
    { turn: 4, team: first, slot: 1, label: `TURN 4: ${first === 'TEAM_A' ? 'TEAM A' : 'TEAM B'} BAN 2` },
    { turn: 5, team: first, slot: 2, label: `TURN 5: ${first === 'TEAM_A' ? 'TEAM A' : 'TEAM B'} BAN 3` },
    { turn: 6, team: second, slot: 2, label: `TURN 6: ${second === 'TEAM_A' ? 'TEAM A' : 'TEAM B'} BAN 3` },
  ];
}

let banTimerInterval = null;

function isShipBanned(shipId, set = getActiveSet()) {
  for (let i = 0; i < 3; i++) {
    if (set.bans.TEAM_A[i]?.id === shipId) return { banned: true, team: 'TEAM_A', slot: i };
    if (set.bans.TEAM_B[i]?.id === shipId) return { banned: true, team: 'TEAM_B', slot: i };
  }
  return { banned: false };
}

function isShipFlagship(shipId, set = getActiveSet()) {
  if (set.flagships.TEAM_A?.id === shipId) return { isFlagship: true, team: 'TEAM_A' };
  if (set.flagships.TEAM_B?.id === shipId) return { isFlagship: true, team: 'TEAM_B' };
  return { isFlagship: false };
}

function broadcastSetsState() {
  syncChannel?.postMessage({
    type: 'SYNC_SETS_STATE',
    payload: { activeSetIndex, scrimSets }
  });
}

function updateBanUI() {
  const currentSet = getActiveSet();
  const panelA = document.getElementById('panel-team-a');
  const panelB = document.getElementById('panel-team-b');
  const phaseTitle = document.getElementById('ban-phase-title');
  const turnStatus = document.getElementById('ban-turn-status');
  const turnTimer = document.getElementById('ban-timer-display');
  const startBtn = document.getElementById('btn-start-bans');

  const banSequence = getBanSequenceForSet(activeSetIndex);
  const isTeamAFirst = (activeSetIndex % 2 === 0);

  // Update Phase Title with Current Set & Alternating Order
  if (phaseTitle) {
    const orderStr = isTeamAFirst ? 'A B B A A B' : 'B A A B B A';
    const firstTeamName = isTeamAFirst ? teamState.teamA.name : teamState.teamB.name;
    phaseTitle.textContent = `BAN ORDER (${orderStr}) • SET ${activeSetIndex + 1} (${firstTeamName} FIRST)`;
  }

  // Update Role Pills (First Ban vs Counter Ban)
  const pillA = document.getElementById('team-a-role-pill');
  const pillB = document.getElementById('team-b-role-pill');
  if (pillA) pillA.textContent = isTeamAFirst ? 'FIRST BAN (TURNS 1, 4, 5)' : 'COUNTER BAN (TURNS 2, 3, 6)';
  if (pillB) pillB.textContent = isTeamAFirst ? 'COUNTER BAN (TURNS 2, 3, 6)' : 'FIRST BAN (TURNS 1, 4, 5)';

  // Update Container Header Labels
  const labelA = document.getElementById('team-a-slots-label');
  const labelB = document.getElementById('team-b-slots-label');
  if (labelA) labelA.textContent = isTeamAFirst ? 'BANNED SHIPS (TURNS 1, 4, 5)' : 'BANNED SHIPS (TURNS 2, 3, 6)';
  if (labelB) labelB.textContent = isTeamAFirst ? 'BANNED SHIPS (TURNS 2, 3, 6)' : 'BANNED SHIPS (TURNS 1, 4, 5)';

  // Update Set Buttons (Active highlight + status dots)
  document.querySelectorAll('.set-btn').forEach((btn, idx) => {
    const isActive = idx === activeSetIndex;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');

    const dot = document.getElementById(`set-dot-${idx + 1}`);
    if (dot) {
      dot.className = 'set-dot';
      if (scrimSets[idx].status === 'ACTIVE') dot.classList.add('active-banning');
      else if (scrimSets[idx].status === 'COMPLETE') dot.classList.add('complete');
    }
  });

  // Turn status and active highlights
  if (currentSet.status === 'ACTIVE') {
    const cur = banSequence[currentSet.currentTurnIndex];
    if (cur) {
      if (turnStatus) {
        const teamName = cur.team === 'TEAM_A' ? teamState.teamA.name : teamState.teamB.name;
        turnStatus.textContent = `SET ${currentSet.setNumber} • TURN ${cur.turn}/6 • ${teamName} BANNING`;
        turnStatus.style.color = 'var(--accent-gold)';
      }
      if (panelA) panelA.classList.toggle('active-turn', cur.team === 'TEAM_A');
      if (panelB) panelB.classList.toggle('active-turn', cur.team === 'TEAM_B');
    }
    if (startBtn) startBtn.textContent = 'BANNING...';
  } else if (currentSet.status === 'COMPLETE') {
    if (turnStatus) {
      turnStatus.textContent = `SET ${currentSet.setNumber} BANS COMPLETE (3 / 3 EACH)`;
      turnStatus.style.color = 'var(--accent-emerald)';
    }
    if (panelA) panelA.classList.remove('active-turn');
    if (panelB) panelB.classList.remove('active-turn');
    if (startBtn) startBtn.textContent = 'BANS LOCKED';
  } else {
    if (turnStatus) {
      const firstTeamName = isTeamAFirst ? teamState.teamA.name : teamState.teamB.name;
      turnStatus.textContent = `SET ${currentSet.setNumber} • READY TO START BANS (${firstTeamName} FIRST)`;
      turnStatus.style.color = 'var(--accent-gold)';
    }
    if (panelA) panelA.classList.remove('active-turn');
    if (panelB) panelB.classList.remove('active-turn');
    if (startBtn) startBtn.textContent = 'START BANS';
  }

  // Turn Timer
  if (turnTimer) {
    turnTimer.textContent = `00:${String(currentSet.turnSecondsRemaining).padStart(2, '0')}`;
  }

  // Dynamic Slot Labels based on Set Alternating Order
  const slotLabelsA = isTeamAFirst
    ? ['TURN 1 (BAN 1)', 'TURN 4 (BAN 2)', 'TURN 5 (BAN 3)']
    : ['TURN 2 (BAN 1)', 'TURN 3 (BAN 2)', 'TURN 6 (BAN 3)'];

  const slotLabelsB = isTeamAFirst
    ? ['TURN 2 (BAN 1)', 'TURN 3 (BAN 2)', 'TURN 6 (BAN 3)']
    : ['TURN 1 (BAN 1)', 'TURN 4 (BAN 2)', 'TURN 5 (BAN 3)'];

  // Update Team A Ban Slots for Current Set
  const slotsA = document.querySelectorAll('#team-a-bans .ban-slot');
  slotsA.forEach((slotEl, idx) => {
    const bannedShip = currentSet.bans.TEAM_A[idx];
    if (bannedShip) {
      slotEl.className = 'ban-slot filled';
      slotEl.innerHTML = `
        <img src="${bannedShip.renderUrl}" alt="${bannedShip.name}" class="ban-slot-img" onerror="this.src='${bannedShip.iconUrl}'" />
        <div class="ban-slot-text">
          <span class="slot-idx">${slotLabelsA[idx]}</span>
          <span class="ship-name">${bannedShip.name}</span>
          <div class="ban-slot-details">
            <span>${bannedShip.hullSize}</span>
            <span class="ban-slot-pts">${bannedShip.points} Pts</span>
          </div>
        </div>
      `;
    } else {
      slotEl.className = 'ban-slot empty';
      slotEl.innerHTML = `<span class="slot-idx">${slotLabelsA[idx]}</span><span class="ship-name">—</span>`;
    }
  });

  // Update Team B Ban Slots for Current Set
  const slotsB = document.querySelectorAll('#team-b-bans .ban-slot');
  slotsB.forEach((slotEl, idx) => {
    const bannedShip = currentSet.bans.TEAM_B[idx];
    if (bannedShip) {
      slotEl.className = 'ban-slot filled';
      slotEl.innerHTML = `
        <img src="${bannedShip.renderUrl}" alt="${bannedShip.name}" class="ban-slot-img" onerror="this.src='${bannedShip.iconUrl}'" />
        <div class="ban-slot-text">
          <span class="slot-idx">${slotLabelsB[idx]}</span>
          <span class="ship-name">${bannedShip.name}</span>
          <div class="ban-slot-details">
            <span>${bannedShip.hullSize}</span>
            <span class="ban-slot-pts">${bannedShip.points} Pts</span>
          </div>
        </div>
      `;
    } else {
      slotEl.className = 'ban-slot empty';
      slotEl.innerHTML = `<span class="slot-idx">${slotLabelsB[idx]}</span><span class="ship-name">—</span>`;
    }
  });

  // Update Flagship Indicators for Current Set
  const nameA = document.getElementById('team-a-flagship-name');
  const btnA = document.getElementById('btn-flagship-team-a');
  if (nameA && btnA) {
    if (currentSet.flagships.TEAM_A) {
      nameA.textContent = currentSet.flagships.TEAM_A.name.toUpperCase();
      btnA.classList.add('has-flagship');
    } else {
      nameA.textContent = 'NONE DESIGNATED';
      btnA.classList.remove('has-flagship');
    }
  }

  const nameB = document.getElementById('team-b-flagship-name');
  const btnB = document.getElementById('btn-flagship-team-b');
  if (nameB && btnB) {
    if (currentSet.flagships.TEAM_B) {
      nameB.textContent = currentSet.flagships.TEAM_B.name.toUpperCase();
      btnB.classList.add('has-flagship');
    } else {
      nameB.textContent = 'NONE DESIGNATED';
      btnB.classList.remove('has-flagship');
    }
  }

  // Update Role Indicator Bar on Bans View
  const roleBadge = document.getElementById('bans-my-role-badge');
  const roleHint = document.getElementById('bans-role-turn-hint');
  if (roleBadge) {
    roleBadge.textContent = getRoleBadgeText(currentUserRole);
  }
  if (roleHint) {
    if (currentSet.status === 'ACTIVE') {
      const cur = banSequence[currentSet.currentTurnIndex];
      if (cur) {
        if (currentUserRole === 'REFEREE') {
          const turnTeamName = cur.team === 'TEAM_A' ? teamState.teamA.name : teamState.teamB.name;
          roleHint.textContent = `🛡️ Admin Mode: Drafting for ${turnTeamName} (Turn ${currentSet.currentTurnIndex + 1}/6)`;
          roleHint.style.color = 'var(--accent-gold)';
        } else if (currentUserRole === 'TEAM_A') {
          if (cur.team === 'TEAM_A') {
            roleHint.textContent = '✨ YOUR TURN TO BAN! Select an eligible ship from the pool below.';
            roleHint.style.color = 'var(--accent-cyan)';
          } else {
            roleHint.textContent = `⏳ WAITING ON OPPONENT: ${teamState.teamB.name} Captain is picking ban #${cur.slot + 1}.`;
            roleHint.style.color = 'var(--text-muted)';
          }
        } else if (currentUserRole === 'TEAM_B') {
          if (cur.team === 'TEAM_B') {
            roleHint.textContent = '✨ YOUR TURN TO BAN! Select an eligible ship from the pool below.';
            roleHint.style.color = 'var(--accent-gold)';
          } else {
            roleHint.textContent = `⏳ WAITING ON OPPONENT: ${teamState.teamA.name} Captain is picking ban #${cur.slot + 1}.`;
            roleHint.style.color = 'var(--text-muted)';
          }
        } else {
          const turnTeamName = cur.team === 'TEAM_A' ? teamState.teamA.name : teamState.teamB.name;
          roleHint.textContent = `👁️ Watching Live Draft: ${turnTeamName}'s Turn`;
          roleHint.style.color = 'var(--text-muted)';
        }
      }
    } else if (currentSet.status === 'COMPLETE') {
      roleHint.textContent = `🎉 All 6 bans locked for Set ${currentSet.setNumber}. Comp slots & match timer ready.`;
      roleHint.style.color = 'var(--accent-emerald)';
    } else {
      if (currentUserRole === 'SPECTATOR') {
        roleHint.textContent = '👁️ Spectator Mode: Live drafting is read-only.';
        roleHint.style.color = 'var(--text-muted)';
      } else {
        const firstTeamName = isTeamAFirst ? teamState.teamA.name : teamState.teamB.name;
        roleHint.textContent = `Ready to draft. Click "START BANS" when ready (${firstTeamName} picks first).`;
        roleHint.style.color = 'var(--text-secondary)';
      }
    }
  }

  // Update Match Bans & Flagship display on the Timer page
  renderTimerMatchBans();
}

function switchActiveSet(setIndex) {
  if (setIndex < 0 || setIndex >= scrimSets.length) return;

  // Save current set's timer state before switching
  if (scrimSets[activeSetIndex] && scrimSets[activeSetIndex].timer) {
    Object.assign(scrimSets[activeSetIndex].timer, timerState);
  }

  activeSetIndex = setIndex;

  if (banTimerInterval) {
    clearInterval(banTimerInterval);
    banTimerInterval = null;
  }

  // Load new set's timer state
  const curSet = getActiveSet();
  if (curSet && curSet.timer) {
    Object.assign(timerState, curSet.timer);
  }

  // If new set was already active in bans, restart ban interval
  if (curSet.status === 'ACTIVE') {
    startBanTimerInterval();
  }

  updateBanUI();
  renderShipPool();
  updateTimerDisplays();
  updateTimerSetsNavBadges();
  renderRefereeSlots('TEAM_A');
  renderRefereeSlots('TEAM_B');
  broadcastSetsState();
  broadcastState();

  const isTeamAFirst = (activeSetIndex % 2 === 0);
  const firstTeamName = isTeamAFirst ? teamState.teamA.name : teamState.teamB.name;
  showTacticalToast(`Switched to Match / Scrim Set ${activeSetIndex + 1} (${firstTeamName} First Ban)`, 'info');
}

// ============================================================================
// REFEREE FLEET MARSHALLING (10-SLOT COMP ENTRY & 200 PTS CEILING)
// ============================================================================

// Render Unified Match Bans & Flagship Display on the Timer Page
function renderTimerMatchBans() {
  const currentSet = getActiveSet();
  if (!currentSet) return;

  // 1. Center card headers & labels
  const matchTitleEl = document.getElementById('center-bans-match-title');
  if (matchTitleEl) matchTitleEl.textContent = `MATCH ${currentSet.setNumber} BANS & FLAGSHIPS`;

  const teamNameAEl = document.getElementById('center-bans-team-a-name');
  if (teamNameAEl) teamNameAEl.textContent = teamState.teamA.name.toUpperCase();

  const teamNameBEl = document.getElementById('center-bans-team-b-name');
  if (teamNameBEl) teamNameBEl.textContent = teamState.teamB.name.toUpperCase();

  const orderBadgeEl = document.getElementById('center-bans-order-badge');
  if (orderBadgeEl) {
    const isTeamAFirst = (activeSetIndex % 2 === 0);
    orderBadgeEl.textContent = isTeamAFirst ? 'A B B A A B' : 'B A A B B A';
  }

  // 2. Team A Flagship
  const fsA = currentSet.flagships.TEAM_A;
  const fsNameA = document.getElementById('ref-flagship-name-a');
  const fsPillA = document.getElementById('ref-flagship-pill-a');
  if (fsNameA && fsPillA) {
    if (fsA) {
      fsNameA.textContent = fsA.name.toUpperCase();
      fsPillA.classList.add('has-flagship');
      fsPillA.title = `Team A Flagship: ${fsA.name} (${fsA.points} Pts) • Immune to Bans. Click to change.`;
    } else {
      fsNameA.textContent = 'NO FLAGSHIP';
      fsPillA.classList.remove('has-flagship');
      fsPillA.title = 'Click to designate Team A Flagship (Immune to Bans)';
    }
  }

  // 3. Team B Flagship
  const fsB = currentSet.flagships.TEAM_B;
  const fsNameB = document.getElementById('ref-flagship-name-b');
  const fsPillB = document.getElementById('ref-flagship-pill-b');
  if (fsNameB && fsPillB) {
    if (fsB) {
      fsNameB.textContent = fsB.name.toUpperCase();
      fsPillB.classList.add('has-flagship');
      fsPillB.title = `Team B Flagship: ${fsB.name} (${fsB.points} Pts) • Immune to Bans. Click to change.`;
    } else {
      fsNameB.textContent = 'NO FLAGSHIP';
      fsPillB.classList.remove('has-flagship');
      fsPillB.title = 'Click to designate Team B Flagship (Immune to Bans)';
    }
  }

  // 4. Populate Team A 3 Ban Chips
  const chipsContainerA = document.getElementById('ref-bans-chips-a');
  if (chipsContainerA) {
    chipsContainerA.innerHTML = '';
    currentSet.bans.TEAM_A.forEach((ship, idx) => {
      const chip = document.createElement('div');
      if (ship) {
        chip.className = 'ref-ban-chip team-a';
        chip.title = `${teamState.teamA.name} Ban ${idx + 1}: ${ship.name} (${ship.points}p • ${ship.hullSize})`;
        chip.innerHTML = `
          <img class="ref-ban-chip-thumb" src="${ship.iconUrl || ship.renderUrl}" alt="${ship.name}" onerror="this.src='${EMPTY_SLOT_ICON}'" />
          <span class="ref-ban-chip-name">${ship.name}</span>
          <span class="ref-ban-chip-pts">${ship.points}p</span>
        `;
      } else {
        chip.className = 'ref-ban-chip empty team-a';
        chip.title = `${teamState.teamA.name} Ban ${idx + 1} not selected`;
        chip.innerHTML = `<span class="ref-ban-chip-name" style="opacity:0.5;font-size:9.5px;">Ban ${idx + 1}: —</span>`;
      }
      chipsContainerA.appendChild(chip);
    });
  }

  // 5. Populate Team B 3 Ban Chips
  const chipsContainerB = document.getElementById('ref-bans-chips-b');
  if (chipsContainerB) {
    chipsContainerB.innerHTML = '';
    currentSet.bans.TEAM_B.forEach((ship, idx) => {
      const chip = document.createElement('div');
      if (ship) {
        chip.className = 'ref-ban-chip team-b';
        chip.title = `${teamState.teamB.name} Ban ${idx + 1}: ${ship.name} (${ship.points}p • ${ship.hullSize})`;
        chip.innerHTML = `
          <img class="ref-ban-chip-thumb" src="${ship.iconUrl || ship.renderUrl}" alt="${ship.name}" onerror="this.src='${EMPTY_SLOT_ICON}'" />
          <span class="ref-ban-chip-name">${ship.name}</span>
          <span class="ref-ban-chip-pts">${ship.points}p</span>
        `;
      } else {
        chip.className = 'ref-ban-chip empty team-b';
        chip.title = `${teamState.teamB.name} Ban ${idx + 1} not selected`;
        chip.innerHTML = `<span class="ref-ban-chip-name" style="opacity:0.5;font-size:9.5px;">Ban ${idx + 1}: —</span>`;
      }
      chipsContainerB.appendChild(chip);
    });
  }
}

function populateShipsDatalist() {
  const datalist = document.getElementById('tournament-ships-datalist');
  if (!datalist) return;
  datalist.innerHTML = '';
  const currentSet = getActiveSet();

  TOURNAMENT_SHIP_POOL.forEach(ship => {
    const opt = document.createElement('option');
    opt.value = ship.name;
    const banCheck = currentSet ? isShipBanned(ship.id, currentSet) : { banned: false };
    const isFsA = currentSet?.flagships.TEAM_A?.id === ship.id;
    const isFsB = currentSet?.flagships.TEAM_B?.id === ship.id;

    let prefix = '';
    if (banCheck.banned) {
      prefix = (isFsA || isFsB) ? '⚓ [IMMUNE FLAGSHIP] ' : '🚫 [BANNED] ';
    } else if (isFsA || isFsB) {
      prefix = '⚓ [FLAGSHIP] ';
    }

    opt.label = `${prefix}${ship.points} Pts • ${ship.hullSize} (${ship.class})`;
    datalist.appendChild(opt);
  });
}

const EMPTY_SLOT_ICON = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='22' height='22' fill='none'><rect width='22' height='22' rx='2' fill='rgba(255,255,255,0.04)' stroke='rgba(255,255,255,0.1)'/></svg>";

function renderRefereeSlots(team) {
  const container = document.getElementById(team === 'TEAM_A' ? 'ref-slots-team-a' : 'ref-slots-team-b');
  if (!container) return;

  const isAuthorized = (
    currentUserRole === 'REFEREE' ||
    (currentUserRole === 'TEAM_A' && team === 'TEAM_A') ||
    (currentUserRole === 'TEAM_B' && team === 'TEAM_B')
  );

  const currentSet = getActiveSet();
  if (!currentSet.comp) {
    currentSet.comp = { TEAM_A: Array(10).fill(null), TEAM_B: Array(10).fill(null) };
  }

  container.innerHTML = '';

  for (let i = 0; i < 10; i++) {
    // Audit existing slot: auto-purge banned non-flagships
    let ship = currentSet.comp[team][i];
    if (ship) {
      const banCheck = isShipBanned(ship.id, currentSet);
      const isTeamFlagship = currentSet.flagships[team]?.id === ship.id;
      if (banCheck.banned && !isTeamFlagship) {
        currentSet.comp[team][i] = null;
        ship = null;
      }
    }

    const row = document.createElement('div');
    row.className = 'ref-slot-row';
    row.dataset.slot = i;
    row.dataset.team = team;

    const thumbSrc = ship ? (ship.iconUrl || ship.renderUrl) : EMPTY_SLOT_ICON;
    const ptsText = ship ? `${ship.points}p` : '-';
    const valText = ship ? ship.name : '';

    const disabledAttr = !isAuthorized ? 'disabled' : '';
    const titleAttr = !isAuthorized ? `title="Only ${team === 'TEAM_A' ? teamState.teamA.name : teamState.teamB.name} Captain or Referee can edit this slot."` : '';

    row.innerHTML = `
      <span class="ref-slot-idx">#${String(i + 1).padStart(2, '0')}</span>
      <img class="ref-ship-thumb" src="${thumbSrc}" alt="${ship ? ship.name : 'Empty'}" onerror="this.src='${EMPTY_SLOT_ICON}'" />
      <input type="text" class="ref-ship-input" list="tournament-ships-datalist" placeholder="Slot ${i + 1} Hull..." value="${valText}" data-slot="${i}" data-team="${team}" autocomplete="off" ${disabledAttr} ${titleAttr} />
      <span class="ref-ship-pts" id="ref-pts-${team}-${i}">${ptsText}</span>
      <button type="button" class="ref-slot-clear" data-slot="${i}" data-team="${team}" title="${isAuthorized ? 'Clear slot' : 'Unauthorized'}" ${disabledAttr}>✕</button>
    `;

    const inputEl = row.querySelector('.ref-ship-input');
    const clearBtn = row.querySelector('.ref-slot-clear');
    const thumbEl = row.querySelector('.ref-ship-thumb');
    const ptsEl = row.querySelector('.ref-ship-pts');

    const handleInput = () => {
      if (!isAuthorized) {
        showTacticalToast(`⛔ Permission Denied: You cannot edit ${team === 'TEAM_A' ? teamState.teamA.name : teamState.teamB.name}'s fleet composition.`, 'danger');
        return;
      }
      const q = inputEl.value.trim().toLowerCase();
      const matched = TOURNAMENT_SHIP_POOL.find(s => s.name.toLowerCase() === q);
      if (matched) {
        // Enforce AT XXII Rule: Disallow banned non-flagships from being selected
        const banCheck = isShipBanned(matched.id, currentSet);
        const isTeamFlagship = currentSet.flagships[team]?.id === matched.id;

        if (banCheck.banned && !isTeamFlagship) {
          // Disallow!
          currentSet.comp[team][i] = null;
          inputEl.value = '';
          thumbEl.src = EMPTY_SLOT_ICON;
          ptsEl.textContent = '-';

          // Trigger red error shake on slot
          row.classList.remove('slot-banned-error');
          void row.offsetWidth;
          row.classList.add('slot-banned-error');
          setTimeout(() => row.classList.remove('slot-banned-error'), 600);

          showTacticalToast(`⛔ ${matched.name} is BANNED in Set ${currentSet.setNumber}! Non-flagship banned ships cannot be selected.`, 'danger');
          updateRefereeCompHeader(team);
          if (networkManager.session) {
            networkManager.sendComp(team, i, null);
          } else {
            broadcastSetsState();
          }
          return;
        }

        currentSet.comp[team][i] = matched;
        thumbEl.src = matched.iconUrl || matched.renderUrl;
        ptsEl.textContent = `${matched.points}p`;
      } else {
        currentSet.comp[team][i] = null;
        thumbEl.src = EMPTY_SLOT_ICON;
        ptsEl.textContent = '-';
      }
      updateRefereeCompHeader(team);
      if (networkManager.session) {
        networkManager.sendComp(team, i, matched || null);
      } else {
        broadcastSetsState();
      }
    };

    inputEl.addEventListener('input', handleInput);
    inputEl.addEventListener('change', handleInput);

    clearBtn.addEventListener('click', () => {
      if (!isAuthorized) {
        showTacticalToast(`⛔ Permission Denied: You cannot clear ${team === 'TEAM_A' ? teamState.teamA.name : teamState.teamB.name}'s slot.`, 'danger');
        return;
      }
      currentSet.comp[team][i] = null;
      inputEl.value = '';
      thumbEl.src = EMPTY_SLOT_ICON;
      ptsEl.textContent = '-';
      updateRefereeCompHeader(team);
      if (networkManager.session) {
        networkManager.sendComp(team, i, null);
      } else {
        broadcastSetsState();
      }
    });

    container.appendChild(row);
  }

  updateRefereeCompHeader(team);
}

function updateRefereeCompHeader(team) {
  const currentSet = getActiveSet();
  if (!currentSet.comp) return;

  const comp = currentSet.comp[team];
  const totalPts = comp.reduce((sum, s) => sum + (s ? s.points : 0), 0);
  const filledCount = comp.filter(Boolean).length;

  const prefix = team === 'TEAM_A' ? 'team-a' : 'team-b';
  const ptsEl = document.getElementById(`ref-${prefix}-total-pts`);
  const badgeEl = document.getElementById(`ref-${prefix}-points-badge`);
  const countEl = document.getElementById(`ref-${prefix}-ship-count`);

  if (ptsEl) ptsEl.textContent = totalPts;
  if (countEl) countEl.textContent = `${filledCount} / 10 Hulls`;

  if (badgeEl) {
    if (totalPts > 200) {
      badgeEl.classList.remove('valid');
      badgeEl.classList.add('over-limit');
    } else {
      badgeEl.classList.remove('over-limit');
      badgeEl.classList.add('valid');
    }
  }

  const isAuthorized = (
    currentUserRole === 'REFEREE' ||
    (currentUserRole === 'TEAM_A' && team === 'TEAM_A') ||
    (currentUserRole === 'TEAM_B' && team === 'TEAM_B')
  );
  const clearCompBtn = document.getElementById(team === 'TEAM_A' ? 'btn-clear-comp-a' : 'btn-clear-comp-b');
  if (clearCompBtn) {
    clearCompBtn.disabled = !isAuthorized;
    if (!isAuthorized) {
      clearCompBtn.title = `Only ${team === 'TEAM_A' ? teamState.teamA.name : teamState.teamB.name} Captain or Referee can clear this comp.`;
    } else {
      clearCompBtn.removeAttribute('title');
    }
  }
}

function clearTeamRefereeComp(team) {
  const isAuthorized = (
    currentUserRole === 'REFEREE' ||
    (currentUserRole === 'TEAM_A' && team === 'TEAM_A') ||
    (currentUserRole === 'TEAM_B' && team === 'TEAM_B')
  );
  if (!isAuthorized) {
    showTacticalToast(`⛔ Permission Denied: You cannot clear ${team === 'TEAM_A' ? teamState.teamA.name : teamState.teamB.name}'s fleet composition.`, 'danger');
    return;
  }
  const currentSet = getActiveSet();
  if (currentSet.comp) {
    currentSet.comp[team] = Array(10).fill(null);
    renderRefereeSlots(team);
    const teamName = team === 'TEAM_A' ? teamState.teamA.name : teamState.teamB.name;
    showTacticalToast(`Cleared ${teamName} referee fleet composition for Set ${currentSet.setNumber}.`, 'info');
    if (networkManager.session) {
      networkManager.sendClearComp(team);
    } else {
      broadcastSetsState();
    }
  }
}

function updateTimerSetsNavBadges() {
  document.querySelectorAll('.timer-set-btn').forEach((btn, idx) => {
    const isActive = idx === activeSetIndex;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');

    const badge = document.getElementById(`timer-set-badge-${idx + 1}`);
    if (badge && scrimSets[idx]) {
      const setTimer = scrimSets[idx].timer || {};
      badge.className = 't-set-badge';
      if (setTimer.phase === 'MATCH' || setTimer.phase === 'WARMUP') {
        badge.textContent = setTimer.phase === 'WARMUP' ? 'WARMUP' : 'RUNNING';
        badge.classList.add('active-run');
      } else if (setTimer.phase === 'MATCH OVER' || setTimer.phase === 'RESIGNED') {
        badge.textContent = 'FINISHED';
        badge.classList.add('finished');
      } else {
        badge.textContent = 'STANDBY';
      }
    }
  });

  const activeTitle = document.getElementById('active-match-title');
  if (activeTitle) {
    activeTitle.textContent = `MATCH ${activeSetIndex + 1} • SET ${activeSetIndex + 1} OF 5`;
  }
}

function startBanTimerInterval() {
  if (banTimerInterval) clearInterval(banTimerInterval);
  banTimerInterval = setInterval(() => {
    const curSet = getActiveSet();
    if (curSet.status !== 'ACTIVE') {
      clearInterval(banTimerInterval);
      banTimerInterval = null;
      return;
    }
    curSet.turnSecondsRemaining--;
    if (curSet.turnSecondsRemaining <= 0) {
      curSet.turnSecondsRemaining = 0;
      const banSeq = getBanSequenceForSet(curSet.setNumber - 1);
      const cur = banSeq[curSet.currentTurnIndex];
      const teamName = cur.team === 'TEAM_A' ? teamState.teamA.name : teamState.teamB.name;
      showTacticalToast(`⏱️ Turn time expired for ${teamName} (Set ${curSet.setNumber})!`, 'warning');
    }
    updateBanUI();
    broadcastSetsState();
  }, 1000);
}

function startBanPhase() {
  if (currentUserRole === 'SPECTATOR') {
    showTacticalToast('👁️ Spectator Mode: Live session is read-only. Drafting cannot be started.', 'warning');
    return;
  }
  const currentSet = getActiveSet();
  if (currentSet.status === 'COMPLETE') {
    resetCurrentSet();
  }
  currentSet.status = 'ACTIVE';
  currentSet.turnSecondsRemaining = 30;

  const isAFirst = (currentSet.setNumber % 2 !== 0);
  const orderText = isAFirst ? 'A → B → B → A → A → B' : 'B → A → A → B → B → A';
  const firstTeam = isAFirst ? teamState.teamA.name : teamState.teamB.name;

  startBanTimerInterval();
  updateBanUI();
  renderShipPool();
  broadcastSetsState();
  showTacticalToast(`🎯 Set ${currentSet.setNumber}: Serpentine Ban Phase Started (${orderText}) • ${firstTeam} First Ban`, 'info');
}

function resetCurrentSet() {
  if (currentUserRole !== 'REFEREE') {
    showTacticalToast('⛔ Permission Denied: Only Tournament Referees can reset bans.', 'danger');
    return;
  }
  if (banTimerInterval) clearInterval(banTimerInterval);
  banTimerInterval = null;
  const currentSet = getActiveSet();
  currentSet.status = 'IDLE';
  currentSet.currentTurnIndex = 0;
  currentSet.turnSecondsRemaining = 30;
  currentSet.bans.TEAM_A = [null, null, null];
  currentSet.bans.TEAM_B = [null, null, null];
  updateBanUI();
  renderShipPool();
  broadcastSetsState();
  showTacticalToast(`Set ${currentSet.setNumber} bans reset to default standby state.`, 'info');
}

function resetAllSets() {
  if (currentUserRole !== 'REFEREE') {
    showTacticalToast('⛔ Permission Denied: Only Tournament Referees can reset all sets.', 'danger');
    return;
  }
  if (banTimerInterval) clearInterval(banTimerInterval);
  banTimerInterval = null;
  scrimSets.forEach((s, idx) => {
    scrimSets[idx] = createDefaultSet(idx + 1);
  });
  updateBanUI();
  renderShipPool();
  broadcastSetsState();
  showTacticalToast('All 5 scrim sets reset to default standby.', 'info');
}

function handleShipClick(ship) {
  const currentSet = getActiveSet();
  if (currentSet.status !== 'ACTIVE') {
    showTacticalToast(`Click "START BANS" on Set ${currentSet.setNumber} to begin banning.`, 'info');
    return;
  }

  // Session drafting role validation
  const banSequence = getBanSequenceForSet(currentSet.setNumber - 1);
  const cur = banSequence[currentSet.currentTurnIndex];
  if (!cur) return;

  if (currentUserRole === 'SPECTATOR') {
    showTacticalToast('👁️ Spectator Mode: Live session is read-only. Drafting is disabled.', 'warning');
    return;
  }

  if (currentUserRole === 'TEAM_A' && cur.team !== 'TEAM_A') {
    showTacticalToast(`⛔ Permission Denied: You are signed in as ${teamState.teamA.name} Captain. It is ${teamState.teamB.name}'s turn to ban!`, 'danger');
    return;
  }

  if (currentUserRole === 'TEAM_B' && cur.team !== 'TEAM_B') {
    showTacticalToast(`⛔ Permission Denied: You are signed in as ${teamState.teamB.name} Captain. It is ${teamState.teamA.name}'s turn to ban!`, 'danger');
    return;
  }

  // RULE: Flagships CANNOT be banned
  const fsInfo = isShipFlagship(ship.id, currentSet);
  if (fsInfo.isFlagship) {
    showTacticalToast(`⛔ FLAGSHIP IMMUNITY: ${ship.name} is designated as ${fsInfo.team === 'TEAM_A' ? teamState.teamA.name : teamState.teamB.name} Flagship in Set ${currentSet.setNumber} and CANNOT be banned under Alliance Tournament rules.`, 'warning');
    return;
  }

  // RULE: Duplicate bans prohibited in current set
  const banInfo = isShipBanned(ship.id, currentSet);
  if (banInfo.banned) {
    showTacticalToast(`⚠️ ALREADY BANNED: ${ship.name} has already been banned by ${banInfo.team === 'TEAM_A' ? teamState.teamA.name : teamState.teamB.name} in Set ${currentSet.setNumber}.`, 'warning');
    return;
  }

  // Season rules modular validation
  const designatedFlagshipIds = [currentSet.flagships.TEAM_A?.id, currentSet.flagships.TEAM_B?.id].filter(Boolean);
  const currentBannedIds = [...currentSet.bans.TEAM_A, ...currentSet.bans.TEAM_B].filter(Boolean).map(s => s.id);
  const validation = isShipBannable(ship.id, currentBannedIds, designatedFlagshipIds);
  if (!validation.allowed) {
    showTacticalToast(`⚠️ ${validation.reason}`, 'warning');
    return;
  }

  // Execute Ban for Current Turn in Active Set (Alternating Serpentine Sequence)
  currentSet.bans[cur.team][cur.slot] = ship;
  const teamName = cur.team === 'TEAM_A' ? teamState.teamA.name : teamState.teamB.name;
  showTacticalToast(`🎯 Set ${currentSet.setNumber} [${teamName}]: Banned ${ship.name} (${ship.points} pts)!`, 'info');

  currentSet.currentTurnIndex++;
  if (currentSet.currentTurnIndex >= banSequence.length) {
    currentSet.status = 'COMPLETE';
    if (banTimerInterval) clearInterval(banTimerInterval);
    banTimerInterval = null;
    showTacticalToast(`🎉 SET ${currentSet.setNumber} BANS COMPLETE! All 6 tournament bans locked.`, 'info');
  } else {
    currentSet.turnSecondsRemaining = 30;
  }

  updateBanUI();
  renderShipPool();
  broadcastSetsState();
}

// Ship Pool Rendering & Category Filtering
let currentCategoryFilter = 'ALL';
let currentSearchQuery = '';

function renderShipPool() {
  const grid = document.getElementById('ship-pool-grid');
  const countBadge = document.getElementById('ship-pool-count');
  if (!grid) return;

  const currentSet = getActiveSet();
  const query = currentSearchQuery.toLowerCase().trim();

  const filtered = TOURNAMENT_SHIP_POOL.filter(ship => {
    // Category match
    if (currentCategoryFilter !== 'ALL') {
      if (currentCategoryFilter === 'Frigate') {
        if (ship.hullSize !== 'Frigate' && ship.hullSize !== 'Corvette') return false;
      } else if (currentCategoryFilter === 'Logistics') {
        if (ship.hullSize !== 'Logistics' && ship.hullSize !== 'Logistics Frigate') return false;
      } else {
        if (ship.hullSize !== currentCategoryFilter) return false;
      }
    }

    // Search text match (name, class, hull, points)
    if (query) {
      const matchName = ship.name.toLowerCase().includes(query);
      const matchClass = ship.class.toLowerCase().includes(query);
      const matchHull = ship.hullSize.toLowerCase().includes(query);
      const matchPts = String(ship.points) === query || `${ship.points} pts`.includes(query);
      if (!matchName && !matchClass && !matchHull && !matchPts) return false;
    }

    return true;
  });

  if (countBadge) {
    countBadge.textContent = query || currentCategoryFilter !== 'ALL' 
      ? `${filtered.length} / ${TOURNAMENT_SHIP_POOL.length} SHIPS` 
      : `${TOURNAMENT_SHIP_POOL.length} SHIPS`;
  }

  grid.innerHTML = '';

  filtered.forEach(ship => {
    const card = document.createElement('div');
    card.className = 'ship-card';
    card.dataset.id = ship.id;

    const fs = isShipFlagship(ship.id, currentSet);
    const bn = isShipBanned(ship.id, currentSet);

    if (fs.isFlagship) card.classList.add('is-flagship');
    if (bn.banned) card.classList.add('is-banned');

    let badgeHtml = '';
    if (fs.isFlagship) {
      badgeHtml = `<div class="ship-card-flagship-badge">⚓ ${fs.team === 'TEAM_A' ? 'TEAM A' : 'TEAM B'} FLAGSHIP (IMMUNE)</div>`;
    } else if (bn.banned) {
      badgeHtml = `<div class="ship-card-banned-badge">BANNED (${bn.team === 'TEAM_A' ? 'TEAM A' : 'TEAM B'})</div>`;
    }

    card.innerHTML = `
      <div class="ship-render-wrap">
        <img src="${ship.renderUrl}" alt="${ship.name}" class="ship-render-img" loading="lazy" onerror="this.src='${ship.iconUrl}'" />
      </div>
      <div class="ship-card-info">
        <div class="ship-card-header-row">
          <span class="ship-tier">${ship.hullSize.toUpperCase()}</span>
          <span class="ship-points">${ship.points} Pts</span>
        </div>
        <div class="ship-name" title="${ship.name}">${ship.name}</div>
        <div class="ship-class" title="${ship.class}">${ship.class}</div>
        ${badgeHtml}
      </div>
    `;

    card.addEventListener('click', () => handleShipClick(ship));
    grid.appendChild(card);
  });
}

// Category filter chip click handlers
document.querySelectorAll('.filter-chips .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.filter-chips .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    currentCategoryFilter = chip.dataset.filter || 'ALL';
    renderShipPool();
  });
});

// Search input listener
document.getElementById('ship-search-input')?.addEventListener('input', (e) => {
  currentSearchQuery = e.target.value;
  renderShipPool();
});

// Set Switcher Listeners (SET 1 through SET 5)
document.querySelectorAll('.set-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const setNum = parseInt(btn.dataset.set, 10);
    if (!isNaN(setNum)) {
      switchActiveSet(setNum - 1);
    }
  });
});

// Timer Set & Match Switcher Listeners (MATCH 1 through MATCH 5)
document.querySelectorAll('.timer-set-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const setNum = parseInt(btn.dataset.set, 10);
    if (!isNaN(setNum)) {
      switchActiveSet(setNum - 1);
    }
  });
});

// Referee Comp Clear Buttons
document.getElementById('btn-clear-comp-a')?.addEventListener('click', () => clearTeamRefereeComp('TEAM_A'));
document.getElementById('btn-clear-comp-b')?.addEventListener('click', () => clearTeamRefereeComp('TEAM_B'));

// Timer Overview Button (Sync Bans to Timer)
document.getElementById('btn-sync-bans-to-timer')?.addEventListener('click', openAllSetsModal);

// Ban Control Buttons
document.getElementById('btn-start-bans')?.addEventListener('click', startBanPhase);
document.getElementById('btn-reset-bans')?.addEventListener('click', resetCurrentSet);
document.getElementById('btn-reset-current-set')?.addEventListener('click', resetCurrentSet);

// Flagship Designation Modal Logic
let activeFlagshipModalTeam = null;
const flagshipModal = document.getElementById('flagship-modal');
const flagshipModalTitle = document.getElementById('flagship-modal-title');
const flagshipSearchInput = document.getElementById('flagship-search-input');
const flagshipGrid = document.getElementById('flagship-selection-grid');

function openFlagshipModal(team) {
  if (currentUserRole === 'SPECTATOR') {
    showTacticalToast('👁️ Spectator Mode: Flagship designation is disabled in read-only mode.', 'warning');
    return;
  }
  if (currentUserRole === 'TEAM_A' && team !== 'TEAM_A') {
    showTacticalToast(`⛔ Permission Denied: You are signed in as ${teamState.teamA.name} Captain and cannot designate ${teamState.teamB.name}'s Flagship.`, 'danger');
    return;
  }
  if (currentUserRole === 'TEAM_B' && team !== 'TEAM_B') {
    showTacticalToast(`⛔ Permission Denied: You are signed in as ${teamState.teamB.name} Captain and cannot designate ${teamState.teamA.name}'s Flagship.`, 'danger');
    return;
  }
  activeFlagshipModalTeam = team;
  const currentSet = getActiveSet();
  if (flagshipModalTitle) {
    const teamName = team === 'TEAM_A' ? teamState.teamA.name : teamState.teamB.name;
    flagshipModalTitle.textContent = `DESIGNATE ${teamName} FLAGSHIP (SET ${currentSet.setNumber})`;
  }
  if (flagshipSearchInput) flagshipSearchInput.value = '';
  renderFlagshipModalGrid('');
  flagshipModal?.classList.remove('hidden');
}

function closeFlagshipModal() {
  flagshipModal?.classList.add('hidden');
  activeFlagshipModalTeam = null;
}

function renderFlagshipModalGrid(search) {
  if (!flagshipGrid) return;
  const currentSet = getActiveSet();
  const eligibleBattleships = getEligibleFlagships();
  const q = search.toLowerCase().trim();
  const filtered = eligibleBattleships.filter(s => 
    !q || s.name.toLowerCase().includes(q) || s.class.toLowerCase().includes(q)
  );

  flagshipGrid.innerHTML = '';
  filtered.forEach(ship => {
    const card = document.createElement('div');
    card.className = 'flagship-card';
    const isCur = currentSet.flagships[activeFlagshipModalTeam]?.id === ship.id;
    if (isCur) card.classList.add('is-selected');

    card.innerHTML = `
      <img src="${ship.renderUrl}" alt="${ship.name}" class="flagship-card-img" loading="lazy" onerror="this.src='${ship.iconUrl}'" />
      <div class="flagship-card-info">
        <div class="f-name">${ship.name}</div>
        <div class="f-class">${ship.class}</div>
        <div class="f-pts">${ship.points} Pts ${isCur ? '• CURRENT FLAGSHIP' : ''}</div>
      </div>
    `;

    card.addEventListener('click', () => {
      if (currentUserRole === 'SPECTATOR' || (currentUserRole === 'TEAM_A' && activeFlagshipModalTeam !== 'TEAM_A') || (currentUserRole === 'TEAM_B' && activeFlagshipModalTeam !== 'TEAM_B')) {
        showTacticalToast('⛔ Permission Denied: You cannot designate this team\'s Flagship.', 'danger');
        return;
      }
      if (!isShipEligibleForFlagship(ship.id)) {
        showTacticalToast(`⛔ ${ship.name} is NOT eligible to be fielded as a flagship under AT XXII rules!`, 'danger');
        return;
      }
      if (isShipBanned(ship.id, currentSet).banned) {
        showTacticalToast(`Cannot designate ${ship.name} as flagship: already banned in Set ${currentSet.setNumber}!`, 'danger');
        return;
      }
      currentSet.flagships[activeFlagshipModalTeam] = ship;
      closeFlagshipModal();
      updateBanUI();
      renderShipPool();
      renderRefereeSlots('TEAM_A');
      renderRefereeSlots('TEAM_B');
      renderTimerMatchBans();
      broadcastSetsState();
      const teamName = activeFlagshipModalTeam === 'TEAM_A' ? teamState.teamA.name : teamState.teamB.name;
      showTacticalToast(`⚓ ${ship.name} designated as ${teamName} Flagship in Set ${currentSet.setNumber} (Immune to Bans).`, 'warning');
    });

    flagshipGrid.appendChild(card);
  });
}

document.getElementById('btn-flagship-team-a')?.addEventListener('click', () => openFlagshipModal('TEAM_A'));
document.getElementById('btn-flagship-team-b')?.addEventListener('click', () => openFlagshipModal('TEAM_B'));
document.getElementById('ref-flagship-pill-a')?.addEventListener('click', () => openFlagshipModal('TEAM_A'));
document.getElementById('ref-flagship-pill-b')?.addEventListener('click', () => openFlagshipModal('TEAM_B'));
document.getElementById('btn-close-flagship-modal')?.addEventListener('click', closeFlagshipModal);
document.getElementById('btn-clear-flagship')?.addEventListener('click', () => {
  if (activeFlagshipModalTeam) {
    if (currentUserRole === 'SPECTATOR' || (currentUserRole === 'TEAM_A' && activeFlagshipModalTeam !== 'TEAM_A') || (currentUserRole === 'TEAM_B' && activeFlagshipModalTeam !== 'TEAM_B')) {
      showTacticalToast('⛔ Permission Denied: You cannot remove this team\'s Flagship.', 'danger');
      return;
    }
    const currentSet = getActiveSet();
    currentSet.flagships[activeFlagshipModalTeam] = null;
    closeFlagshipModal();
    updateBanUI();
    renderShipPool();
    renderRefereeSlots('TEAM_A');
    renderRefereeSlots('TEAM_B');
    renderTimerMatchBans();
    broadcastSetsState();
    showTacticalToast(`Set ${currentSet.setNumber} Flagship designation removed.`, 'info');
  }
});
flagshipSearchInput?.addEventListener('input', (e) => renderFlagshipModalGrid(e.target.value));

// ============================================================================
// ALL 5 SETS OVERVIEW MODAL & SUMMARY EXPORT
// ============================================================================
const allSetsModal = document.getElementById('all-sets-modal');
const allSetsContainer = document.getElementById('all-sets-cards-container');

function openAllSetsModal() {
  renderAllSetsGrid();
  allSetsModal?.classList.remove('hidden');
}

function closeAllSetsModal() {
  allSetsModal?.classList.add('hidden');
}

function renderAllSetsGrid() {
  if (!allSetsContainer) return;
  allSetsContainer.innerHTML = '';

  scrimSets.forEach((set, idx) => {
    const card = document.createElement('div');
    card.className = 'all-sets-card';
    if (idx === activeSetIndex) card.classList.add('is-current');

    let badgeClass = 'idle';
    let badgeText = 'STANDBY';
    if (set.status === 'ACTIVE') {
      badgeClass = 'active';
      badgeText = `TURN ${set.currentTurnIndex + 1}/6`;
    } else if (set.status === 'COMPLETE') {
      badgeClass = 'complete';
      badgeText = 'COMPLETE (6/6)';
    }

    const teamABansHtml = set.bans.TEAM_A.map((s, i) => 
      s ? `<div class="all-sets-ban-item">
            <span style="display:flex;align-items:center;gap:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
              <img src="${s.iconUrl || s.renderUrl}" style="width:16px;height:16px;object-fit:contain;border-radius:2px;flex-shrink:0;" />
              ${s.name}
            </span>
            <span class="ban-slot-pts">${s.points}p</span>
          </div>`
        : `<div class="all-sets-ban-item empty"><span>Ban ${i+1}: None</span></div>`
    ).join('');

    const teamBBansHtml = set.bans.TEAM_B.map((s, i) => 
      s ? `<div class="all-sets-ban-item">
            <span style="display:flex;align-items:center;gap:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
              <img src="${s.iconUrl || s.renderUrl}" style="width:16px;height:16px;object-fit:contain;border-radius:2px;flex-shrink:0;" />
              ${s.name}
            </span>
            <span class="ban-slot-pts">${s.points}p</span>
          </div>`
        : `<div class="all-sets-ban-item empty"><span>Ban ${i+1}: None</span></div>`
    ).join('');

    const fsA = set.flagships.TEAM_A ? `⚓ ${set.flagships.TEAM_A.name}` : 'None';
    const fsB = set.flagships.TEAM_B ? `⚓ ${set.flagships.TEAM_B.name}` : 'None';

    card.innerHTML = `
      <div class="all-sets-card-header">
        <span class="all-sets-card-title">SET ${set.setNumber}</span>
        <span class="all-sets-status-badge ${badgeClass}">${badgeText}</span>
      </div>
      <div class="all-sets-team-block">
        <span class="all-sets-team-title team-a">${teamState.teamA.name} (FS: ${fsA})</span>
        ${teamABansHtml}
      </div>
      <div class="all-sets-team-block">
        <span class="all-sets-team-title team-b">${teamState.teamB.name} (FS: ${fsB})</span>
        ${teamBBansHtml}
      </div>
      <button class="all-sets-card-btn" data-set-idx="${idx}">
        ${idx === activeSetIndex ? 'CURRENTLY ACTIVE' : `SWITCH TO SET ${set.setNumber}`}
      </button>
    `;

    card.querySelector('.all-sets-card-btn')?.addEventListener('click', () => {
      switchActiveSet(idx);
      closeAllSetsModal();
    });

    allSetsContainer.appendChild(card);
  });
}

function generateSeriesSummaryText() {
  const lines = [
    '========================================',
    `ATXXII SCRIM: ${teamState.teamA.name} VS ${teamState.teamB.name}`,
    '5-SET SERIES BANS & FLAGSHIPS SUMMARY',
    '========================================',
  ];

  scrimSets.forEach(set => {
    lines.push(`\n[SET ${set.setNumber}] Status: ${set.status}`);
    const fsA = set.flagships.TEAM_A ? `${set.flagships.TEAM_A.name} (Immune)` : 'None';
    const bansA = set.bans.TEAM_A.map((s, i) => s ? `${s.name} (${s.points}p)` : `[Empty ${i+1}]`).join(', ');
    lines.push(`  ${teamState.teamA.name} -> Flagship: ${fsA} | Bans: ${bansA}`);

    const fsB = set.flagships.TEAM_B ? `${set.flagships.TEAM_B.name} (Immune)` : 'None';
    const bansB = set.bans.TEAM_B.map((s, i) => s ? `${s.name} (${s.points}p)` : `[Empty ${i+1}]`).join(', ');
    lines.push(`  ${teamState.teamB.name} -> Flagship: ${fsB} | Bans: ${bansB}`);
  });

  lines.push('\n========================================');
  return lines.join('\n');
}

async function copySeriesSummary() {
  const text = generateSeriesSummaryText();
  try {
    await navigator.clipboard.writeText(text);
    showTacticalToast('📋 Copied 5-set series ban summary to clipboard!', 'info');
  } catch (err) {
    console.error('[ATXXII] Failed to copy summary:', err);
    showTacticalToast('Clipboard copy failed. Please try again.', 'danger');
  }
}

document.getElementById('btn-toggle-all-sets-view')?.addEventListener('click', openAllSetsModal);
document.getElementById('btn-close-all-sets-modal')?.addEventListener('click', closeAllSetsModal);
document.getElementById('btn-copy-sets-clipboard')?.addEventListener('click', copySeriesSummary);
document.getElementById('btn-modal-copy-summary')?.addEventListener('click', copySeriesSummary);
document.getElementById('btn-modal-clear-all')?.addEventListener('click', () => {
  resetAllSets();
  renderAllSetsGrid();
});

// ============================================================================
// FENRIS CREATIONS EULA & LEGAL NOTICE MODAL
// ============================================================================
const legalModal = document.getElementById('legal-modal');

function openLegalModal() {
  legalModal?.classList.remove('hidden');
}

function closeLegalModal() {
  legalModal?.classList.add('hidden');
}

document.getElementById('btn-landing-legal')?.addEventListener('click', openLegalModal);
document.getElementById('btn-footer-legal')?.addEventListener('click', openLegalModal);
document.getElementById('btn-close-legal-modal')?.addEventListener('click', closeLegalModal);
document.getElementById('btn-dismiss-legal')?.addEventListener('click', closeLegalModal);

// ============================================================================
// TOURNAMENT SESSION & DRAFTING ROLES MANAGER
// ============================================================================
const sessionModal = document.getElementById('session-modal');
let modalPendingRole = currentUserRole;

function getRoleBadgeText(role) {
  const teamAName = teamState.teamA?.name || 'TEAM A';
  const teamBName = teamState.teamB?.name || 'TEAM B';

  if (role === 'REFEREE') return '🛡️ REFEREE';
  if (role === 'CAPTAIN_A') return `🔷 ${teamAName} CAPTAIN`;
  if (role === 'CAPTAIN_B') return `🔶 ${teamBName} CAPTAIN`;
  if (role === 'TEAM_A' || role === 'PILOT_A') return `🔷 ${teamAName} PILOT`;
  if (role === 'RESERVE_A') return `🔷 ${teamAName} RESERVE`;
  if (role === 'TEAM_B' || role === 'PILOT_B') return `🔶 ${teamBName} PILOT`;
  if (role === 'RESERVE_B') return `🔶 ${teamBName} RESERVE`;
  if (role === 'CLEANER') return '🧹 RING CLEANER';
  if (role === 'SPECTATOR') return '👁️ SPECTATOR';
  return '🛡️ REFEREE';
}

function updateSessionRoleUI() {
  // Header button
  const headerSession = document.getElementById('header-session-display');
  const headerRole = document.getElementById('header-role-badge');
  if (headerSession) headerSession.textContent = `SESSION: ${currentSessionId}`;
  if (headerRole) {
    headerRole.textContent = getRoleBadgeText(currentUserRole);
    headerRole.className = 'role-pill-badge';
    if (currentUserRole === 'REFEREE') headerRole.classList.add('badge-referee');
    else if (currentUserRole === 'TEAM_A' || currentUserRole === 'CAPTAIN_A' || currentUserRole === 'PILOT_A' || currentUserRole === 'RESERVE_A') headerRole.classList.add('badge-team-a');
    else if (currentUserRole === 'TEAM_B' || currentUserRole === 'CAPTAIN_B' || currentUserRole === 'PILOT_B' || currentUserRole === 'RESERVE_B') headerRole.classList.add('badge-team-b');
    else if (currentUserRole === 'CLEANER') headerRole.classList.add('badge-referee');
    else if (currentUserRole === 'SPECTATOR') headerRole.classList.add('badge-spectator');
  }

  // Timer Page HUD
  const roomCodeDisplay = document.getElementById('room-code-display');
  if (roomCodeDisplay) {
    roomCodeDisplay.textContent = `${currentSessionId} • ${getRoleBadgeText(currentUserRole)}`;
  }

  // Session Modal labels
  const roleLabelA = document.getElementById('role-team-a-label');
  const roleLabelB = document.getElementById('role-team-b-label');
  if (roleLabelA) roleLabelA.textContent = `${teamState.teamA.name || 'TEAM A'} CAPTAIN`;
  if (roleLabelB) roleLabelB.textContent = `${teamState.teamB.name || 'TEAM B'} CAPTAIN`;

  const sessionSummary = document.getElementById('session-current-summary');
  if (sessionSummary) {
    sessionSummary.textContent = `Connected as: ${getRoleBadgeText(currentUserRole)} in SESSION ${currentSessionId}`;
  }

  // Flagship button tooltips / disabled state
  const btnFsA = document.getElementById('btn-flagship-team-a');
  const btnFsB = document.getElementById('btn-flagship-team-b');
  const pillFsA = document.getElementById('ref-flagship-pill-a');
  const pillFsB = document.getElementById('ref-flagship-pill-b');

  const canEditFsA = (currentUserRole === 'REFEREE' || currentUserRole === 'TEAM_A');
  const canEditFsB = (currentUserRole === 'REFEREE' || currentUserRole === 'TEAM_B');

  [btnFsA, pillFsA].forEach(el => {
    if (el) {
      el.style.opacity = canEditFsA ? '1' : '0.55';
      el.style.cursor = canEditFsA ? 'pointer' : 'not-allowed';
    }
  });

  [btnFsB, pillFsB].forEach(el => {
    if (el) {
      el.style.opacity = canEditFsB ? '1' : '0.55';
      el.style.cursor = canEditFsB ? 'pointer' : 'not-allowed';
    }
  });

  // Ban reset buttons restricted to referee
  const btnResetBans = document.getElementById('btn-reset-bans');
  if (btnResetBans) {
    const isRef = (currentUserRole === 'REFEREE');
    btnResetBans.style.opacity = isRef ? '1' : '0.45';
    btnResetBans.title = isRef ? 'Reset Set Bans' : 'Only Tournament Referees can reset bans';
  }
}

function updateSessionModalSummary() {
  const inputSession = document.getElementById('input-session-id');
  const code = (inputSession?.value || currentSessionId).trim().toUpperCase();
  const summaryEl = document.getElementById('session-current-summary');
  if (summaryEl) {
    summaryEl.textContent = `Selected: ${getRoleBadgeText(modalPendingRole)} • Session: ${code}`;
  }
}

function openSessionModal() {
  modalPendingRole = currentUserRole;
  const inputSession = document.getElementById('input-session-id');
  if (inputSession) inputSession.value = currentSessionId;

  document.querySelectorAll('#session-modal .role-card').forEach(card => {
    card.classList.toggle('active', card.dataset.role === modalPendingRole);
  });

  updateSessionRoleUI();
  updateSessionModalSummary();
  sessionModal?.classList.remove('hidden');
}

function closeSessionModal() {
  sessionModal?.classList.add('hidden');
}

function getInviteLink(role) {
  let base = window.location.origin + window.location.pathname;
  if (!window.location.origin || window.location.origin === 'null') {
    base = window.location.href.split('?')[0].split('#')[0];
  }
  return `${base}?session=${encodeURIComponent(currentSessionId)}&role=${role}`;
}

async function copyInviteLink(role, roleName) {
  const link = getInviteLink(role);
  try {
    await navigator.clipboard.writeText(link);
    showTacticalToast(`📋 Copied ${roleName} invite link for Session ${currentSessionId}!`, 'info');
  } catch (err) {
    prompt(`Copy this link to invite ${roleName}:`, link);
  }
}

document.querySelectorAll('#session-modal .role-card').forEach(card => {
  card.addEventListener('click', () => {
    modalPendingRole = card.dataset.role;
    document.querySelectorAll('#session-modal .role-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    updateSessionModalSummary();
  });
});

// ==========================================================================
// MULTIPLAYER SCRIM HUD & PEER COORDINATION
// ==========================================================================
const resignConfirmModal = document.getElementById('resign-confirm-modal');

function updateMultiplayerHud(snapshot) {
  if (!snapshot) return;

  // 1. Teams Tab Summary Bar
  const teamsCode = document.getElementById('teams-session-code');
  const teamsCapA = document.getElementById('teams-cap-a-status');
  const teamsCapB = document.getElementById('teams-cap-b-status');
  const teamsPlayers = document.getElementById('teams-players-count');
  const teamsPrimary = document.getElementById('teams-primary-coord');

  if (teamsCode) teamsCode.textContent = snapshot.sessionCode;

  const capAPlayer = snapshot.players?.find(p => p.role === 'CAPTAIN_A');
  const capBPlayer = snapshot.players?.find(p => p.role === 'CAPTAIN_B');

  if (teamsCapA) {
    const isOnline = capAPlayer && capAPlayer.connected;
    const nameStr = capAPlayer?.character?.name || capAPlayer?.name || 'CAPTAIN A';
    const tickerStr = capAPlayer?.character?.corporationTicker ? ` [${capAPlayer.character.corporationTicker}]` : '';
    teamsCapA.textContent = isOnline ? `${nameStr}${tickerStr}` : 'DISCONNECTED';
    teamsCapA.className = `summary-val ${isOnline ? 'status-online' : ''}`;
  }

  if (teamsCapB) {
    const isOnline = capBPlayer && capBPlayer.connected;
    const nameStr = capBPlayer?.character?.name || capBPlayer?.name || 'CAPTAIN B';
    const tickerStr = capBPlayer?.character?.corporationTicker ? ` [${capBPlayer.character.corporationTicker}]` : '';
    teamsCapB.textContent = isOnline ? `${nameStr}${tickerStr}` : 'WAITING';
    teamsCapB.className = `summary-val ${isOnline ? 'status-online' : ''}`;
  }

  if (teamsPlayers && snapshot.playerCounts) {
    const { teamA, teamB, reservesA, reservesB, cleaners, spectators, referees, total } = snapshot.playerCounts;
    const totalSubs = (reservesA || 0) + (reservesB || 0);
    let parts = [`${teamA + teamB}/20 Pilots`];
    if (totalSubs > 0) parts.push(`${totalSubs} Reserves`);
    if (cleaners > 0) parts.push(`${cleaners} Cleaners`);
    if (spectators > 0) parts.push(`${spectators} Specs`);
    if (referees > 0) parts.push(`${referees} Refs`);
    teamsPlayers.textContent = `${total} Total (${parts.join(' • ')})`;
  }

  if (teamsPrimary) {
    teamsPrimary.textContent = snapshot.primaryCoordinator === 'CAPTAIN_B' ? 'Captain B (Failover)' : 'Captain A (Host)';
  }

  // 2. Timer Tab Scrim HUD Bar
  const roomCodeDisplay = document.getElementById('room-code-display');
  const timerTeamACount = document.getElementById('timer-team-a-count');
  const timerTeamBCount = document.getElementById('timer-team-b-count');
  const timerReadyCount = document.getElementById('timer-ready-count');

  if (roomCodeDisplay) {
    roomCodeDisplay.textContent = `${snapshot.sessionCode} • ${getRoleBadgeText(networkManager.localRole)}`;
  }
  if (timerTeamACount && snapshot.playerCounts) {
    const subText = (snapshot.playerCounts.reservesA > 0) ? ` (+${snapshot.playerCounts.reservesA} Subs)` : '';
    timerTeamACount.textContent = `${snapshot.playerCounts.teamA} / 10 Pilots${subText}`;
  }
  if (timerTeamBCount && snapshot.playerCounts) {
    const subText = (snapshot.playerCounts.reservesB > 0) ? ` (+${snapshot.playerCounts.reservesB} Subs)` : '';
    timerTeamBCount.textContent = `${snapshot.playerCounts.teamB} / 10 Pilots${subText}`;
  }
  if (timerReadyCount && snapshot.players) {
    const readyPlayers = snapshot.players.filter(p => p.isReady && p.connected).length;
    const totalConnected = snapshot.players.filter(p => p.connected).length;
    timerReadyCount.textContent = `${readyPlayers} / ${totalConnected} Ready`;
  }

  // 3. Header Display
  const headerSession = document.getElementById('header-session-display');
  const headerRole = document.getElementById('header-role-badge');
  if (headerSession) headerSession.textContent = `SESSION: ${snapshot.sessionCode}`;
  if (headerRole) headerRole.textContent = getRoleBadgeText(networkManager.localRole);
}

// Modal open/close
document.getElementById('btn-session-manager')?.addEventListener('click', openSessionModal);
document.getElementById('timer-hud-session-item')?.addEventListener('click', openSessionModal);
document.getElementById('btn-bans-switch-role')?.addEventListener('click', openSessionModal);
document.getElementById('btn-close-session-modal')?.addEventListener('click', closeSessionModal);

// Host session trigger
async function triggerHostScrimSession() {
  showTacticalToast('⚡ Initializing P2P Host Coordinator networking service...', 'info');
  try {
    const res = await networkManager.hostSession({
      teamA: { name: teamState.teamA.name, captain: teamState.teamA.captain, ticker: teamState.teamA.ticker },
      teamB: { name: teamState.teamB.name, captain: teamState.teamB.captain, ticker: teamState.teamB.ticker },
    });
    currentSessionId = res.sessionCode;
    currentUserRole = 'REFEREE';
    localStorage.setItem('atxxii_session_id', currentSessionId);
    const inputSession = document.getElementById('input-session-id');
    if (inputSession) inputSession.value = currentSessionId;
    updateSessionModalSummary();
    updateMultiplayerHud(res.snapshot);
    showTacticalToast(`👑 Scrim Session ${res.sessionCode} created! You are Primary Host Coordinator.`, 'info');
  } catch (err) {
    console.error('[HostSession Error]', err);
    showTacticalToast(`❌ Failed to create session: ${err.message}`, 'danger');
  }
}

document.getElementById('btn-teams-create-session')?.addEventListener('click', triggerHostScrimSession);
document.getElementById('btn-generate-session')?.addEventListener('click', triggerHostScrimSession);

// ==========================================================================
// SESSION JOIN COORDINATION (MANUAL & at22:// PROTOCOL)
// ==========================================================================
async function performJoinSession({ sessionCode, credentialKey = '', source = 'manual' }) {
  const cleanCode = (sessionCode || '').trim().toUpperCase();
  const cleanKey = (credentialKey || '').trim();

  if (!cleanCode) {
    showTacticalToast('⚠️ Please enter a valid Session Code (e.g. AT22-X7KF)', 'warning');
    return false;
  }

  showTacticalToast(`📡 Connecting to Scrim Session ${cleanCode}...`, 'info');

  try {
    const res = await networkManager.joinSession({
      sessionCode: cleanCode,
      credentialKey: cleanKey,
    });

    currentSessionId = cleanCode;
    currentUserRole = res.player.role;
    localStorage.setItem('atxxii_session_id', currentSessionId);
    localStorage.setItem('atxxii_user_role', currentUserRole);

    const inputSession = document.getElementById('input-session-id');
    if (inputSession) inputSession.value = currentSessionId;
    const inputKey = document.getElementById('input-session-key');
    if (inputKey) inputKey.value = cleanKey;

    updateSessionRoleUI();
    updateMultiplayerHud(res.snapshot);
    closeSessionModal();

    showTacticalToast(`✅ Connected to Scrim ${cleanCode} as ${getRoleBadgeText(currentUserRole)}!`, 'info');
    return true;
  } catch (err) {
    console.error('[JoinSession Error]', err);
    let errMsg = err.message || 'UNABLE TO CONNECT';
    if (errMsg.includes('timed out')) {
      errMsg = 'UNABLE TO CONNECT: Host not reachable or timed out';
    }
    showTacticalToast(`⛔ ${errMsg.toUpperCase()}`, 'danger');
    return false;
  }
}

async function handleDeepLinkUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return;
  console.log('[DeepLink] Inbound protocol link received:', urlStr);

  const parsed = parseDeepLink(urlStr);
  if (!parsed.valid) {
    console.warn('[DeepLink] Invalid deep link:', parsed.error, urlStr);
    showTacticalToast(`⚠️ Malformed at22:// link: ${parsed.error}`, 'warning');
    return;
  }

  showTacticalToast(`🔗 Inbound Scrim Invite detected (${parsed.sessionCode})`, 'info');
  await performJoinSession({
    sessionCode: parsed.sessionCode,
    credentialKey: parsed.credentialKey,
    source: 'deep_link',
  });
}

// Join session trigger from manual form
async function triggerJoinScrimSession() {
  const inputCode = document.getElementById('input-session-id')?.value?.trim().toUpperCase();
  const inputKey = document.getElementById('input-session-key')?.value?.trim() || '';
  await performJoinSession({ sessionCode: inputCode, credentialKey: inputKey, source: 'manual' });
}

document.getElementById('btn-join-session')?.addEventListener('click', triggerJoinScrimSession);

document.getElementById('btn-confirm-session-role')?.addEventListener('click', () => {
  const inputSession = document.getElementById('input-session-id');
  const enteredCode = (inputSession?.value || '').trim().toUpperCase() || DEFAULT_SESSION_ID;
  const sessionChanged = (enteredCode !== currentSessionId);

  currentSessionId = enteredCode;
  currentUserRole = modalPendingRole || 'REFEREE';

  localStorage.setItem('atxxii_session_id', currentSessionId);
  localStorage.setItem('atxxii_user_role', currentUserRole);

  if (sessionChanged) {
    initSyncChannel(currentSessionId);
  }

  updateSessionRoleUI();
  populateTeamInputs();
  updateBanUI();
  renderShipPool();
  renderRefereeSlots('TEAM_A');
  renderRefereeSlots('TEAM_B');
  renderTimerMatchBans();
  closeSessionModal();

  showTacticalToast(`✅ Active Role: ${getRoleBadgeText(currentUserRole)} in Session ${currentSessionId}`, 'info');
});

// Resign Confirmation Dialog
let pendingResignTeam = null;

function promptResignConfirmation(team) {
  pendingResignTeam = team;
  const modal = document.getElementById('resign-confirm-modal');
  const teamLabel = document.getElementById('resign-modal-team-name');
  if (teamLabel) {
    teamLabel.textContent = team === 'TEAM_A' ? (teamState.teamA.name || 'BLUE FLEET') : (teamState.teamB.name || 'RED FLEET');
  }
  if (modal) modal.classList.remove('hidden');
}

function closeResignConfirmation() {
  pendingResignTeam = null;
  const modal = document.getElementById('resign-confirm-modal');
  if (modal) modal.classList.add('hidden');
}

document.getElementById('btn-confirm-resign')?.addEventListener('click', () => {
  if (pendingResignTeam) {
    resignMatch(pendingResignTeam);
  }
  closeResignConfirmation();
});

document.getElementById('btn-cancel-resign')?.addEventListener('click', closeResignConfirmation);
document.getElementById('btn-close-resign-modal')?.addEventListener('click', closeResignConfirmation);

// Invite Copy Handlers
async function copyTextToClipboard(text, successMsg) {
  try {
    await navigator.clipboard.writeText(text);
    showTacticalToast(successMsg, 'info');
  } catch (err) {
    prompt('Copy to clipboard:', text);
  }
}

document.getElementById('btn-teams-copy-join-info')?.addEventListener('click', () => {
  const text = networkManager.session ? networkManager.generateFleetChatInvite() : `ATXXII Scrim Session: ${currentSessionId}`;
  copyTextToClipboard(text, '📋 Copied full Scrim Session Fleet Chat info to clipboard!');
});

document.getElementById('btn-copy-all-join-info')?.addEventListener('click', () => {
  const text = networkManager.session ? networkManager.generateFleetChatInvite() : `ATXXII Scrim Session: ${currentSessionId}`;
  copyTextToClipboard(text, '📋 Copied full Scrim Session Fleet Chat info to clipboard!');
});

document.getElementById('btn-copy-referee-link')?.addEventListener('click', () => {
  copyTextToClipboard(networkManager.generateJoinUrl('REFEREE'), '🛡️ Copied Official Tournament Referee invite link!');
});

document.getElementById('btn-copy-captain-b-link')?.addEventListener('click', () => {
  copyTextToClipboard(networkManager.generateJoinUrl('CAPTAIN_B'), '👑 Copied Captain B (Co-Host) invite link!');
});

document.getElementById('btn-copy-team-a-link')?.addEventListener('click', () => {
  copyTextToClipboard(networkManager.generateJoinUrl('TEAM_A'), `🔷 Copied ${teamState.teamA.name || 'Team A'} (Pilots & Reserves) invite link!`);
});

document.getElementById('btn-copy-team-b-link')?.addEventListener('click', () => {
  copyTextToClipboard(networkManager.generateJoinUrl('TEAM_B'), `🔶 Copied ${teamState.teamB.name || 'Team B'} (Pilots & Reserves) invite link!`);
});

document.getElementById('btn-copy-cleaner-link')?.addEventListener('click', () => {
  copyTextToClipboard(networkManager.generateJoinUrl('CLEANER'), '🧹 Copied Arena Ring Cleaner invite link!');
});

document.getElementById('btn-copy-spectator-link')?.addEventListener('click', () => {
  copyTextToClipboard(networkManager.generateJoinUrl('SPECTATOR'), '👁️ Copied Spectator / Observer invite link!');
});

// Invite Key Rotation & Session Close Handlers
const roleRotateMap = [
  { id: 'btn-rotate-referee-key', role: 'REFEREE', label: 'Referee' },
  { id: 'btn-rotate-captain-b-key', role: 'CAPTAIN_B', label: 'Captain B' },
  { id: 'btn-rotate-team-a-key', role: 'TEAM_A', label: 'Team A' },
  { id: 'btn-rotate-team-b-key', role: 'TEAM_B', label: 'Team B' },
  { id: 'btn-rotate-cleaner-key', role: 'CLEANER', label: 'Ring Cleaner' },
  { id: 'btn-rotate-spectator-key', role: 'SPECTATOR', label: 'Spectator' },
];

roleRotateMap.forEach(({ id, role, label }) => {
  document.getElementById(id)?.addEventListener('click', () => {
    if (!networkManager.isHost && networkManager.localRole !== 'REFEREE') {
      showTacticalToast('⛔ Only the Host / Referee can rotate access credentials.', 'warning');
      return;
    }
    const res = networkManager.rotateRoleInvite(role);
    if (res) {
      showTacticalToast(`↻ Rotated ${label} Access Key! New invite link generated. Active players remain connected.`, 'info');
    } else {
      showTacticalToast('⚠️ Session not active.', 'warning');
    }
  });
});

document.getElementById('btn-close-session')?.addEventListener('click', () => {
  if (!networkManager.isHost && networkManager.localRole !== 'REFEREE') {
    showTacticalToast('⛔ Only the Host / Referee can close the scrim session.', 'warning');
    return;
  }
  if (confirm('Are you sure you want to permanently close this scrim session? All invite keys will be revoked.')) {
    networkManager.closeSession();
    showTacticalToast('⛔ SCRIM SESSION CLOSED permanently.', 'warning');
  }
});

// NetworkManager Event Subscriptions
networkManager.on('state_updated', (snapshot) => {
  updateMultiplayerHud(snapshot);
  if (snapshot.matchTiming) {
    Object.assign(timerState, snapshot.matchTiming);
    if (timerState.phase === 'WARMUP' || timerState.phase === 'MATCH') {
      startAutonomousTimer();
    } else {
      if (autonomousTimerInterval) clearInterval(autonomousTimerInterval);
      autonomousTimerInterval = null;
    }
    updateTimerDisplays();
  }
  if (Array.isArray(snapshot.scrimSets)) {
    snapshot.scrimSets.forEach((s, idx) => {
      if (scrimSets[idx]) Object.assign(scrimSets[idx], s);
    });
    updateBanUI();
    renderShipPool();
    updateTimerSetsNavBadges();
    renderRefereeSlots('TEAM_A');
    renderRefereeSlots('TEAM_B');
    renderTimerMatchBans();
  }
});

networkManager.on('comp_accepted', () => {
  // Re-render comp UI for both teams whenever a remote comp change is confirmed.
  // The session snapshot was already merged by the COMP_ACCEPTED handler in NetworkManager.
  renderRefereeSlots('TEAM_A');
  renderRefereeSlots('TEAM_B');
  renderTimerMatchBans();
  broadcastSetsState(); // keep local BroadcastChannel (pop-out) in sync too
});

networkManager.on('warmup_started', (timing) => {
  Object.assign(timerState, timing);
  startAutonomousTimer();
  updateTimerDisplays();
  showTacticalToast(`⏱️ 60-Second Match Warmup Started! Scheduled Match Start: ${new Date(timing.matchStartUtc).toLocaleTimeString()}`, 'info');
});

networkManager.on('match_resigned', (timing) => {
  Object.assign(timerState, timing);
  if (autonomousTimerInterval) clearInterval(autonomousTimerInterval);
  autonomousTimerInterval = null;
  updateTimerDisplays();
  onMatchCompleted();
  showTacticalToast(`🏁 ${timing.resignedMessage || 'Match Concluded'} (${timing.resignedTimeStr})`, 'warning');
});

networkManager.on('match_reset', (timing) => {
  Object.assign(timerState, timing);
  if (autonomousTimerInterval) clearInterval(autonomousTimerInterval);
  autonomousTimerInterval = null;
  updateTimerDisplays();
  showTacticalToast('↺ Match reset to Standby.', 'info');
});

networkManager.on('failover_activated', ({ newCoordinator }) => {
  showTacticalToast(`⚠️ Primary Coordinator Failover Activated! ${newCoordinator === 'CAPTAIN_B' ? 'Captain B' : 'Captain A'} is now primary authority. Local match timers continue undisturbed.`, 'warning');
  const teamsPrimary = document.getElementById('teams-primary-coord');
  if (teamsPrimary) teamsPrimary.textContent = 'Captain B (Failover)';
});

networkManager.on('clock_synced', ({ offsetMs, rttMs, status }) => {
  const syncDisplay = document.getElementById('sync-status-display');
  if (syncDisplay) {
    const sign = offsetMs >= 0 ? '+' : '';
    syncDisplay.textContent = `SYNC: ${status} (${sign}${Math.round(offsetMs)}ms)`;
    syncDisplay.className = `hud-val ${status === 'GOOD' ? 'sync-good' : status === 'FAIR' ? 'sync-fair' : 'sync-poor'}`;
  }
});

networkManager.on('credentials_rotated', ({ role, newKey }) => {
  showTacticalToast(`🔑 Access key for ${role} was regenerated by Host.`, 'info');
});

networkManager.on('session_closed', () => {
  showTacticalToast('⛔ SESSION CLOSED: Host concluded the scrim session. Invites are expired.', 'danger');
  updateSessionModalSummary();
});

networkManager.on('join_failed', (errMsg) => {
  showTacticalToast(`⛔ ${errMsg.toUpperCase()}`, 'danger');
});

// Setup Tauri Deep Linking (Cold start & warm single-instance runtime)
async function initDeepLinking() {
  if (invoke) {
    try {
      const initialDeepLink = await invoke('get_initial_deep_link');
      if (initialDeepLink) {
        console.log('[DeepLink] Cold-start deep link detected:', initialDeepLink);
        handleDeepLinkUrl(initialDeepLink);
      }
    } catch (err) {
      console.warn('[DeepLink] Cold start check error:', err);
    }
  }

  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen('deep-link-received', (event) => {
      console.log('[DeepLink] Runtime deep link received:', event.payload);
      if (event.payload) {
        handleDeepLinkUrl(event.payload);
      }
    });
  } catch (err) {
    // Normal in pure web browser mode
  }
}

// Auto-join from URL parameter if present (browser mode fallback)
if (initialUrlParams.has('session')) {
  const urlSession = initialUrlParams.get('session').trim().toUpperCase();
  const urlKey = initialUrlParams.get('key')?.trim() || '';
  if (urlSession && urlSession.startsWith('AT')) {
    performJoinSession({ sessionCode: urlSession, credentialKey: urlKey, source: 'url_query' });
  }
}

initDeepLinking();

// ==========================================================================
// FIRST-RUN SETUP & LOCAL USER PROFILE (Phases 1 - 14)
// ==========================================================================
const setupModal = document.getElementById('setup-modal');
const profileModal = document.getElementById('profile-modal');
const btnHeaderProfile = document.getElementById('btn-header-profile');

let setupPendingRole = 'MEMBER';
let setupResolvedProfile = null;

function renderHeaderProfile() {
  const profile = profileManager.getProfile();
  const img = document.getElementById('header-profile-portrait');
  const fallback = document.getElementById('header-profile-fallback');
  const charName = document.getElementById('header-profile-char-name');
  const metaLine = document.getElementById('header-profile-meta-line');
  const roleTag = document.getElementById('header-profile-role-tag');

  if (profile.setup_complete && profile.character_name) {
    if (img && profile.character_portrait_url) {
      img.src = profile.character_portrait_url;
      img.classList.remove('hidden');
      if (fallback) fallback.classList.add('hidden');
    }
    if (charName) charName.textContent = profile.character_name;
    if (metaLine) metaLine.textContent = profileManager.getFormattedIdentity(true);
    if (roleTag) {
      roleTag.textContent = profile.preferred_role;
      roleTag.className = `header-profile-role-tag role-${profile.preferred_role.toLowerCase()}`;
    }
  } else {
    if (img) img.classList.add('hidden');
    if (fallback) fallback.classList.remove('hidden');
    if (charName) charName.textContent = 'PILOT SETUP';
    if (metaLine) metaLine.textContent = 'Click to configure';
    if (roleTag) roleTag.textContent = 'SETUP';
  }
}

function switchSetupStep(stepNum) {
  const step1 = document.getElementById('setup-step-role');
  const step2 = document.getElementById('setup-step-lookup');
  const step3 = document.getElementById('setup-step-confirm');

  if (step1) step1.classList.toggle('hidden', stepNum !== 1);
  if (step2) step2.classList.toggle('hidden', stepNum !== 2);
  if (step3) step3.classList.toggle('hidden', stepNum !== 3);

  if (stepNum === 2) {
    setTimeout(() => {
      const input = document.getElementById('setup-char-input');
      if (input) {
        input.focus();
        input.select();
      }
    }, 50);
  }
}

function openSetupWizard(startStep = 1) {
  setupResolvedProfile = null;
  const current = profileManager.getProfile();
  setupPendingRole = current.preferred_role || 'MEMBER';

  // Highlight pending role in Step 1
  ['captain', 'member', 'referee'].forEach(r => {
    const card = document.getElementById(`setup-role-${r}`);
    if (card) {
      card.classList.toggle('active', r.toUpperCase() === setupPendingRole);
    }
  });

  // Reset status
  const statusBox = document.getElementById('setup-lookup-status');
  if (statusBox) statusBox.classList.add('hidden');

  switchSetupStep(startStep);
  setupModal?.classList.remove('hidden');
}

function closeSetupWizard() {
  setupModal?.classList.add('hidden');
}

function setupSetupWizardEvents() {
  // Step 1: Role selection cards
  ['captain', 'member', 'referee'].forEach(r => {
    const card = document.getElementById(`setup-role-${r}`);
    card?.addEventListener('click', () => {
      setupPendingRole = r.toUpperCase();
      ['captain', 'member', 'referee'].forEach(other => {
        document.getElementById(`setup-role-${other}`)?.classList.toggle('active', other === r);
      });
      // User request: When clicking one, immediately advance to Step 2 (Character Name)
      switchSetupStep(2);
    });
  });

  document.getElementById('btn-setup-role-next')?.addEventListener('click', () => {
    switchSetupStep(2);
  });

  document.getElementById('btn-setup-back-to-step1')?.addEventListener('click', () => {
    switchSetupStep(1);
  });

  // Step 2: Character lookup
  const doLookup = async () => {
    const input = document.getElementById('setup-char-input');
    const statusBox = document.getElementById('setup-lookup-status');
    const spinner = document.getElementById('setup-status-spinner');
    const statusMsg = document.getElementById('setup-status-message');
    const lookupBtn = document.getElementById('btn-setup-do-lookup');

    const charName = input?.value?.trim();
    if (!charName) {
      if (statusBox && statusMsg) {
        statusBox.className = 'setup-lookup-status error';
        statusBox.classList.remove('hidden');
        if (spinner) spinner.classList.add('hidden');
        statusMsg.textContent = 'Please enter an in-game character name.';
      }
      return;
    }

    // Set loading UI
    if (statusBox && statusMsg && spinner) {
      statusBox.className = 'setup-lookup-status loading';
      statusBox.classList.remove('hidden');
      spinner.classList.remove('hidden');
      statusMsg.textContent = `Resolving public ESI identity for "${charName}"...`;
    }
    if (lookupBtn) lookupBtn.disabled = true;

    try {
      const resolved = await profileManager.lookupCharacter(charName);
      setupResolvedProfile = resolved;

      // Populate Step 3 Confirmation Card
      const confirmPortrait = document.getElementById('setup-confirm-portrait');
      const confirmRoleTag = document.getElementById('setup-confirm-role-tag');
      const confirmCharName = document.getElementById('setup-confirm-char-name');
      const confirmCorpVal = document.getElementById('setup-confirm-corp-val');
      const confirmAllianceVal = document.getElementById('setup-confirm-alliance-val');
      const confirmIdVal = document.getElementById('setup-confirm-id-val');

      if (confirmPortrait) confirmPortrait.src = resolved.character_portrait_url;
      if (confirmRoleTag) confirmRoleTag.textContent = setupPendingRole;
      if (confirmCharName) confirmCharName.textContent = resolved.character_name;
      if (confirmCorpVal) {
        confirmCorpVal.textContent = `${resolved.corporation_name} [${resolved.corporation_ticker}]`;
      }
      if (confirmAllianceVal) {
        confirmAllianceVal.textContent = resolved.alliance_name
          ? `${resolved.alliance_name} [${resolved.alliance_ticker}]`
          : 'None';
      }
      if (confirmIdVal) confirmIdVal.textContent = `#${resolved.character_id}`;

      if (statusBox) statusBox.classList.add('hidden');
      switchSetupStep(3);
    } catch (err) {
      console.warn('[SetupLookup Error]', err);
      if (statusBox && statusMsg) {
        statusBox.className = 'setup-lookup-status error';
        statusBox.classList.remove('hidden');
        if (spinner) spinner.classList.add('hidden');
        statusMsg.textContent = err.message || 'CHARACTER NOT FOUND';
      }
    } finally {
      if (lookupBtn) lookupBtn.disabled = false;
    }
  };

  document.getElementById('btn-setup-do-lookup')?.addEventListener('click', doLookup);
  document.getElementById('setup-char-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doLookup();
    }
  });

  // Step 3: Back to lookup / Confirm Finish
  document.getElementById('btn-setup-back-to-lookup')?.addEventListener('click', () => {
    switchSetupStep(2);
  });

  document.getElementById('btn-setup-finish')?.addEventListener('click', () => {
    if (!setupResolvedProfile) {
      switchSetupStep(2);
      return;
    }

    profileManager.saveProfile({
      ...setupResolvedProfile,
      preferred_role: setupPendingRole,
      setup_complete: true,
    });

    closeSetupWizard();
    renderHeaderProfile();
    showTacticalToast(`✓ Profile confirmed! Welcome to ATXXII, ${setupResolvedProfile.character_name}.`, 'info');
  });
}

// Profile Settings Modal (Phase 11)
function openProfileModal() {
  const profile = profileManager.getProfile();
  if (!profile.setup_complete) {
    openSetupWizard(1);
    return;
  }

  const portrait = document.getElementById('profile-modal-portrait');
  const name = document.getElementById('profile-modal-char-name');
  const corp = document.getElementById('profile-modal-corp');
  const alliance = document.getElementById('profile-modal-alliance');
  const idEl = document.getElementById('profile-modal-id');

  if (portrait && profile.character_portrait_url) portrait.src = profile.character_portrait_url;
  if (name) name.textContent = profile.character_name;
  if (corp) corp.textContent = `Corporation: ${profile.corporation_name} [${profile.corporation_ticker}]`;
  if (alliance) {
    alliance.textContent = profile.alliance_name
      ? `Alliance: ${profile.alliance_name} [${profile.alliance_ticker}]`
      : 'Alliance: None';
  }
  if (idEl) idEl.textContent = `Character ID: ${profile.character_id}`;

  // Update role buttons active state
  ['captain', 'member', 'referee'].forEach(r => {
    const btn = document.getElementById(`btn-profile-role-${r}`);
    btn?.classList.toggle('active', r.toUpperCase() === profile.preferred_role);
  });

  profileModal?.classList.remove('hidden');
}

function closeProfileModal() {
  profileModal?.classList.add('hidden');
}

function setupProfileModalEvents() {
  btnHeaderProfile?.addEventListener('click', openProfileModal);
  document.getElementById('btn-close-profile-modal')?.addEventListener('click', closeProfileModal);
  document.getElementById('btn-close-profile')?.addEventListener('click', closeProfileModal);

  // Switch preferred role
  ['captain', 'member', 'referee'].forEach(r => {
    const btn = document.getElementById(`btn-profile-role-${r}`);
    btn?.addEventListener('click', () => {
      const newRole = r.toUpperCase();
      profileManager.setPreferredRole(newRole);
      ['captain', 'member', 'referee'].forEach(other => {
        document.getElementById(`btn-profile-role-${other}`)?.classList.toggle('active', other === r);
      });
      renderHeaderProfile();
      showTacticalToast(`Local preferred role updated to ${newRole}.`, 'info');
    });
  });

  // Refresh ESI
  document.getElementById('btn-profile-refresh-esi')?.addEventListener('click', async () => {
    showTacticalToast('↻ Refreshing public ESI data...', 'info');
    try {
      await profileManager.refreshProfile(true);
      renderHeaderProfile();
      openProfileModal();
      showTacticalToast('✓ EVE Online public profile refreshed!', 'info');
    } catch (err) {
      showTacticalToast(`⚠️ Refresh failed: ${err.message}`, 'warning');
    }
  });

  // Rerun Setup
  document.getElementById('btn-profile-rerun-setup')?.addEventListener('click', () => {
    closeProfileModal();
    openSetupWizard(1);
  });
}

// Close on backdrop click for modals
[flagshipModal, allSetsModal, legalModal, sessionModal, resignConfirmModal, profileModal].forEach(modal => {
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.add('hidden');
    }
  });
});

// Escape key to dismiss modals
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeFlagshipModal();
    closeAllSetsModal();
    closeLegalModal();
    closeSessionModal();
    closeResignConfirmation();
    closeProfileModal();
    if (profileManager.isSetupComplete()) {
      closeSetupWizard();
    }
  }
});

// Reset local storage on explicit request or dev query parameter (?reset=1)
if (window.location.search.includes('reset=1')) {
  profileManager.resetProfile();
  localStorage.removeItem('atxxii_teams');
  localStorage.removeItem('atxxii_session_id');
  localStorage.removeItem('atxxii_user_role');
  console.log('[ATXXII] Cleared local storage via reset query param.');
}

// Global helper for developer/user inspection
window.clearLocalStorageAndReopenSetup = () => {
  profileManager.resetProfile();
  localStorage.clear();
  location.reload();
};

// Setup Profile Wizard & Header Profile
setupSetupWizardEvents();
setupProfileModalEvents();
renderHeaderProfile();

if (!profileManager.isSetupComplete()) {
  openSetupWizard(1);
} else {
  // Silent background refresh if stale
  profileManager.refreshProfile(false).then(() => {
    renderHeaderProfile();
  }).catch(() => {});
}

// Initial render & sync
loadSavedTeams();
populateTeamInputs();
applyTeamState(false);
resolveAllianceLogos();
// Ensure no ineligible hulls (e.g. Bhaalgorn) remain set as flagships in any scrim set
scrimSets.forEach(s => {
  if (s.flagships.TEAM_A && !isShipEligibleForFlagship(s.flagships.TEAM_A.id)) s.flagships.TEAM_A = null;
  if (s.flagships.TEAM_B && !isShipEligibleForFlagship(s.flagships.TEAM_B.id)) s.flagships.TEAM_B = null;
});
updateTimerDisplays();
updateTimerSetsNavBadges();
populateShipsDatalist();
renderRefereeSlots('TEAM_A');
renderRefereeSlots('TEAM_B');
renderTimerMatchBans();
updateBanUI();
renderShipPool();
updateSessionRoleUI();
console.log('[ATXXII] Match Timer & 5-Set Ban System Initialized with Scoped Sessions & Role Permissions.');


