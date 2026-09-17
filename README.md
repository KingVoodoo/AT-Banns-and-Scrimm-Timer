# ATXXII Ban Picker & Scrim Timer

Official Fan Utility for **Alliance Tournament XXII (AT XXII)** scrimmages, ban drafting, and synchronized match timing.

---

## 🎮 EVE Client Overlay HUD Instructions

> [!IMPORTANT]
> **Pop-Out Timer is Designed for Placing Over Your EVE Client:**
> The popped-out floating timer window is a lightweight, frameless, high-contrast HUD specifically designed to be positioned **directly over your EVE Online game client** during matches.

### How to Use the Floating HUD:
1. **Launch the Overlay**: Click the **`POP OUT`** button in the top navigation bar or the **`POP OUT TIMER`** button on the Timer stage.
2. **Position Over EVE Client**: Drag the window using the top header bar and place it anywhere over your EVE Online client (e.g. above your capacitor, overview, or broadcast window).
3. **Always-On-Top (`📌`)**: The pop-out window defaults to **pinned Always-on-Top**, ensuring it remains visible above full-screen windowed EVE Online sessions at all times. Click the pin icon (`📌`) to toggle pin behavior if desired.
4. **Auto-Reset per Match**: At the end of each scrimmage (when the clock hits `00:00` or upon `RESIGN`), the pop-out HUD automatically resets to `10:00` (with 60-second warmup) ready for the next match without requiring manual resetting.

---

## ⚔️ Key Tournament Features

- **200-Point Fleet Comp Marshalling**:
  - 10-slot fleet entry per team with fast hull autocomplete from all 278 AT XXII tournament ships.
  - Symmetrical horizontal mirror layout with real-time point sum calculation and `200 PTS` rule ceiling enforcement.
- **5-Match Tournament Series**:
  - Independent match timers and comp states for **MATCH 1** through **MATCH 5**.
  - Alternating serpentine ban drafting (`A → B → B → A → A → B` for sets 1, 3, 5; `B → A → A → B → B → A` for sets 2, 4).
- **Strict Ban & Flagship Rule Enforcement**:
  - Unified **Ban Set Card** displayed at the bottom center of the Timer stage.
  - Banned non-flagships cannot be selected in the 10-slot fleet comp; any attempt triggers an instant red shake alert and rejection toast.
  - Designated team Battleship flagships (excluding Bhaalgorn) are strictly immune to bans under official tournament rules.
- **Fenris Creations Intellectual Property Compliance**:
  - All EVE Online imagery, 3D ship models, hull renders, and logos are property of **Fenris Creations hf.** (used under non-commercial Content Creation Terms & EULA).

---

## 🚀 Running Locally

```bash
# Install dependencies
npm install

# Run desktop application with Tauri
npm run tauri dev

# Production build
npm run build
```
