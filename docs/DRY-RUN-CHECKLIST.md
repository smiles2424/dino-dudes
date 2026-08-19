# Human Dry-Run Checklist

The Wave 4 human checkpoint: one person can run this alone in ~15 minutes; ideally repeat
with 2–3 friends. Check boxes as you go; anything that fails, note it in PLAN.md's
Progress Log.

## Setup (once)

- [ ] Print a template: `assets/templates/template-trex.pdf` (any dino works).
- [ ] Draw on it — stay inside the dashed box. Bold marker lines beat faint pencil.
- [ ] Find your PC's LAN IP: `ipconfig` → IPv4 Address (e.g. `192.168.1.2`).
- [ ] Start the server: `pnpm --filter @dino/server dev`
- [ ] Start the web app reachable from phones (Git Bash, replace the IP):
      `VITE_API_URL=http://192.168.1.2:2567 pnpm --filter @dino/web dev -- --host`
- [ ] Create a lobby: `curl -X POST http://localhost:2567/api/lobbies` → note the 5-char
      `code` in the response.

*Phone can't connect? Same Wi-Fi as the PC; allow Node through the Windows Firewall
prompt for ports 5173/2567; ProtonVPN's kill switch can also block inbound LAN — permit
LAN traffic or pause the VPN (the app itself doesn't need internet once running).*

## Projector screen (desktop browser)

- [ ] Open `http://localhost:5173/play?lobby=CODE` — world renders, big lobby code, QR
      code bottom corner, no dinos yet (you haven't drawn).

## Phone: the real journey

- [ ] Scan the QR with your phone → capture flow opens with the code prefilled.
- [ ] Enter your name → pick a dino → photograph your drawing (normal room light, all
      4 corner markers in frame, slight angle is fine — that's the point).
- [ ] Preview shows YOUR drawing wrapped on the 3D dino. Looks right? (Tail on the left
      of the sheet, snout on the right, spine on top.)
- [ ] Confirm → you land in the game view with your dino visible.
- [ ] **The moment:** your dino appeared on the projector screen, with your name over it,
      within a few seconds of confirming — without anyone touching the projector.

## Deliberate failures (30 seconds each)

- [ ] Photograph the sheet with a corner marker covered by your thumb → per-corner error
      tells you WHICH corner; retake works.
- [ ] Enter a garbage lobby code → readable error, not a blank screen.
- [ ] Close the phone tab after uploading → your dino STAYS on the projector.

## With friends (if available)

- [ ] 2–3 people join the same lobby from their own phones with their own drawings — every
      dino appears on the projector; nobody overwrites anyone else.
- [ ] Two spectator screens side-by-side show the same dinos in the same spawn spots
      (their idle wandering will drift apart — known follow-up, don't log it again).

## Known issues — expected, already logged, don't fail the run for these

1. ~1 in 6 dinos spawns outside the projector camera's view (Wave 5 fix). Reload the
   projector page to reshuffle what's visible.
2. First page load on a phone can take ~10s (1.3 MB bundle; code-splitting is a Wave 5 item).
3. Real phone photos are the first non-synthetic input the pipeline has ever seen — if
   detection fails on good-looking photos, save them into `assets/fixtures/` (that's the
   Wave 2A human checkpoint: real fixtures + re-approved goldens).
