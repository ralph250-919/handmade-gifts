# Handmade Gifts — notes for Claude

- After changing any code in `backend/`, `frontend/`, `infra/`, `scripts/` or `.github/`, and before committing, run the `code-guardian` subagent on the change and fix its Critical and High findings (or tell the user why not).
- Check commands: `npm run typecheck`, `npm test`, `npm run test:e2e` (slow), `npx cdk synth --quiet`.
