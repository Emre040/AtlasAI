# Contributing to AtlasAI

AtlasAI is maintained by the Human Protein Atlas project. Contributions are welcome through
GitHub issues and pull requests.

## Before you start

- Read the `README.md` at the root for the layout, and `Backend/README.md` for how the backend,
  the model catalog, the HPA data release and the study orchestrator fit together.
- Open an issue first for anything larger than a fix, so the change can be discussed before
  the work is done.

## Working on the code

Backend:

```bash
cd Backend
cp .env.example .env      # fill every value
npm install
npm test                  # node --test tests/unit
```

Frontend:

```bash
cd Frontend
npm install
CI=true npm run build     # lint warnings fail the build, as they do in production
CI=true npx react-scripts test --watchAll=false
```

## Pull requests

- One change per pull request, with the tests that cover it.
- Keep the test suites green: the backend suite runs in GitHub Actions on every push to `main`
  that touches `Backend/`, and the frontend is built with `CI=true`.
- Do not add configuration defaults or fallbacks; the backend validates its configuration at
  startup and fails on anything missing.
- Do not commit data files, `.env` files, or generated workspaces; see the ignore files.
- Agents must not carry atlas-specific rules in code or prompts beyond what the schema and the
  data release express; the study orchestrator computes over artifacts only.

## Licence

By contributing you agree that your contributions are licensed under the Apache License,
Version 2.0 (see `LICENSE`).

## Conduct

This project follows the Contributor Covenant; see `CODE_OF_CONDUCT.md`.
