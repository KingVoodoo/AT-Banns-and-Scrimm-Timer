// ATXXII Network Manager
// Peer-to-Peer Scrim Session Coordination via WebRTC DataChannels + BroadcastChannel Local Fallback

import PeerPkg from 'peerjs';
const Peer = PeerPkg?.Peer || PeerPkg?.default || PeerPkg;
import { ScrimSession, generateSecret, generateSessionCode, TOTAL_MATCH_MS } from './scrimSession.js';
import { profileManager } from './profileManager.js';

// Free Google STUN configuration for residential NAT traversal without port forwarding
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ]
};

// ==========================================================================
// PHASE 3: SAFE DEEP LINK PARSER (at22://)
// ==========================================================================
export function parseDeepLink(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') {
    return { valid: false, error: 'INVALID_URL' };
  }
  const trimmed = urlStr.trim();
  if (!trimmed.toLowerCase().startsWith('at22://')) {
    return { valid: false, error: 'INVALID_SCHEME' };
  }

  // Handle at22://join?session=AT22-XXXX&key=YYYY
  let queryString = '';
  const match = trimmed.match(/^at22:\/\/([^\/?#]+)(?:\/)?\?([^#]+)$/i);
  if (match) {
    const action = match[1].toLowerCase();
    if (action !== 'join') {
      return { valid: false, error: 'INVALID_ACTION' };
    }
    queryString = match[2];
  } else {
    try {
      const parsed = new URL(trimmed);
      const action = (parsed.hostname || parsed.pathname.replace(/^\/+/, '')).toLowerCase();
      if (action !== 'join') {
        return { valid: false, error: 'INVALID_ACTION' };
      }
      queryString = parsed.search.replace(/^\?/, '');
    } catch (e) {
      return { valid: false, error: 'MALFORMED_URL' };
    }
  }

  const params = new URLSearchParams(queryString);
  let session = null;
  let key = null;
  for (const [k, v] of params.entries()) {
    const lk = k.toLowerCase();
    if (lk === 'session') session = v ? v.trim().toUpperCase() : null;
    if (lk === 'key') key = v ? v.trim() : null;
  }

  if (!session || !key) {
    return { valid: false, error: 'MISSING_PARAMETERS' };
  }

  // Reject oversized values
  if (session.length > 20 || key.length > 40) {
    return { valid: false, error: 'OVERSIZED_PARAMETERS' };
  }

  // Validate session format: strictly AT22-XXXX
  if (!/^AT22-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/.test(session)) {
    return { valid: false, error: 'INVALID_SESSION_FORMAT' };
  }

  // Validate key format: strictly alphanumeric 8-32 chars
  if (!/^[a-z0-9]{8,32}$/.test(key)) {
    return { valid: false, error: 'INVALID_KEY_FORMAT' };
  }

  return {
    valid: true,
    sessionCode: session,
    credentialKey: key,
  };
}

export class NetworkManager {
  constructor() {
    this.session = null;
    this.isHost = false;
    this.localRole = 'SPECTATOR';
    this.localTeam = null;
    this.localPlayerId = `peer_${Date.now()}_${generateSecret(6)}`;
    this.localPlayerName = '';
    this.reconnectToken = sessionStorage.getItem('atxxii_reconnect_token') || '';
    this.clientSessionToken = sessionStorage.getItem('atxxii_client_token') || '';

    // Networking handles
    this.peer = null;
    this.activeConnections = new Map(); // peerId -> DataConnection
    this.coordinatorConn = null; // Connection to primary coordinator (if client)
    this.broadcastChannel = null;

    // Clock Synchronization (Phase 10)
    this.clockOffsetMs = 0;
    this.clockSyncStatus = 'UNSYNCED'; // 'GOOD' (<50ms), 'FAIR' (<150ms), 'POOR' (>=150ms)
    this.clockRoundTripMs = 0;
    this.clockSyncSamples = [];

    // Heartbeat & Failover (Phase 5 & 13)
    this.heartbeatTimer = null;
    this.lastCoordinatorHeartbeat = Date.now();
    this.missedHeartbeats = 0;
    this.isFailoverActive = false;

    // Event Subscribers
    this.listeners = new Map();
  }

  on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(callback);
  }

  emit(event, data) {
    const list = this.listeners.get(event);
    if (list) {
      list.forEach(cb => {
        try { cb(data); } catch (e) { console.error(`[NetworkManager] Error in ${event} listener:`, e); }
      });
    }
  }

  // ==========================================================================
  // PHASE 3: CAPTAIN A HOST MODE
  // ==========================================================================
  async hostSession(teams = null, customCode = null) {
    this.isHost = true;
    this.localRole = 'CAPTAIN_A';
    this.localTeam = 'TEAM_A';

    const sessionCode = customCode || generateSessionCode();
    this.session = new ScrimSession({
      sessionCode,
      teams: teams || {
        teamA: { name: 'BLUE FLEET', captain: 'Captain Alpha', ticker: 'BLU' },
        teamB: { name: 'RED FLEET', captain: 'Captain Bravo', ticker: 'RED' },
      }
    });

    this.localPlayerName = this.session.teams.teamA.captain;

    // Register Captain A as first connected player
    const reg = this.session.registerPlayer({
      peerId: this.localPlayerId,
      name: this.localPlayerName,
      credentialKey: this.session.credentials.captainAKey,
    });
    this.reconnectToken = reg.player.reconnectToken;
    sessionStorage.setItem('atxxii_reconnect_token', this.reconnectToken);

    // Setup Local BroadcastChannel (for same-machine multi-window sync)
    this.initBroadcastChannel(sessionCode);

    // Setup WebRTC Host via PeerJS with custom room-derived peer ID
    const hostPeerId = `atxxii-host-${sessionCode.replace('-', '')}`;
    await this.initPeer(hostPeerId);

    this.startHostHeartbeat();
    this.emit('session_created', {
      sessionCode: this.session.sessionCode,
      credentials: this.session.credentials,
      snapshot: this.session.getPublicSnapshot(),
    });

    return {
      sessionCode: this.session.sessionCode,
      credentials: this.session.credentials,
      snapshot: this.session.getPublicSnapshot(),
    };
  }

  // ==========================================================================
  // PHASE 4, 5, 6: CLIENT JOINING (Captain B, Team Pilots, Reserves, Cleaners, Spectators)
  // ==========================================================================
  async joinSession({ sessionCode, credentialKey = '', playerName = '' }) {
    this.isHost = false;
    const cleanCode = sessionCode.trim().toUpperCase();
    const hostPeerId = `atxxii-host-${cleanCode.replace('-', '')}`;
    const userProfile = profileManager?.getProfile ? profileManager.getProfile() : null;
    const characterPayload = (userProfile && userProfile.character_id) ? {
      id: userProfile.character_id,
      name: userProfile.character_name,
      corporationName: userProfile.corporation_name,
      corporationTicker: userProfile.corporation_ticker,
      allianceName: userProfile.alliance_name,
      allianceTicker: userProfile.alliance_ticker,
      portraitUrl: userProfile.character_portrait_url,
      preferredRole: userProfile.preferred_role,
    } : null;
    this.localPlayerName = playerName || userProfile?.character_name || `Pilot_${generateSecret(4)}`;

    this.initBroadcastChannel(cleanCode);
    await this.initPeer(`atxxii-client-${this.localPlayerId}`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Fallback to local broadcast channel if WebRTC signaling is blocked or same-machine
        if (this.broadcastChannel) {
          this.broadcastChannel.postMessage({
            type: 'HANDSHAKE_REQUEST',
            peerId: this.localPlayerId,
            credentialKey,
            playerName: this.localPlayerName,
            reconnectToken: this.reconnectToken,
            character: characterPayload,
          });
        }
        reject(new Error('Connection to host timed out. Check session code.'));
      }, 9000);

      try {
        const onPeerError = (err) => {
          if (err.type === 'peer-unavailable') {
            clearTimeout(timeout);
            reject(new Error('SESSION NOT FOUND'));
          }
        };
        this.peer.once('error', onPeerError);

        const conn = this.peer.connect(hostPeerId, {
          reliable: true,
          serialization: 'json',
        });

        conn.on('open', () => {
          clearTimeout(timeout);
          this.coordinatorConn = conn;
          this.activeConnections.set(hostPeerId, conn);

          // Send Authentication Handshake to Coordinator
          conn.send({
            type: 'HANDSHAKE_REQUEST',
            peerId: this.localPlayerId,
            credentialKey,
            playerName: this.localPlayerName,
            reconnectToken: this.reconnectToken,
            character: characterPayload,
          });

          // Begin lightweight NTP clock sync
          this.startClockSync();
          this.startClientLivenessMonitor();
        });

        conn.on('data', (msg) => {
          this.handleIncomingMessage(msg, conn);
          if (msg.type === 'HANDSHAKE_RESPONSE') {
            clearTimeout(timeout);
            if (msg.success) {
              resolve(msg.payload);
            } else {
              reject(new Error(msg.error || 'INVALID ACCESS KEY'));
            }
          }
        });

        conn.on('close', () => {
          this.handleCoordinatorDisconnect();
        });

        conn.on('error', (err) => {
          console.warn('[NetworkManager] Coordinator conn error:', err);
        });
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
      }
    });
  }

  // ==========================================================================
  // PEERJS WEBRTC & BROADCASTCHANNEL SETUP
  // ==========================================================================
  initPeer(customId) {
    return new Promise((resolve) => {
      try {
        this.peer = new Peer(customId, {
          config: ICE_CONFIG,
          debug: 0,
        });

        this.peer.on('open', (id) => {
          console.log('[NetworkManager] WebRTC Peer connected:', id);
          resolve(id);
        });

        this.peer.on('connection', (conn) => {
          this.handleIncomingPeerConnection(conn);
        });

        this.peer.on('error', (err) => {
          console.warn('[NetworkManager] Peer error (falling back where possible):', err.type, err);
          // If ID already taken (e.g. host recreating or rejoining), retry with fallback
          if (err.type === 'unavailable-id') {
            resolve(customId);
          }
        });
      } catch (e) {
        console.warn('[NetworkManager] PeerJS initialization failed, using BroadcastChannel fallback:', e);
        resolve(null);
      }
    });
  }

  initBroadcastChannel(sessionCode) {
    if (this.broadcastChannel) {
      try { this.broadcastChannel.close(); } catch (e) {}
    }
    this.broadcastChannel = new BroadcastChannel(`atxxii_mesh_${sessionCode}`);
    this.broadcastChannel.onmessage = (evt) => {
      const msg = evt.data;
      if (msg && msg.peerId !== this.localPlayerId) {
        this.handleIncomingMessage(msg, null);
      }
    };
  }

  handleIncomingPeerConnection(conn) {
    conn.on('open', () => {
      this.activeConnections.set(conn.peer, conn);
    });

    conn.on('data', (msg) => {
      this.handleIncomingMessage(msg, conn);
    });

    conn.on('close', () => {
      this.activeConnections.delete(conn.peer);
      if (this.session) {
        this.session.removePlayer(conn.peer);
        this.broadcastState();
      }
    });
  }

  // ==========================================================================
  // MESSAGE DISPATCH & AUTHORITATIVE HANDSHAKE
  // ==========================================================================
  handleIncomingMessage(msg, conn) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      // 1. Client Handshake
      case 'HANDSHAKE_REQUEST': {
        if (!this.session) return;
        const reg = this.session.registerPlayer({
          peerId: msg.peerId,
          name: msg.playerName,
          credentialKey: msg.credentialKey,
          reconnectToken: msg.reconnectToken,
          character: msg.character,
        });

        const responseMsg = {
          type: 'HANDSHAKE_RESPONSE',
          success: reg.success,
          payload: reg.success ? {
            player: reg.player,
            isReconnect: reg.isReconnect,
            snapshot: (reg.player?.role === 'CAPTAIN_B')
              ? this.session.getCoordinatorSnapshot()
              : this.session.getPublicSnapshot(),
          } : null,
          error: reg.error,
        };

        if (conn) conn.send(responseMsg);
        if (this.broadcastChannel) this.broadcastChannel.postMessage(responseMsg);

        if (reg.success) {
          this.broadcastState();
          this.emit('player_joined', reg.player);
        }
        break;
      }

      case 'HANDSHAKE_RESPONSE': {
        if (msg.success && msg.payload) {
          const { player, snapshot } = msg.payload;
          this.localRole = player.role;
          this.localTeam = player.team;
          this.reconnectToken = player.reconnectToken;
          this.clientSessionToken = player.clientSessionToken;
          sessionStorage.setItem('atxxii_reconnect_token', this.reconnectToken);
          sessionStorage.setItem('atxxii_client_token', this.clientSessionToken);

          if (!this.session) {
            this.session = new ScrimSession();
          }
          this.session.applySnapshot(snapshot);
          this.emit('session_joined', { player, snapshot: this.session.getPublicSnapshot() });
        } else if (msg.error) {
          this.emit('error', msg.error);
          this.emit('join_failed', msg.error);
        }
        break;
      }

      // 2. Full State Synchronization
      case 'STATE_SYNC': {
        if (this.session) {
          this.session.applySnapshot(msg.snapshot);
          this.emit('state_updated', this.session.getPublicSnapshot());
        }
        break;
      }

      // 3. NTP Clock Synchronization (Phase 10)
      case 'CLOCK_PING': {
        const pong = {
          type: 'CLOCK_PONG',
          clientSendTime: msg.clientSendTime,
          serverDateNow: Date.now(),
        };
        if (conn) conn.send(pong);
        else if (this.broadcastChannel) this.broadcastChannel.postMessage(pong);
        break;
      }

      case 'CLOCK_PONG': {
        this.processClockPong(msg);
        break;
      }

      // 4. Ban Submission (Phase 8)
      case 'SUBMIT_BAN': {
        if (this.isHost || this.session.primaryCoordinator === this.localRole) {
          const player = this.session.players.get(msg.peerId);
          if (!player || (player.clientSessionToken && player.clientSessionToken !== msg.clientSessionToken)) {
            if (conn) conn.send({ type: 'ACTION_REJECTED', reason: 'Invalid or expired client session token.' });
            return;
          }
          const result = this.session.applyBan(player, msg.ship);
          if (result.allowed) {
            this.broadcastMessage({
              type: 'BAN_ACCEPTED',
              payload: result,
              snapshot: this.session.getPublicSnapshot(),
            });
            this.emit('ban_accepted', result);
          } else {
            if (conn) conn.send({ type: 'ACTION_REJECTED', reason: result.reason });
          }
        }
        break;
      }

      case 'BAN_ACCEPTED': {
        if (this.session) {
          this.session.applySnapshot(msg.snapshot);
          this.emit('ban_accepted', msg.payload);
        }
        break;
      }

      // 5. Flagship Designation
      case 'SUBMIT_FLAGSHIP': {
        if (this.isHost || this.session.primaryCoordinator === this.localRole) {
          const player = this.session.players.get(msg.peerId);
          if (!player || (player.clientSessionToken && player.clientSessionToken !== msg.clientSessionToken)) {
            if (conn) conn.send({ type: 'ACTION_REJECTED', reason: 'Invalid or expired client session token.' });
            return;
          }
          const result = this.session.applyFlagship(player, msg.targetTeam, msg.ship);
          if (result.allowed) {
            this.broadcastMessage({
              type: 'FLAGSHIP_ACCEPTED',
              payload: { targetTeam: msg.targetTeam, ship: msg.ship },
              snapshot: this.session.getPublicSnapshot(),
            });
            this.emit('flagship_accepted', { targetTeam: msg.targetTeam, ship: msg.ship });
          } else {
            if (conn) conn.send({ type: 'ACTION_REJECTED', reason: result.reason });
          }
        }
        break;
      }

      case 'FLAGSHIP_ACCEPTED': {
        if (this.session) {
          this.session.applySnapshot(msg.snapshot);
          this.emit('flagship_accepted', msg.payload);
        }
        break;
      }

      // 6a. Fleet Comp Slot Update
      case 'SUBMIT_COMP': {
        if (this.isHost || this.session.primaryCoordinator === this.localRole) {
          const player = this.session.players.get(msg.peerId);
          if (!player || (player.clientSessionToken && player.clientSessionToken !== msg.clientSessionToken)) {
            if (conn) conn.send({ type: 'ACTION_REJECTED', reason: 'Invalid or expired client session token.' });
            return;
          }
          const result = this.session.applyComp(player, msg.targetTeam, msg.slotIndex, msg.ship);
          if (result.allowed) {
            this.broadcastMessage({
              type: 'COMP_ACCEPTED',
              payload: result,
              snapshot: this.session.getPublicSnapshot(),
            });
            this.emit('comp_accepted', result);
          } else {
            if (conn) conn.send({ type: 'ACTION_REJECTED', reason: result.reason });
          }
        }
        break;
      }

      case 'SUBMIT_CLEAR_COMP': {
        if (this.isHost || this.session.primaryCoordinator === this.localRole) {
          const player = this.session.players.get(msg.peerId);
          if (!player || (player.clientSessionToken && player.clientSessionToken !== msg.clientSessionToken)) {
            if (conn) conn.send({ type: 'ACTION_REJECTED', reason: 'Invalid or expired client session token.' });
            return;
          }
          const result = this.session.clearComp(player, msg.targetTeam);
          if (result.allowed) {
            this.broadcastMessage({
              type: 'COMP_ACCEPTED',
              payload: result,
              snapshot: this.session.getPublicSnapshot(),
            });
            this.emit('comp_accepted', result);
          } else {
            if (conn) conn.send({ type: 'ACTION_REJECTED', reason: result.reason });
          }
        }
        break;
      }

      case 'COMP_ACCEPTED': {
        if (this.session) {
          this.session.applySnapshot(msg.snapshot);
          this.emit('comp_accepted', msg.payload);
        }
        break;
      }

      // 6. Warmup & Start Timestamp (Phase 9 & 11)
      case 'WARMUP_START': {
        if (this.session) {
          this.session.matchTiming = msg.timing;
          this.emit('warmup_started', msg.timing);
        }
        break;
      }

      // 7. Resign (Phase 12)
      case 'RESIGN_MATCH': {
        if (this.isHost || this.session.primaryCoordinator === this.localRole) {
          const player = this.session.players.get(msg.peerId);
          if (!player || (player.clientSessionToken && player.clientSessionToken !== msg.clientSessionToken)) {
            if (conn) conn.send({ type: 'ACTION_REJECTED', reason: 'Invalid or expired client session token.' });
            return;
          }
          const result = this.session.resignMatch(player, msg.targetTeam);
          if (result.allowed) {
            this.broadcastMessage({
              type: 'MATCH_RESIGNED',
              timing: this.session.matchTiming,
            });
            this.emit('match_resigned', this.session.matchTiming);
          }
        }
        break;
      }

      case 'SESSION_CLOSED': {
        if (this.session) {
          this.session.applySnapshot(msg.snapshot);
          this.emit('session_closed', msg.snapshot);
        }
        break;
      }

      case 'MATCH_RESIGNED': {
        if (this.session) {
          this.session.matchTiming = msg.timing;
          this.emit('match_resigned', msg.timing);
        }
        break;
      }

      case 'RESET_MATCH': {
        if (this.session) {
          this.session.resetMatch();
          this.emit('match_reset', this.session.matchTiming);
        }
        break;
      }

      // 8. Coordinator Heartbeat & Liveness (Phase 5 & 13)
      case 'COORDINATOR_HEARTBEAT': {
        this.lastCoordinatorHeartbeat = Date.now();
        this.missedHeartbeats = 0;
        if (this.session) {
          this.session.primaryCoordinator = msg.primaryCoordinator;
        }
        break;
      }

      case 'ACTION_REJECTED': {
        this.emit('action_rejected', msg.reason);
        break;
      }

      case 'SESSION_CLOSED': {
        if (this.session) {
          this.session.applySnapshot(msg.snapshot);
        }
        this.emit('session_closed', msg.snapshot);
        break;
      }
    }
  }

  // ==========================================================================
  // PHASE 9, 10 & 11: NTP CLOCK SYNC & LOCAL MONOTONIC CLOCK
  // ==========================================================================
  startClockSync() {
    this.clockSyncSamples = [];
    let count = 0;
    const interval = setInterval(() => {
      this.sendToCoordinator({
        type: 'CLOCK_PING',
        clientSendTime: performance.now(),
      });
      count++;
      if (count >= 5) clearInterval(interval);
    }, 400);
  }

  processClockPong(pong) {
    const clientReceiveTime = performance.now();
    const rtt = clientReceiveTime - pong.clientSendTime;
    const serverTimeEstimate = pong.serverDateNow + (rtt / 2);
    const offset = serverTimeEstimate - Date.now();

    this.clockSyncSamples.push({ rtt, offset });
    if (this.clockSyncSamples.length >= 3) {
      // Pick the sample with the lowest round-trip time (least network jitter)
      this.clockSyncSamples.sort((a, b) => a.rtt - b.rtt);
      const best = this.clockSyncSamples[0];
      this.clockOffsetMs = Math.round(best.offset);
      this.clockRoundTripMs = Math.round(best.rtt);

      if (Math.abs(this.clockOffsetMs) < 50) this.clockSyncStatus = 'GOOD';
      else if (Math.abs(this.clockOffsetMs) < 150) this.clockSyncStatus = 'FAIR';
      else this.clockSyncStatus = 'POOR';

      this.emit('clock_synced', {
        offsetMs: this.clockOffsetMs,
        rttMs: this.clockRoundTripMs,
        status: this.clockSyncStatus,
      });
    }
  }

  // Returns synchronized UTC moment
  getCorrectedNow() {
    return Date.now() + this.clockOffsetMs;
  }

  // ==========================================================================
  // PHASE 5, 13 & 14: DETERMINISTIC FAILOVER & HEARTBEATS
  // ==========================================================================
  startHostHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.broadcastMessage({
        type: 'COORDINATOR_HEARTBEAT',
        primaryCoordinator: this.session ? this.session.primaryCoordinator : 'CAPTAIN_A',
        timestamp: Date.now(),
      });
    }, 2000);
  }

  startClientLivenessMonitor() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      const elapsedSinceHeartbeat = Date.now() - this.lastCoordinatorHeartbeat;
      if (elapsedSinceHeartbeat > 6000) {
        this.missedHeartbeats++;
        // If local client is Captain B, initiate deterministic failover!
        if (this.localRole === 'CAPTAIN_B' && !this.isFailoverActive) {
          this.executeCaptainBFailover();
        } else {
          this.emit('coordinator_lost', {
            coordinator: this.session?.primaryCoordinator,
            failoverReady: (this.localRole === 'CAPTAIN_B'),
          });
        }
      }
    }, 2000);
  }

  executeCaptainBFailover() {
    this.isFailoverActive = true;
    if (this.session) {
      this.session.promoteCaptainB();
    }
    this.startHostHeartbeat();
    this.broadcastMessage({
      type: 'COORDINATOR_HEARTBEAT',
      primaryCoordinator: 'CAPTAIN_B',
      isFailover: true,
      timestamp: Date.now(),
    });
    this.emit('failover_activated', { primaryCoordinator: 'CAPTAIN_B' });
  }

  handleCoordinatorDisconnect() {
    if (this.localRole === 'CAPTAIN_B' && !this.isFailoverActive) {
      this.executeCaptainBFailover();
    }
  }

  // ==========================================================================
  // AUTHORITATIVE ACTIONS
  // ==========================================================================
  sendBan(ship) {
    if (this.isHost || this.session?.primaryCoordinator === this.localRole) {
      const player = this.session.players.get(this.localPlayerId);
      const res = this.session.applyBan(player, ship);
      if (res.allowed) {
        this.broadcastMessage({
          type: 'BAN_ACCEPTED',
          payload: res,
          snapshot: this.session.getPublicSnapshot(),
        });
        this.emit('ban_accepted', res);
      }
      return res;
    } else {
      this.sendToCoordinator({
        type: 'SUBMIT_BAN',
        peerId: this.localPlayerId,
        clientSessionToken: this.clientSessionToken,
        ship,
      });
      return { pending: true };
    }
  }

  sendFlagship(targetTeam, ship) {
    if (this.isHost || this.session?.primaryCoordinator === this.localRole) {
      const player = this.session.players.get(this.localPlayerId);
      const res = this.session.applyFlagship(player, targetTeam, ship);
      if (res.allowed) {
        this.broadcastMessage({
          type: 'FLAGSHIP_ACCEPTED',
          payload: { targetTeam, ship },
          snapshot: this.session.getPublicSnapshot(),
        });
        this.emit('flagship_accepted', { targetTeam, ship });
      }
      return res;
    } else {
      this.sendToCoordinator({
        type: 'SUBMIT_FLAGSHIP',
        peerId: this.localPlayerId,
        clientSessionToken: this.clientSessionToken,
        targetTeam,
        ship,
      });
      return { pending: true };
    }
  }

  sendComp(targetTeam, slotIndex, ship) {
    if (this.isHost || this.session?.primaryCoordinator === this.localRole) {
      const player = this.session.players.get(this.localPlayerId);
      const res = this.session.applyComp(player, targetTeam, slotIndex, ship);
      if (res.allowed) {
        this.broadcastMessage({
          type: 'COMP_ACCEPTED',
          payload: res,
          snapshot: this.session.getPublicSnapshot(),
        });
        this.emit('comp_accepted', res);
      }
      return res;
    } else {
      this.sendToCoordinator({
        type: 'SUBMIT_COMP',
        peerId: this.localPlayerId,
        clientSessionToken: this.clientSessionToken,
        targetTeam,
        slotIndex,
        ship,
      });
      return { pending: true };
    }
  }

  sendClearComp(targetTeam) {
    if (this.isHost || this.session?.primaryCoordinator === this.localRole) {
      const player = this.session.players.get(this.localPlayerId);
      const res = this.session.clearComp(player, targetTeam);
      if (res.allowed) {
        this.broadcastMessage({
          type: 'COMP_ACCEPTED',
          payload: res,
          snapshot: this.session.getPublicSnapshot(),
        });
        this.emit('comp_accepted', res);
      }
      return res;
    } else {
      this.sendToCoordinator({
        type: 'SUBMIT_CLEAR_COMP',
        peerId: this.localPlayerId,
        clientSessionToken: this.clientSessionToken,
        targetTeam,
      });
      return { pending: true };
    }
  }

  triggerWarmupStart(durationSeconds = 60) {
    const isCoordinator = (this.isHost && this.session?.primaryCoordinator === 'CAPTAIN_A') ||
                          (this.session?.primaryCoordinator === this.localRole);
    if (!isCoordinator) {
      return { allowed: false, reason: 'Only the session coordinator can start the match.' };
    }

    const timing = this.session.startWarmup(durationSeconds);
    this.broadcastMessage({
      type: 'WARMUP_START',
      timing,
    });
    this.emit('warmup_started', timing);
    return { allowed: true, timing };
  }

  triggerResign(targetTeam) {
    if (this.isHost || this.session?.primaryCoordinator === this.localRole) {
      const player = this.session.players.get(this.localPlayerId);
      const res = this.session.resignMatch(player, targetTeam);
      if (res.allowed) {
        this.broadcastMessage({
          type: 'MATCH_RESIGNED',
          timing: this.session.matchTiming,
        });
        this.emit('match_resigned', this.session.matchTiming);
      }
      return res;
    } else {
      this.sendToCoordinator({
        type: 'RESIGN_MATCH',
        peerId: this.localPlayerId,
        clientSessionToken: this.clientSessionToken,
        targetTeam,
      });
      return { pending: true };
    }
  }

  triggerResetMatch() {
    if (this.isHost || this.session?.primaryCoordinator === this.localRole) {
      const timing = this.session.resetMatch();
      this.broadcastMessage({
        type: 'RESET_MATCH',
        timing,
      });
      this.emit('match_reset', timing);
      return { allowed: true };
    }
    return { allowed: false, reason: 'Only the coordinator can reset the match.' };
  }

  // ==========================================================================
  // BROADCAST & TRANSPORT HELPERS
  // ==========================================================================
  broadcastState() {
    if (!this.session) return;
    const snapshot = this.session.getPublicSnapshot();
    const coordinatorSnapshot = this.session.getCoordinatorSnapshot();

    this.activeConnections.forEach((conn) => {
      const player = this.session.players.get(conn.peer);
      const isCoHost = (player && player.role === 'CAPTAIN_B');
      conn.send({
        type: 'STATE_SYNC',
        snapshot: isCoHost ? coordinatorSnapshot : snapshot,
      });
    });

    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'STATE_SYNC',
        snapshot,
      });
    }

    this.emit('state_updated', snapshot);
  }

  broadcastMessage(msg) {
    this.activeConnections.forEach((conn) => {
      try { conn.send(msg); } catch (e) {}
    });
    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage(msg);
    }
  }

  sendToCoordinator(msg) {
    if (this.coordinatorConn && this.coordinatorConn.open) {
      this.coordinatorConn.send(msg);
    } else if (this.broadcastChannel) {
      this.broadcastChannel.postMessage(msg);
    }
  }

  // ==========================================================================
  // INVITATION & CREDENTIAL GENERATORS (at22:// Custom Protocol)
  // ==========================================================================
  generateJoinUrl(role = 'SPECTATOR') {
    if (!this.session) return 'at22://join';
    const code = this.session.sessionCode;
    const creds = this.session.credentials;
    let key = creds.spectatorKey;

    switch (role) {
      case 'REFEREE':
        key = creds.refereeKey;
        break;
      case 'CAPTAIN_B':
        key = creds.captainBKey;
        break;
      case 'TEAM_A':
        key = creds.teamAKey;
        break;
      case 'TEAM_B':
        key = creds.teamBKey;
        break;
      case 'CLEANER':
        key = creds.cleanerKey;
        break;
      case 'SPECTATOR':
      default:
        key = creds.spectatorKey;
        break;
    }

    return `at22://join?session=${code}&key=${key}`;
  }

  generateFleetChatInvite() {
    if (!this.session) return '';
    const code = this.session.sessionCode;
    const teamAName = this.session.teams?.teamA?.name || 'BLUE FLEET';
    const teamBName = this.session.teams?.teamB?.name || 'RED FLEET';

    return `════════════════════════════════════════════
⚔️ ATXXII SCRIM SESSION: ${code}
${teamAName} vs ${teamBName}
════════════════════════════════════════════

🛡️ TOURNAMENT REFEREE / MARSHAL:
${this.generateJoinUrl('REFEREE')}

👑 CAPTAIN B (CO-HOST):
${this.generateJoinUrl('CAPTAIN_B')}

🔷 ${teamAName} (PILOTS & RESERVES):
${this.generateJoinUrl('TEAM_A')}

🔶 ${teamBName} (PILOTS & RESERVES):
${this.generateJoinUrl('TEAM_B')}

🧹 ARENA RING CLEANERS:
${this.generateJoinUrl('CLEANER')}

👁️ SPECTATORS & OBSERVERS:
${this.generateJoinUrl('SPECTATOR')}

════════════════════════════════════════════
⚡ Automatic clock synchronization
⚡ Floating Pop-out HUD
⚡ Always-on-Top over EVE client`;
  }

  rotateRoleInvite(role) {
    if (!this.session) return null;
    const res = this.session.rotateCredential(role);
    if (res) {
      this.broadcastState();
      this.emit('credentials_rotated', res);
    }
    return res;
  }

  closeSession() {
    if (!this.session) return false;
    this.session.closeSession();
    this.broadcastMessage({
      type: 'SESSION_CLOSED',
      snapshot: this.session.getPublicSnapshot(),
    });
    this.emit('session_closed', this.session.getPublicSnapshot());
    return true;
  }

  destroy() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.broadcastChannel) {
      try { this.broadcastChannel.close(); } catch (e) {}
    }
    if (this.peer) {
      try { this.peer.destroy(); } catch (e) {}
    }
    this.activeConnections.clear();
  }
}
