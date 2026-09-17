// ATXXII In-Memory Scrim Session Model
// Live match coordination authority for Captain-hosted multiplayer sessions

import { isShipBannable, isShipEligibleForFlagship } from '../data/seasonRules.js';

// Random alphanumeric characters for readable session codes (excluding ambiguous 0/O, 1/I/l)
const CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function generateSessionCode() {
  let result = 'AT22-';
  for (let i = 0; i < 4; i++) {
    result += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
  }
  return result;
}

export function generateSecret(length = 12) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let secret = '';
  for (let i = 0; i < length; i++) {
    secret += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return secret;
}

export function getBanSequenceForSet(setIndex) {
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

export function createDefaultSet(setNum) {
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
      TEAM_A: null,
      TEAM_B: null,
    },
    comp: {
      TEAM_A: Array(10).fill(null),
      TEAM_B: Array(10).fill(null),
    }
  };
}

export const TOTAL_MATCH_MS = 10 * 60 * 1000; // 10 minutes = 600,000 ms

export class ScrimSession {
  constructor(options = {}) {
    this.sessionId = options.sessionId || `session_${Date.now()}_${generateSecret(6)}`;
    this.sessionCode = options.sessionCode || generateSessionCode();

    // Primary Coordinator: 'CAPTAIN_A' or 'CAPTAIN_B'
    this.primaryCoordinator = options.primaryCoordinator || 'CAPTAIN_A';

    this.isClosed = options.isClosed || false;

    // Access Credentials (Secrets generated at host creation)
    this.credentials = options.credentials || {
      refereeKey: generateSecret(16),
      captainAKey: generateSecret(16),
      captainBKey: generateSecret(16),
      teamAKey: generateSecret(12),
      teamBKey: generateSecret(12),
      cleanerKey: generateSecret(12),
      spectatorKey: generateSecret(12),
    };

    // Teams Definition
    this.teams = options.teams || {
      teamA: { name: 'BLUE FLEET', captain: 'Captain Alpha', ticker: 'BLU' },
      teamB: { name: 'RED FLEET', captain: 'Captain Bravo', ticker: 'RED' },
    };

    // Connected Players Map: peerId -> playerRecord
    this.players = new Map();

    // 5 Scrim Sets
    this.activeSetIndex = options.activeSetIndex || 0;
    this.scrimSets = options.scrimSets || [
      createDefaultSet(1),
      createDefaultSet(2),
      createDefaultSet(3),
      createDefaultSet(4),
      createDefaultSet(5),
    ];

    // Authoritative Match Timing
    this.matchTiming = options.matchTiming || {
      phase: 'STANDBY', // 'STANDBY', 'WARMUP', 'MATCH', 'RESIGNED', 'MATCH OVER'
      warmupStartUtc: null,
      matchStartUtc: null, // Shared exact timestamp for 00:00 countdown start
      resignedTeam: null,
      resignedTimestampUtc: null,
      resignedElapsedMs: null,
      resignedMessage: '',
      resignedTimeStr: '',
    };
  }

  getActiveSet() {
    return this.scrimSets[this.activeSetIndex];
  }

  // Determine role and team strictly based on provided secret access credential (Phase 3 & 4)
  // No URL query roles are trusted. Invalid or expired keys are strictly rejected.
  resolveRoleBySecret(key) {
    if (this.isClosed) {
      return { allowed: false, error: 'SESSION CLOSED' };
    }
    if (!key || typeof key !== 'string' || !key.trim()) {
      return { allowed: false, error: 'MISSING ACCESS KEY' };
    }
    const cleanKey = key.trim();
    if (cleanKey === this.credentials.refereeKey) {
      return { allowed: true, role: 'REFEREE', team: null };
    }
    if (cleanKey === this.credentials.captainAKey) {
      return { allowed: true, role: 'CAPTAIN_A', team: 'TEAM_A' };
    }
    if (cleanKey === this.credentials.captainBKey) {
      return { allowed: true, role: 'CAPTAIN_B', team: 'TEAM_B' };
    }
    if (cleanKey === this.credentials.teamAKey) {
      return { allowed: true, role: 'TEAM_A', team: 'TEAM_A' };
    }
    if (cleanKey === this.credentials.teamBKey) {
      return { allowed: true, role: 'TEAM_B', team: 'TEAM_B' };
    }
    if (cleanKey === this.credentials.cleanerKey) {
      return { allowed: true, role: 'CLEANER', team: null };
    }
    if (cleanKey === this.credentials.spectatorKey) {
      return { allowed: true, role: 'SPECTATOR', team: null };
    }
    return { allowed: false, error: 'INVALID ACCESS KEY' };
  }

  // Rotate a specific role's invite key immediately (Phase 7)
  rotateCredential(role) {
    let newKey = null;
    switch (role) {
      case 'TEAM_A':
        this.credentials.teamAKey = generateSecret(12);
        newKey = this.credentials.teamAKey;
        break;
      case 'TEAM_B':
        this.credentials.teamBKey = generateSecret(12);
        newKey = this.credentials.teamBKey;
        break;
      case 'SPECTATOR':
        this.credentials.spectatorKey = generateSecret(12);
        newKey = this.credentials.spectatorKey;
        break;
      case 'CLEANER':
        this.credentials.cleanerKey = generateSecret(12);
        newKey = this.credentials.cleanerKey;
        break;
      case 'CAPTAIN_B':
        this.credentials.captainBKey = generateSecret(16);
        newKey = this.credentials.captainBKey;
        break;
      case 'REFEREE':
        this.credentials.refereeKey = generateSecret(16);
        newKey = this.credentials.refereeKey;
        break;
      default:
        return null;
    }
    return { role, newKey, credentials: { ...this.credentials } };
  }

  // End and invalidate the scrim session (Phase 8)
  closeSession() {
    this.isClosed = true;
    this.credentials = {
      refereeKey: null,
      captainAKey: null,
      captainBKey: null,
      teamAKey: null,
      teamBKey: null,
      cleanerKey: null,
      spectatorKey: null,
    };
    return true;
  }

  // Count active grid pilots per team (10 pilots max on grid per tournament rules)
  getActivePilotsCount(team) {
    let count = 0;
    for (const player of this.players.values()) {
      if (player.team === team && player.connected && (player.role === 'CAPTAIN_A' || player.role === 'CAPTAIN_B' || player.role === 'PILOT_A' || player.role === 'PILOT_B')) {
        count++;
      }
    }
    return count;
  }

  // Count participants by role
  getRoleCount(role) {
    let count = 0;
    for (const player of this.players.values()) {
      if (player.role === role && player.connected) {
        count++;
      }
    }
    return count;
  }

  // Total connected count across all roles
  getTotalConnectedCount() {
    let count = 0;
    for (const player of this.players.values()) {
      if (player.connected) count++;
    }
    return count;
  }

  // Authenticate player and assign slot (Active Pilot, Team Reserve, Ring Cleaner, or Spectator)
  registerPlayer({ peerId, name, credentialKey, reconnectToken, character = null }) {
    if (this.isClosed) {
      return { success: false, error: 'SESSION CLOSED' };
    }

    // Check reconnect token first
    if (reconnectToken) {
      for (const [existingId, p] of this.players.entries()) {
        if (p.reconnectToken === reconnectToken) {
          // Reconnecting participant: reassign peerId
          this.players.delete(existingId);
          p.id = peerId;
          p.connected = true;
          p.lastSeen = Date.now();
          if (character) p.character = character;
          if (character?.name || name) p.name = character?.name || name;
          this.players.set(peerId, p);
          return { success: true, player: p, isReconnect: true };
        }
      }
    }

    const resolved = this.resolveRoleBySecret(credentialKey);
    if (!resolved.allowed) {
      return { success: false, error: resolved.error };
    }

    let finalRole = resolved.role;
    const team = resolved.team;

    // Slot assignment logic:
    // If joining as Team A / Team B:
    // First 10 count as active pilots (including Captain); any additional team members become Reserves!
    if (team === 'TEAM_A' && finalRole !== 'CAPTAIN_A') {
      const activeCount = this.getActivePilotsCount('TEAM_A');
      if (activeCount < 10) {
        finalRole = 'PILOT_A';
      } else {
        finalRole = 'RESERVE_A'; // Team A Reserve
      }
    } else if (team === 'TEAM_B' && finalRole !== 'CAPTAIN_B') {
      const activeCount = this.getActivePilotsCount('TEAM_B');
      if (activeCount < 10) {
        finalRole = 'PILOT_B';
      } else {
        finalRole = 'RESERVE_B'; // Team B Reserve
      }
    }

    // Default callsign naming
    let defaultName = `Pilot ${peerId.slice(-4)}`;
    if (finalRole === 'REFEREE') defaultName = `Referee ${peerId.slice(-4)}`;
    else if (finalRole === 'CAPTAIN_A') defaultName = this.teams.teamA.captain;
    else if (finalRole === 'CAPTAIN_B') defaultName = this.teams.teamB.captain;
    else if (finalRole === 'CLEANER') defaultName = `Ring Cleaner ${peerId.slice(-4)}`;
    else if (finalRole === 'SPECTATOR') defaultName = `Spectator ${peerId.slice(-4)}`;
    else if (finalRole === 'RESERVE_A') defaultName = `Reserve ${this.teams.teamA.ticker || 'A'}-${peerId.slice(-3)}`;
    else if (finalRole === 'RESERVE_B') defaultName = `Reserve ${this.teams.teamB.ticker || 'B'}-${peerId.slice(-3)}`;

    const displayName = character?.name || name || defaultName;
    const clientSessionToken = `cst_${Date.now()}_${generateSecret(12)}`;
    const newPlayer = {
      id: peerId,
      name: displayName,
      character: character || null,
      role: finalRole,
      team,
      clientSessionToken,
      isReferee: (finalRole === 'REFEREE'),
      isCaptain: (finalRole === 'CAPTAIN_A' || finalRole === 'CAPTAIN_B'),
      isCoHost: (finalRole === 'CAPTAIN_B'),
      isReserve: (finalRole === 'RESERVE_A' || finalRole === 'RESERVE_B'),
      isCleaner: (finalRole === 'CLEANER'),
      isSpectator: (finalRole === 'SPECTATOR'),
      isReady: false,
      reconnectToken: `rec_${Date.now()}_${generateSecret(8)}`,
      connected: true,
      joinedAt: Date.now(),
      lastSeen: Date.now(),
    };

    this.players.set(peerId, newPlayer);
    return { success: true, player: newPlayer, isReconnect: false };
  }

  removePlayer(peerId) {
    const p = this.players.get(peerId);
    if (p) {
      p.connected = false;
      p.lastSeen = Date.now();
      return p;
    }
    return null;
  }

  setPlayerReady(peerId, isReady) {
    const p = this.players.get(peerId);
    if (p) {
      p.isReady = !!isReady;
      return true;
    }
    return false;
  }

  // Primary Coordinator Failover (Captain A <-> Captain B)
  promoteCaptainB() {
    if (this.primaryCoordinator !== 'CAPTAIN_B') {
      this.primaryCoordinator = 'CAPTAIN_B';
      return true;
    }
    return false;
  }

  restoreCaptainA() {
    if (this.primaryCoordinator !== 'CAPTAIN_A') {
      this.primaryCoordinator = 'CAPTAIN_A';
      return true;
    }
    return false;
  }

  // Ban Validation & Authority Enforcement
  canSubmitBan(player, shipId) {
    const currentSet = this.getActiveSet();
    if (currentSet.status !== 'ACTIVE') {
      return { allowed: false, reason: 'Ban phase is not currently active.' };
    }

    const banSequence = getBanSequenceForSet(currentSet.setNumber - 1);
    const cur = banSequence[currentSet.currentTurnIndex];
    if (!cur) {
      return { allowed: false, reason: 'All bans for this set have already concluded.' };
    }

    // Role check: Only Captain of the active turn or Referee can draft
    const isTeamTurn = (cur.team === player.team);
    const hasCaptainAuthority = player.isCaptain || player.role === 'REFEREE';
    if (!hasCaptainAuthority || !isTeamTurn) {
      const activeTeamName = cur.team === 'TEAM_A' ? this.teams.teamA.name : this.teams.teamB.name;
      return { allowed: false, reason: `Unauthorized: It is ${activeTeamName}'s turn to ban.` };
    }

    // Flagship Immunity check
    if (currentSet.flagships.TEAM_A?.id === shipId) {
      return { allowed: false, reason: `Flagship Immunity: Designated as ${this.teams.teamA.name} Flagship and cannot be banned.` };
    }
    if (currentSet.flagships.TEAM_B?.id === shipId) {
      return { allowed: false, reason: `Flagship Immunity: Designated as ${this.teams.teamB.name} Flagship and cannot be banned.` };
    }

    // Duplicate ban check
    for (let i = 0; i < 3; i++) {
      if (currentSet.bans.TEAM_A[i]?.id === shipId || currentSet.bans.TEAM_B[i]?.id === shipId) {
        return { allowed: false, reason: 'Ship has already been banned in this set.' };
      }
    }

    // AT Rules validation
    const designatedFsIds = [currentSet.flagships.TEAM_A?.id, currentSet.flagships.TEAM_B?.id].filter(Boolean);
    const currentBannedIds = [...currentSet.bans.TEAM_A, ...currentSet.bans.TEAM_B].filter(Boolean).map(s => s.id);
    const rulesCheck = isShipBannable(shipId, currentBannedIds, designatedFsIds);
    if (!rulesCheck.allowed) {
      return { allowed: false, reason: rulesCheck.reason };
    }

    return { allowed: true, cur };
  }

  applyBan(player, ship) {
    const check = this.canSubmitBan(player, ship.id);
    if (!check.allowed) return check;

    const currentSet = this.getActiveSet();
    const cur = check.cur;

    currentSet.bans[cur.team][cur.slot] = ship;
    currentSet.currentTurnIndex++;

    const banSequence = getBanSequenceForSet(currentSet.setNumber - 1);
    if (currentSet.currentTurnIndex >= banSequence.length) {
      currentSet.status = 'COMPLETE';
      currentSet.turnSecondsRemaining = 0;
    } else {
      currentSet.turnSecondsRemaining = 30;
    }

    return { allowed: true, setNumber: currentSet.setNumber, turn: cur.turn, team: cur.team, slot: cur.slot, ship };
  }

  // Flagship Designation Authority
  canDesignateFlagship(player, targetTeam, shipId) {
    const isOwnerCaptain = (player.isCaptain && player.team === targetTeam) || player.role === 'REFEREE';
    if (!isOwnerCaptain) {
      return { allowed: false, reason: 'You can only designate your own team\'s flagship.' };
    }

    if (!isShipEligibleForFlagship(shipId)) {
      return { allowed: false, reason: 'Selected hull is not eligible as an Alliance Tournament flagship.' };
    }

    const currentSet = this.getActiveSet();
    for (let i = 0; i < 3; i++) {
      if (currentSet.bans.TEAM_A[i]?.id === shipId || currentSet.bans.TEAM_B[i]?.id === shipId) {
        return { allowed: false, reason: 'Ship is already banned in this set.' };
      }
    }

    return { allowed: true };
  }

  applyFlagship(player, targetTeam, ship) {
    if (ship === null) {
      // Clearing flagship
      const isOwnerCaptain = (player.isCaptain && player.team === targetTeam) || player.role === 'REFEREE';
      if (!isOwnerCaptain) return { allowed: false, reason: 'Unauthorized.' };
      this.getActiveSet().flagships[targetTeam] = null;
      return { allowed: true, flagship: null };
    }

    const check = this.canDesignateFlagship(player, targetTeam, ship.id);
    if (!check.allowed) return check;

    this.getActiveSet().flagships[targetTeam] = ship;
    return { allowed: true, flagship: ship };
  }

  // Fleet Composition Slot Authority (Referee: any team; Captain/Pilot: own team only)
  _canEditComp(player, targetTeam) {
    const isRef = player.role === 'REFEREE';
    const isOwnTeam = player.team === targetTeam && (player.isCaptain || player.role === 'PILOT_A' || player.role === 'PILOT_B');
    if (!isRef && !isOwnTeam) {
      const teamLabel = targetTeam === 'TEAM_A' ? 'Team A' : 'Team B';
      return { allowed: false, reason: `Only ${teamLabel} pilots or the Referee can edit this fleet composition.` };
    }
    return { allowed: true };
  }

  applyComp(player, targetTeam, slotIndex, ship) {
    const auth = this._canEditComp(player, targetTeam);
    if (!auth.allowed) return auth;

    if (slotIndex < 0 || slotIndex > 9) {
      return { allowed: false, reason: 'Invalid slot index.' };
    }

    const currentSet = this.getActiveSet();
    if (!currentSet.comp) {
      currentSet.comp = { TEAM_A: Array(10).fill(null), TEAM_B: Array(10).fill(null) };
    }

    currentSet.comp[targetTeam][slotIndex] = ship; // ship may be null (clear slot)
    return { allowed: true, targetTeam, slotIndex, ship };
  }

  clearComp(player, targetTeam) {
    const auth = this._canEditComp(player, targetTeam);
    if (!auth.allowed) return auth;

    const currentSet = this.getActiveSet();
    if (!currentSet.comp) {
      currentSet.comp = { TEAM_A: Array(10).fill(null), TEAM_B: Array(10).fill(null) };
    }

    currentSet.comp[targetTeam] = Array(10).fill(null);
    return { allowed: true, targetTeam };
  }

  // Synchronized Match Timing & Future UTC Timestamping
  startWarmup(warmupSeconds = 60) {
    const now = Date.now();
    const warmupMs = warmupSeconds * 1000;
    this.matchTiming.phase = 'WARMUP';
    this.matchTiming.warmupStartUtc = now;
    this.matchTiming.matchStartUtc = now + warmupMs; // Exact future start moment
    this.matchTiming.resignedTeam = null;
    this.matchTiming.resignedMessage = '';
    this.matchTiming.resignedTimestampUtc = null;
    this.matchTiming.resignedElapsedMs = null;
    return this.matchTiming;
  }

  // Authoritative Resign by Captain
  resignMatch(player, targetTeam) {
    if (!player.isCaptain && player.role !== 'REFEREE') {
      return { allowed: false, reason: 'Only team captains can concede a match.' };
    }
    if (player.role !== 'REFEREE' && player.team !== targetTeam) {
      return { allowed: false, reason: 'Captains may only concede on behalf of their own team.' };
    }

    const now = Date.now();
    let elapsedMs = 0;
    if (this.matchTiming.matchStartUtc) {
      elapsedMs = Math.max(0, Math.min(TOTAL_MATCH_MS, now - this.matchTiming.matchStartUtc));
    }

    const teamName = targetTeam === 'TEAM_A' ? this.teams.teamA.name : this.teams.teamB.name;
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    const timeStr = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

    this.matchTiming.phase = 'RESIGNED';
    this.matchTiming.resignedTeam = targetTeam;
    this.matchTiming.resignedTimestampUtc = now;
    this.matchTiming.resignedElapsedMs = elapsedMs;
    this.matchTiming.resignedMessage = `${teamName} RESIGNED`;
    this.matchTiming.resignedTimeStr = `Ended at ${timeStr}`;

    return { allowed: true, matchTiming: this.matchTiming };
  }

  resetMatch() {
    this.matchTiming = {
      phase: 'STANDBY',
      warmupStartUtc: null,
      matchStartUtc: null,
      resignedTeam: null,
      resignedTimestampUtc: null,
      resignedElapsedMs: null,
      resignedMessage: '',
      resignedTimeStr: '',
    };
    return this.matchTiming;
  }

  // Public Session State Snapshot for broadcast to clients (does not leak private host secrets)
  getPublicSnapshot() {
    const playersList = Array.from(this.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      team: p.team,
      role: p.role,
      isCaptain: p.isCaptain,
      isReady: p.isReady,
      connected: p.connected,
    }));

    return {
      sessionId: this.sessionId,
      sessionCode: this.sessionCode,
      isClosed: this.isClosed,
      primaryCoordinator: this.primaryCoordinator,
      teams: this.teams,
      players: playersList,
      playerCounts: {
        teamA: this.getActivePilotsCount('TEAM_A'),
        teamB: this.getActivePilotsCount('TEAM_B'),
        reservesA: this.getRoleCount('RESERVE_A'),
        reservesB: this.getRoleCount('RESERVE_B'),
        cleaners: this.getRoleCount('CLEANER'),
        spectators: this.getRoleCount('SPECTATOR'),
        referees: this.getRoleCount('REFEREE'),
        total: playersList.filter(p => p.connected).length,
      },
      activeSetIndex: this.activeSetIndex,
      scrimSets: this.scrimSets,
      matchTiming: this.matchTiming,
      timestampUtc: Date.now(),
    };
  }

  // Full Coordinator Snapshot (transferred only between Captain A and Captain B for backup authority)
  getCoordinatorSnapshot() {
    return {
      ...this.getPublicSnapshot(),
      credentials: this.credentials,
    };
  }

  // Synchronize snapshot into instance
  applySnapshot(snapshot) {
    if (!snapshot) return;
    if (snapshot.sessionId) this.sessionId = snapshot.sessionId;
    if (snapshot.sessionCode) this.sessionCode = snapshot.sessionCode;
    if (typeof snapshot.isClosed === 'boolean') this.isClosed = snapshot.isClosed;
    if (snapshot.primaryCoordinator) this.primaryCoordinator = snapshot.primaryCoordinator;
    if (snapshot.teams) this.teams = { ...this.teams, ...snapshot.teams };
    if (snapshot.credentials) this.credentials = { ...this.credentials, ...snapshot.credentials };
    if (typeof snapshot.activeSetIndex === 'number') this.activeSetIndex = snapshot.activeSetIndex;
    if (Array.isArray(snapshot.scrimSets)) this.scrimSets = snapshot.scrimSets;
    if (snapshot.matchTiming) this.matchTiming = { ...this.matchTiming, ...snapshot.matchTiming };

    if (Array.isArray(snapshot.players)) {
      snapshot.players.forEach(p => {
        const existing = this.players.get(p.id);
        if (existing) {
          Object.assign(existing, p);
        } else {
          this.players.set(p.id, { ...p, lastSeen: Date.now() });
        }
      });
    }
  }
}
