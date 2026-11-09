# Contributing

1. Fork the repo and create a branch from `main`.
2. Follow the setup steps in the [README](README.md); never commit `.env` files or API keys.
3. Frontend: run `npm run lint` and `npm run build` in `frontend/` before opening a PR.
4. Backend: confirm `python -m uvicorn app.main:app` boots and `/health` responds.
5. Keep PRs small and focused, and describe what changed and why.
