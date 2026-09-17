// Automated Test Matrix for First-Run Profile & Public ESI Integration
import { ProfileManager } from '../src/services/profileManager.js';
import { ScrimSession } from '../src/services/scrimSession.js';

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  ✅ PASS: ${testName}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${testName}`);
    failed++;
  }
}

// Mock localStorage for Node.js test environment if not present
if (typeof localStorage === 'undefined' || !localStorage.getItem) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) || null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

async function runTests() {
  console.log('--- 1. Testing Local Profile Manager Model & Persistence ---');
  const pm = new ProfileManager();
  pm.resetProfile();

  assert(pm.isSetupComplete() === false, 'Fresh profile reports setup_complete === false');
  assert(pm.getProfile().preferred_role === 'MEMBER', 'Default preferred role is MEMBER');

  pm.setPreferredRole('CAPTAIN');
  assert(pm.getProfile().preferred_role === 'CAPTAIN', 'Preferred role changed to CAPTAIN');

  pm.setPreferredRole('REFEREE');
  assert(pm.getProfile().preferred_role === 'REFEREE', 'Preferred role changed to REFEREE');

  // Save profile
  pm.saveProfile({
    setup_complete: true,
    character_id: 90288280,
    character_name: 'King Voodoo',
    character_portrait_url: 'https://images.evetech.net/characters/90288280/portrait?size=128',
    corporation_id: 98765,
    corporation_name: 'Wok the Dog',
    corporation_ticker: 'WOK',
    alliance_id: 12345,
    alliance_name: 'NAGA Please',
    alliance_ticker: 'NAGA',
  });

  assert(pm.isSetupComplete() === true, 'Profile reports setup_complete === true');
  assert(pm.getFormattedIdentity(true).includes('King Voodoo'), 'Formatted short identity includes character name');
  assert(pm.getFormattedIdentity(true).includes('[WOK]'), 'Formatted identity includes corp ticker');
  assert(pm.getFormattedIdentity(true).includes('[NAGA]'), 'Formatted identity includes alliance ticker');

  // Persistence reload
  const pmReloaded = new ProfileManager();
  assert(pmReloaded.isSetupComplete() === true, 'Saved profile reloaded from storage');
  assert(pmReloaded.getProfile().character_id === 90288280, 'Character ID persisted correctly');


  console.log('\n--- 2. Testing Live Public ESI Character Lookup ---');
  try {
    const charData = await pm.lookupCharacter('King Voodoo');
    assert(typeof charData.character_id === 'number', 'Character ID resolved as number');
    assert(charData.character_name.toLowerCase() === 'king voodoo', 'Character name matched');
    assert(typeof charData.corporation_name === 'string', 'Corporation name resolved');
    assert(typeof charData.corporation_ticker === 'string', 'Corporation ticker resolved');
    assert(charData.character_portrait_url.includes(String(charData.character_id)), 'Portrait URL correctly generated with character_id');
    console.log(`    Resolved Pilot: ${charData.character_name} [${charData.corporation_ticker}] ${charData.alliance_name ? 'Alli: ' + charData.alliance_name : '(No Alliance)'}`);
  } catch (err) {
    console.error('    ESI query error:', err.message);
    assert(false, `Public ESI lookup failed: ${err.message}`);
  }


  console.log('\n--- 3. Testing Public ESI Error Handling ---');
  // Non-existent character
  try {
    await pm.lookupCharacter('xyz_non_existent_eve_pilot_99998888');
    assert(false, 'Non-existent pilot should throw error');
  } catch (err) {
    assert(err.message === 'CHARACTER NOT FOUND', 'Correct error message for missing pilot: CHARACTER NOT FOUND');
  }

  // Empty string
  try {
    await pm.lookupCharacter('   ');
    assert(false, 'Empty name should throw error');
  } catch (err) {
    assert(err.message === 'Please enter a valid character name.', 'Correct error message for empty input');
  }


  console.log('\n--- 4. Testing Security Boundary (Role Separation) ---');
  // Critical requirement:
  // User profile with preferred_role = CAPTAIN joining with a TEAM_A pilot key
  // MUST receive role PILOT_A, NOT Captain!
  const session = new ScrimSession();
  
  const pilotHandshake = session.registerPlayer({
    peerId: 'peer_pilot_test',
    name: 'King Voodoo',
    credentialKey: session.credentials.teamAKey,
    character: {
      id: 90288280,
      name: 'King Voodoo',
      preferredRole: 'CAPTAIN', // User claims to be Captain in local profile
      corporationTicker: 'WOK',
      allianceTicker: 'NAGA',
    },
  });

  assert(pilotHandshake.success === true, 'Pilot connected with teamAKey');
  assert(pilotHandshake.player.role === 'PILOT_A', 'SECURITY VERIFIED: Local preferred_role === CAPTAIN does NOT grant Captain session authority');
  assert(pilotHandshake.player.team === 'TEAM_A', 'Team mapped to TEAM_A');
  assert(pilotHandshake.player.name === 'King Voodoo', 'Display name preserved from character');
  assert(pilotHandshake.player.character.corporationTicker === 'WOK', 'Corporation ticker preserved for roster');

  // Conversely: user with preferred_role = MEMBER joining with Captain B key
  // receives CAPTAIN_B authority because of the valid credential key
  const captainHandshake = session.registerPlayer({
    peerId: 'peer_capb_test',
    name: 'Line Member',
    credentialKey: session.credentials.captainBKey,
    character: {
      id: 11223344,
      name: 'Line Member',
      preferredRole: 'MEMBER', // Local profile is member
    },
  });

  assert(captainHandshake.success === true, 'Captain B connected with captainBKey');
  assert(captainHandshake.player.role === 'CAPTAIN_B', 'SECURITY VERIFIED: Valid captainBKey grants CAPTAIN_B authority despite local preferred_role === MEMBER');
  assert(captainHandshake.player.isCoHost === true, 'Co-host flag set based on session key');

  console.log(`\n========================================`);
  console.log(`Results: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
  else console.log('All tests passed cleanly!');
}

runTests();
