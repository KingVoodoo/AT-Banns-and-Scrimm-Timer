// Automated Verification Script for at22:// Protocol & Session Security
import { parseDeepLink } from '../src/services/networkManager.js';
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

console.log('--- 1. Testing parseDeepLink (at22://) ---');

// Valid deep link
const valid1 = parseDeepLink('at22://join?session=AT22-X7KF&key=k9f201az81mb');
assert(valid1.valid === true, 'Valid link parsed successfully');
assert(valid1.sessionCode === 'AT22-X7KF', 'Correct sessionCode extracted');
assert(valid1.credentialKey === 'k9f201az81mb', 'Correct credentialKey extracted');

// Case insensitivity
const valid2 = parseDeepLink('AT22://JOIN?SESSION=AT22-X7KF&KEY=k9f201az81mb');
assert(valid2.valid === true, 'Case-insensitive scheme and action parsed');
assert(valid2.sessionCode === 'AT22-X7KF', 'Session code uppercased');

// Extra / tampered parameters (e.g. attacker claiming role=REFEREE)
const tampered = parseDeepLink('at22://join?session=AT22-X7KF&key=k9f201az81mb&role=REFEREE&admin=true');
assert(tampered.valid === true, 'Tampered query params accepted without breaking');
assert(!('role' in tampered), 'No role parameter accepted from deep link');
assert(!('admin' in tampered), 'No admin parameter accepted from deep link');

// Invalid scheme
const badScheme = parseDeepLink('http://join?session=AT22-X7KF&key=k9f201az81mb');
assert(badScheme.valid === false && badScheme.error === 'INVALID_SCHEME', 'Non-at22 scheme rejected');

// Invalid action
const badAction = parseDeepLink('at22://delete?session=AT22-X7KF&key=k9f201az81mb');
assert(badAction.valid === false && badAction.error === 'INVALID_ACTION', 'Non-join action rejected');

// Missing parameters
const missingKey = parseDeepLink('at22://join?session=AT22-X7KF');
assert(missingKey.valid === false && missingKey.error === 'MISSING_PARAMETERS', 'Missing key rejected');

// Invalid session code format
const badCode = parseDeepLink('at22://join?session=NOT-A-SESSION&key=k9f201az81mb');
assert(badCode.valid === false && badCode.error === 'INVALID_SESSION_FORMAT', 'Malformed session format rejected');

// Invalid key characters
const badKey = parseDeepLink('at22://join?session=AT22-X7KF&key=invalid$key!');
assert(badKey.valid === false && badKey.error === 'INVALID_KEY_FORMAT', 'Special characters in key rejected');


console.log('\n--- 2. Testing ScrimSession Secret-to-Role Resolution ---');
const session = new ScrimSession({
  teamA: { name: 'Northern Coalition', captain: 'Captain A' },
  teamB: { name: 'Goonswarm Federation', captain: 'Captain B' },
});

assert(session.sessionCode.startsWith('AT22-'), 'Valid sessionCode generated');
assert(session.credentials.refereeKey.length >= 10, 'Referee key generated');
assert(session.credentials.captainBKey.length >= 10, 'Captain B key generated');
assert(session.credentials.teamAKey.length >= 10, 'Team A key generated');
assert(session.credentials.teamBKey.length >= 10, 'Team B key generated');
assert(session.credentials.cleanerKey.length >= 10, 'Cleaner key generated');
assert(session.credentials.spectatorKey.length >= 10, 'Spectator key generated');

// Handshake with Team A Key
const regA = session.registerPlayer({
  peerId: 'peer_team_a_pilot',
  name: 'Pilot A1',
  credentialKey: session.credentials.teamAKey,
});
assert(regA.success === true, 'Team A player registration succeeded');
assert(regA.player.role === 'PILOT_A' && regA.player.team === 'TEAM_A', 'Role derived strictly as PILOT_A / TEAM_A from secret key');
assert(regA.player.team === 'TEAM_A', 'Team mapped to TEAM_A');
assert(typeof regA.player.clientSessionToken === 'string' && regA.player.clientSessionToken.length >= 16, 'Issued clientSessionToken');

// Handshake with Captain B Key
const regB = session.registerPlayer({
  peerId: 'peer_captain_b',
  name: 'Captain B',
  credentialKey: session.credentials.captainBKey,
});
assert(regB.success === true, 'Captain B player registration succeeded');
assert(regB.player.role === 'CAPTAIN_B', 'Role derived strictly as CAPTAIN_B');
assert(regB.player.isCoHost === true, 'Co-host flag set for Captain B');

// Handshake with invalid key
const regInvalid = session.registerPlayer({
  peerId: 'peer_intruder',
  name: 'Intruder',
  credentialKey: 'wrong_secret_key',
});
assert(regInvalid.success === false, 'Invalid secret key rejected');
assert(regInvalid.error === 'INVALID ACCESS KEY', 'Correct error message returned: INVALID ACCESS KEY');


console.log('\n--- 3. Testing Credential Key Rotation ---');
const oldTeamAKey = session.credentials.teamAKey;
const rotatedRes = session.rotateCredential('TEAM_A');
const rotatedKey = rotatedRes.newKey;
assert(rotatedKey !== oldTeamAKey, 'New Team A key generated');
assert(session.credentials.teamAKey === rotatedKey, 'Session credentials updated with new key');

// Existing connected player is NOT kicked
const activePilot = session.players.get('peer_team_a_pilot');
assert(activePilot && activePilot.connected === true, 'Active player remains connected after rotation');

// Attempting to join with old key is rejected
const regOldKey = session.registerPlayer({
  peerId: 'peer_late_pilot',
  name: 'Late Pilot',
  credentialKey: oldTeamAKey,
});
assert(regOldKey.success === false, 'Old rotated key rejected');

// Joining with new rotated key succeeds
const regNewKey = session.registerPlayer({
  peerId: 'peer_new_pilot',
  name: 'New Pilot',
  credentialKey: rotatedKey,
});
assert(regNewKey.success === true && regNewKey.player.team === 'TEAM_A', 'New rotated key connects successfully');


console.log('\n--- 4. Testing Session Close ---');
session.closeSession();
assert(session.isClosed === true, 'Session marked closed');
assert(session.credentials.teamAKey === null, 'Credentials cleared on session close');

const regClosed = session.registerPlayer({
  peerId: 'peer_post_close',
  name: 'Post Close Pilot',
  credentialKey: rotatedKey,
});
assert(regClosed.success === false, 'Joining closed session rejected');
assert(regClosed.error === 'SESSION CLOSED', 'Correct error returned: SESSION CLOSED');

console.log(`\n========================================`);
console.log(`Results: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('All automated tests PASSED successfully!');
}
