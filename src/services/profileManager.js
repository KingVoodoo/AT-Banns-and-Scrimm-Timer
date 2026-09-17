// ATXXII Local Profile Manager
// Handles local user profile, public EVE Online ESI character lookup, and local caching.
// PRIVACY & SECURITY GUARANTEE:
// - Uses only public ESI endpoints (no OAuth, no private scopes, no login tokens).
// - Stores data strictly in local storage (no cloud DB, no tracking).
// - preferred_role is strictly a local UI default and NEVER grants live session authority.

const STORAGE_KEY = 'atxxii_profile';
const ESI_BASE = 'https://esi.evetech.net/latest';
const IMAGES_BASE = 'https://images.evetech.net';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class ProfileManager {
  constructor() {
    this.profile = this.loadProfile();
  }

  // Load profile from localStorage or return default empty profile
  loadProfile() {
    if (typeof localStorage === 'undefined') {
      return {
        setup_complete: false,
        preferred_role: 'MEMBER',
        character_id: null,
        character_name: '',
        character_portrait_url: '',
        corporation_id: null,
        corporation_name: '',
        corporation_ticker: '',
        alliance_id: null,
        alliance_name: null,
        alliance_ticker: null,
        last_refreshed: 0,
      };
    }
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return {
            setup_complete: Boolean(parsed.setup_complete),
            preferred_role: parsed.preferred_role || 'MEMBER',
            character_id: parsed.character_id || null,
            character_name: parsed.character_name || '',
            character_portrait_url: parsed.character_portrait_url || '',
            corporation_id: parsed.corporation_id || null,
            corporation_name: parsed.corporation_name || '',
            corporation_ticker: parsed.corporation_ticker || '',
            alliance_id: parsed.alliance_id || null,
            alliance_name: parsed.alliance_name || null,
            alliance_ticker: parsed.alliance_ticker || null,
            last_refreshed: parsed.last_refreshed || 0,
          };
        }
      }
    } catch (e) {
      console.warn('[ProfileManager] Failed to parse stored profile:', e);
    }

    return {
      setup_complete: false,
      preferred_role: 'MEMBER', // 'CAPTAIN' | 'MEMBER' | 'REFEREE'
      character_id: null,
      character_name: '',
      character_portrait_url: '',
      corporation_id: null,
      corporation_name: '',
      corporation_ticker: '',
      alliance_id: null,
      alliance_name: null,
      alliance_ticker: null,
      last_refreshed: 0,
    };
  }

  // Save current profile to localStorage
  saveProfile(updatedProfile = null) {
    if (updatedProfile) {
      this.profile = { ...this.profile, ...updatedProfile };
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.profile));
    } catch (e) {
      console.error('[ProfileManager] Failed to write profile to localStorage:', e);
    }
    return this.profile;
  }

  isSetupComplete() {
    return Boolean(this.profile && this.profile.setup_complete && this.profile.character_id);
  }

  getProfile() {
    return { ...this.profile };
  }

  // Update preferred role without requiring a character lookup
  setPreferredRole(role) {
    const valid = ['CAPTAIN', 'MEMBER', 'REFEREE'];
    if (!valid.includes(role)) return false;
    this.profile.preferred_role = role;
    this.saveProfile();
    return true;
  }

  // Clear profile to rerun first-run setup
  resetProfile() {
    this.profile = {
      setup_complete: false,
      preferred_role: 'MEMBER',
      character_id: null,
      character_name: '',
      character_portrait_url: '',
      corporation_id: null,
      corporation_name: '',
      corporation_ticker: '',
      alliance_id: null,
      alliance_name: null,
      alliance_ticker: null,
      last_refreshed: 0,
    };
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {}
    return this.profile;
  }

  // Public EVE Online ESI Lookup
  // Resolves character name -> character_id -> corp -> alliance -> portrait
  async lookupCharacter(rawName) {
    if (!rawName || typeof rawName !== 'string' || !rawName.trim()) {
      throw new Error('Please enter a valid character name.');
    }
    const cleanName = rawName.trim();

    // 1. Resolve Character Name to ID via universe/ids/
    let idRes;
    try {
      idRes = await fetch(`${ESI_BASE}/universe/ids/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify([cleanName]),
      });
    } catch (netErr) {
      console.warn('[ProfileManager] ESI network error:', netErr);
      throw new Error('CHECK YOUR CONNECTION AND TRY AGAIN');
    }

    if (!idRes.ok) {
      if (idRes.status >= 500) throw new Error('ESI TEMPORARILY UNAVAILABLE');
      throw new Error('CHARACTER NOT FOUND');
    }

    const idData = await idRes.json();
    const characters = idData.characters || [];
    if (characters.length === 0) {
      throw new Error('CHARACTER NOT FOUND');
    }

    const charInfo = characters[0];
    const characterId = charInfo.id;
    const characterName = charInfo.name;

    // 2. Fetch Character Details (Corporation & optional Alliance)
    let charDetailRes;
    try {
      charDetailRes = await fetch(`${ESI_BASE}/characters/${characterId}/`, {
        headers: { 'Accept': 'application/json' },
      });
    } catch (e) {
      throw new Error('CHECK YOUR CONNECTION AND TRY AGAIN');
    }

    if (!charDetailRes.ok) {
      throw new Error('ESI TEMPORARILY UNAVAILABLE');
    }

    const charDetail = await charDetailRes.json();
    const corporationId = charDetail.corporation_id;
    const allianceId = charDetail.alliance_id || null;

    // 3. Fetch Corporation Info
    let corpName = 'Unknown Corporation';
    let corpTicker = 'CORP';
    if (corporationId) {
      try {
        const corpRes = await fetch(`${ESI_BASE}/corporations/${corporationId}/`, {
          headers: { 'Accept': 'application/json' },
        });
        if (corpRes.ok) {
          const corpData = await corpRes.json();
          corpName = corpData.name || corpName;
          corpTicker = corpData.ticker || corpTicker;
        }
      } catch (e) {
        console.warn('[ProfileManager] Corp lookup warning:', e);
      }
    }

    // 4. Fetch Alliance Info if present
    let allianceName = null;
    let allianceTicker = null;
    if (allianceId) {
      try {
        const alliRes = await fetch(`${ESI_BASE}/alliances/${allianceId}/`, {
          headers: { 'Accept': 'application/json' },
        });
        if (alliRes.ok) {
          const alliData = await alliRes.json();
          allianceName = alliData.name || null;
          allianceTicker = alliData.ticker || null;
        }
      } catch (e) {
        console.warn('[ProfileManager] Alliance lookup warning:', e);
      }
    }

    const portraitUrl = `${IMAGES_BASE}/characters/${characterId}/portrait?size=128`;

    return {
      character_id: characterId,
      character_name: characterName,
      character_portrait_url: portraitUrl,
      corporation_id: corporationId,
      corporation_name: corpName,
      corporation_ticker: corpTicker,
      alliance_id: allianceId,
      alliance_name: allianceName,
      alliance_ticker: allianceTicker,
      last_refreshed: Date.now(),
    };
  }

  // Refresh profile details from ESI if cache expired or force is true
  async refreshProfile(force = false) {
    if (!this.profile.character_id || !this.profile.character_name) return this.profile;

    const now = Date.now();
    if (!force && (now - this.profile.last_refreshed < CACHE_TTL_MS)) {
      return this.profile; // Cache still valid
    }

    try {
      const refreshed = await this.lookupCharacter(this.profile.character_name);
      this.profile = {
        ...this.profile,
        ...refreshed,
        setup_complete: true,
      };
      this.saveProfile();
      return this.profile;
    } catch (err) {
      console.warn('[ProfileManager] Background refresh failed, keeping cached profile:', err.message);
      return this.profile;
    }
  }

  // Generate compact display string e.g. "King Voodoo [WOK] / [NAGA]"
  getFormattedIdentity(short = false) {
    if (!this.profile.character_name) return 'UNIDENTIFIED PILOT';
    const corpPart = this.profile.corporation_ticker ? `[${this.profile.corporation_ticker}]` : '';
    const alliPart = this.profile.alliance_ticker ? `[${this.profile.alliance_ticker}]` : '';

    if (short) {
      if (corpPart && alliPart) return `${this.profile.character_name} ${corpPart}/${alliPart}`;
      if (corpPart) return `${this.profile.character_name} ${corpPart}`;
      return this.profile.character_name;
    }

    let out = this.profile.character_name;
    if (this.profile.corporation_name) {
      out += ` • ${this.profile.corporation_name} ${corpPart}`;
    }
    if (this.profile.alliance_name) {
      out += ` / ${this.profile.alliance_name} ${alliPart}`;
    }
    return out;
  }
}

export const profileManager = new ProfileManager();
