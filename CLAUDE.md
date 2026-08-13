# CLAUDE.md

Read [AGENTS.md](AGENTS.md) first — it explains the model and the traps. This file is the
command reference.

## Commands

```bash
npm test                      # CI-safe suite: builds its own ext2, checks with e2fsck/debugfs
PLAY_IMG=~/Downloads/PLAY_1.0.30.img PLAY_FW=~/fw/BirdDog_PLAY-1.0.34.fw npm test
npm run dev                   # wrangler dev on :8793
cf-run npx wrangler deploy    # deploy (Cloudflare Access wrapper)
```

`e2fsprogs` supplies `mke2fs`, `e2fsck` and `debugfs`. On macOS they are keg-only:
`/opt/homebrew/opt/e2fsprogs/sbin/`. The tests find them there automatically.

## House rules

- No dependencies, no build step, no framework. Modules stay DOM-free so the tests can drive
  them in Node.
- Never commit a `.img`, `.fw` or loader blob. `test/policy.test.mjs` fails the build if you do.
- Injected files stay under 12 KiB (direct blocks only).
- Do not "fix" the page's warning that nothing has been run on hardware until something has.
