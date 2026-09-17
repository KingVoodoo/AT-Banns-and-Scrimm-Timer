import fs from 'fs';
import path from 'path';

const indexPath = path.resolve('index.html');
const content = fs.readFileSync(indexPath, 'utf-8');

// Find the section that closes bans-container:
// <div class="ship-grid" id="ship-pool-grid"></div>
//           </div>
//         </div>
const targetMarker = '            <div class="ship-grid" id="ship-pool-grid"></div>\n          </div>\n        </div>';
if (!content.includes(targetMarker)) {
  console.error('Could not find targetMarker in index.html');
  process.exit(1);
}

// Find where modals start:
// <!-- Tactical Toast Notification for Rule Alerts (e.g. Flagships immune) -->
const modalStartMarker = '        <!-- Tactical Toast Notification for Rule Alerts (e.g. Flagships immune) -->';
const modalStartIndex = content.indexOf(modalStartMarker);
if (modalStartIndex === -1) {
  console.error('Could not find modalStartMarker');
  process.exit(1);
}

// Find where profile-modal ends and </section> follows:
const modalEndMarker = '        <!-- PROFILE SETTINGS MODAL (Phase 11) -->';
const profileModalIndex = content.indexOf(modalEndMarker);
if (profileModalIndex === -1) {
  console.error('Could not find profileModalIndex');
  process.exit(1);
}

// Find the closing </div> of profile-modal:
const profileModalClose = '        </div>\n      </section>\n\n      <!-- TAB 2: TIMER VIEW -->';
const profileModalCloseIndex = content.indexOf(profileModalClose);
if (profileModalCloseIndex === -1) {
  console.error('Could not find profileModalClose');
  process.exit(1);
}

// The modals block:
const modalsContent = content.substring(modalStartIndex, profileModalCloseIndex + '        </div>'.length);

console.log('Modals content length:', modalsContent.length);

// Also update the Step 1 role cards inside modalsContent to have explicit [ Setup as Captain ], [ Setup as Member ], [ Setup as Referee ] buttons
let updatedModals = modalsContent;

// Replace step 1 cards titles if needed:
updatedModals = updatedModals.replace(
  '<div class="setup-role-name">CAPTAIN</div>',
  '<div class="setup-role-name">SETUP AS CAPTAIN</div>'
);
updatedModals = updatedModals.replace(
  '<div class="setup-role-name">MEMBER / PILOT</div>',
  '<div class="setup-role-name">SETUP AS MEMBER</div>'
);
updatedModals = updatedModals.replace(
  '<div class="setup-role-name">REFEREE / MARSHAL</div>',
  '<div class="setup-role-name">SETUP AS REFEREE</div>'
);

// Now construct the new index.html:
// 1. In the bans tab, after bans-container, insert </section>
// 2. Remove modals from the bans tab
// 3. Keep tab-content-timer intact
// 4. Place modals right after </main> before footer

const part1 = content.substring(0, content.indexOf(targetMarker) + targetMarker.length) + '\n      </section>\n\n      <!-- TAB 3: TIMER VIEW -->';

const afterProfileModalIndex = profileModalCloseIndex + '        </div>\n      </section>\n\n      <!-- TAB 2: TIMER VIEW -->'.length;

const part2 = content.substring(afterProfileModalIndex);

// In part2, find </main> and insert updatedModals right after </main>
const mainCloseMarker = '    </main>';
const mainCloseIndex = part2.indexOf(mainCloseMarker);
if (mainCloseIndex === -1) {
  console.error('Could not find mainCloseMarker in part2');
  process.exit(1);
}

const beforeMainClose = part2.substring(0, mainCloseIndex + mainCloseMarker.length);
const afterMainClose = part2.substring(mainCloseIndex + mainCloseMarker.length);

const finalHtml = part1 + beforeMainClose + '\n\n' + updatedModals + '\n' + afterMainClose;

fs.writeFileSync(indexPath, finalHtml, 'utf-8');
console.log('Successfully updated index.html! New length:', finalHtml.length);
