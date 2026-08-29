# Root README Update Proposal

This file proposes a future restructuring of the repository root `README.md`. It intentionally does **not** overwrite the current README on this documentation branch.

## Why revise it later

The current README correctly communicates several important facts:

- the game is a Terraria-style 2D sandbox survival project;
- it is implemented with vanilla JavaScript and HTML5 Canvas;
- graphics are procedurally drawn;
- audio is synthesized with WebAudio;
- no external Terraria assets are included;
- there is no required build step for the current version;
- the game can be opened directly or served through a simple HTTP server.

Those facts should remain. The README should evolve as the architecture/build system evolves so that players and contributors are not forced to inspect source code to understand project status.

---

# Proposed future README structure

```markdown
# <Project Name>

Original 2D sandbox action-adventure inspired by systemic sandbox games such as Terraria.

[hero screenshot]

## Status
## Features
## Quick Start
## Controls
## Saves
## Development
## Testing
## Architecture
## Roadmap
## Contributing
## Asset / IP Policy
## License
```

---

## 1. Project identity

Avoid presenting the project as an official Terraria product or a literal redistribution. The first paragraph should emphasize:

- independently implemented game;
- original/procedural or properly licensed assets;
- systemic inspiration;
- not affiliated with Re-Logic.

Suggested concept, to rewrite in the project's preferred voice:

> An original browser-based 2D sandbox action game built around deterministic world generation, mining, building, combat, crafting, exploration and progression. It is independently implemented and is not affiliated with or endorsed by Re-Logic.

Do not claim “complete Terraria clone” unless the project owner explicitly accepts the associated branding/legal risk.

---

## 2. Status block

Add a compact status table:

| Area | Status |
|---|---|
| Core sandbox loop | Playable |
| World generation | Playable, evolving |
| Combat/enemies | Playable |
| Save/load | Implemented, architecture upgrade planned |
| Advanced systems | Fishing/magic/accessories/wiring present; integration work planned |
| Multiplayer | Not implemented |
| Mod support | Planned, not implemented |
| Stability | Development/alpha |

This is more useful than an inflated percentage-complete figure.

---

## 3. Feature summary

Group features by player experience rather than source file names.

### Explore

- deterministic procedural worlds;
- surface/underground biome variation;
- structures and environmental hazards;
- minimap and lighting.

### Build and craft

- mining and block placement;
- walls and containers;
- inventory and recipes;
- wiring/mechanism work where integrated.

### Fight and progress

- melee/ranged combat;
- generalized projectile behaviors;
- enemies and bosses;
- magic, accessories and status effects where integrated.

### Side systems

- fishing;
- synthesized audio/music;
- save/load.

Avoid documenting a feature as production-ready if it currently requires an unintegrated script path or loses state on reload.

---

## 4. Quick start

### Current architecture

Until the build-system milestone lands, preserve the existing simple instructions:

```bash
python -m http.server 8377
```

Then open the documented localhost URL.

### After Vite migration

README can evolve to:

```bash
npm install
npm run dev
```

and:

```bash
npm test
npm run build
```

Do not publish future commands before they actually exist on `main`.

---

## 5. Controls

Retain the current control table, but eventually add:

- inventory shortcuts;
- chest/quick-transfer shortcuts;
- platform drop-through controls;
- grappling control if implemented;
- wiring overlay/tool controls;
- configurable keybind note;
- gamepad/controller section only when supported.

Controls should be generated or checked against the canonical input binding definitions once key rebinding is implemented.

---

## 6. Saves

Add a dedicated section because sandbox save trust matters.

Current README should explain only current behavior. After the persistence roadmap lands, document:

- world vs character saves;
- automatic/manual save behavior;
- export/import;
- backup/recovery;
- compatibility expectations;
- where browser data is stored conceptually;
- warning that clearing site storage may remove local saves unless exported.

Avoid promising perpetual compatibility before migration policy is implemented.

---

## 7. Development section

Link to:

- `CONTRIBUTING.md`;
- `docs/ARCHITECTURE.md`;
- `docs/TASK_BOARD.md`;
- `docs/terraria-parity/roadmap.md`.

Once Vite/test tooling exists, list the canonical commands and supported Node version.

---

## 8. Architecture section

Keep it short in the root README. Example:

```text
Presentation → Application → Simulation → Adapters
```

Then link to `docs/ARCHITECTURE.md` for:

- stable content IDs;
- commands/events;
- persistence providers;
- update order;
- deterministic worldgen;
- renderer separation.

---

## 9. Screenshots and media

The repository already contains gameplay screenshots. Curate rather than flood the README.

Recommended set:

1. bright surface exploration;
2. underground/cave scene with lighting;
3. inventory/crafting/chest UI;
4. boss/combat scene;
5. optional wiring/fishing scene once integrated.

All screenshots should show current `main` behavior, not mockups presented as implemented features.

---

## 10. Roadmap link

The root README should not duplicate the full roadmap. Use a short sequence:

```text
Foundation/testing
→ stable architecture & saves
→ world/traversal/liquids
→ combat/progression/towns
→ presentation
→ multiplayer/extensibility
```

Link to this documentation package for detail.

---

## 11. Contribution policy

After contribution rules are established, README should clearly state:

- how to report bugs;
- how to run tests;
- content-ID rules;
- save compatibility expectations;
- original asset/IP policy;
- whether outside pull requests are accepted.

---

## 12. Asset/IP statement

Keep a clear independent-project notice. Recommended principles:

- all project assets/code must be original or compatibly licensed;
- do not submit extracted Terraria assets or decompiled code;
- public reference material may be used to understand mechanics, but not copied wholesale as protected expression/content;
- Terraria and related marks belong to their respective owners.

Do not copy legal text from another project without checking its applicability.

---

## 13. License

The repository should eventually include an explicit `LICENSE` selected by the owner. The README should link to it rather than making ambiguous statements.

If code and art/audio use different licenses, document that distinction clearly.

---

# Proposed transition timing

Do not rewrite the root README immediately from this planning branch. Update it in implementation milestones when statements become true:

- **M1:** add actual build/test commands.
- **M2:** add architecture/save compatibility wording.
- **M3-M5:** refresh feature list and screenshots.
- **Release hardening:** add definitive license/provenance/release status.

This prevents documentation from advertising future architecture as if it were already implemented.