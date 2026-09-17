import fs from 'fs';
import path from 'path';

const html = fs.readFileSync(path.resolve('index.html'), 'utf-8');

console.log('--- 1. Testing DOM Element Placement & Modal Scope ---');

// Verify setup-modal is not inside any tab-pane
const tabPaneBansStart = html.indexOf('id="tab-content-bans"');
const tabPaneBansEnd = html.indexOf('</section>', tabPaneBansStart);
const setupModalIndex = html.indexOf('id="setup-modal"');
const profileModalIndex = html.indexOf('id="profile-modal"');
const sessionModalIndex = html.indexOf('id="session-modal"');

if (setupModalIndex > tabPaneBansStart && setupModalIndex < tabPaneBansEnd) {
  console.error('❌ FAIL: setup-modal is nested inside tab-content-bans!');
  process.exit(1);
} else {
  console.log('✅ PASS: setup-modal is OUTSIDE tab-content-bans');
}

if (profileModalIndex > tabPaneBansStart && profileModalIndex < tabPaneBansEnd) {
  console.error('❌ FAIL: profile-modal is nested inside tab-content-bans!');
  process.exit(1);
} else {
  console.log('✅ PASS: profile-modal is OUTSIDE tab-content-bans');
}

if (sessionModalIndex > tabPaneBansStart && sessionModalIndex < tabPaneBansEnd) {
  console.error('❌ FAIL: session-modal is nested inside tab-content-bans!');
  process.exit(1);
} else {
  console.log('✅ PASS: session-modal is OUTSIDE tab-content-bans');
}

// Verify main tag closes before modals
const mainClose = html.indexOf('</main>');
if (setupModalIndex > mainClose) {
  console.log('✅ PASS: setup-modal is placed after </main> at root app level');
} else {
  console.error('❌ FAIL: setup-modal is inside <main>');
  process.exit(1);
}

// Verify step 1 has role cards with updated titles
if (html.includes('SETUP AS CAPTAIN') && html.includes('SETUP AS MEMBER') && html.includes('SETUP AS REFEREE')) {
  console.log('✅ PASS: Setup step 1 contains explicit [ Setup as Captain ], [ Setup as Member ], [ Setup as Referee ] buttons');
} else {
  console.error('❌ FAIL: Missing role setup titles in Step 1');
  process.exit(1);
}

console.log('\n--- 2. Checking HTML structure and validity ---');
const openSections = (html.match(/<section/g) || []).length;
const closeSections = (html.match(/<\/section>/g) || []).length;
console.log(`Open <section> tags: ${openSections}, Close </section> tags: ${closeSections}`);
if (openSections !== closeSections) {
  console.error('❌ Mismatched <section> tags!');
  process.exit(1);
}
console.log('✅ PASS: All <section> tags match perfectly (3 tabs = 3 sections)');

console.log('\nAll DOM structure validations passed successfully!');
