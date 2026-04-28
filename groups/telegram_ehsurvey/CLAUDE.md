# EH Survey Engine

## Project

- Repo: ~/Documents/eh/element
- Path: /workspace/extra/element
- **Project root for frontend work: `/workspace/extra/element/frontend/survey/`** (the React survey runtime)
- Description: Survey engine. `frontend/survey/src/` is the loaded survey runtime consumed by respondents. `backend/` is the Django BE + an internal FE app used by the workbench to author and publish "activities" (surveys) that `frontend/survey/` then loads.

## Structure

```
element/
├── frontend/
│   └── survey/           # ← React survey runtime (this is the app you work on by default)
│       ├── src/
│       │   ├── App.tsx
│       │   ├── pages/
│       │   ├── components/
│       │   ├── containers/
│       │   ├── context/
│       │   ├── hooks/
│       │   ├── services/
│       │   ├── templates/
│       │   ├── helpers/
│       │   ├── scss/
│       │   └── ...
│       ├── public/
│       └── package.json  # survey-engine, React 17, CRA (react-scripts 4), survey-react, TypeScript
└── backend/              # Django backend + internal workbench FE (authors activities/surveys)
    ├── activities/
    ├── manage.py
    └── ...
```

## Where to work

- Default to `frontend/survey/src/` for any survey runtime / end-user UI changes.
- Only touch `backend/` if the user explicitly asks about the workbench, activity authoring, APIs, or Django models.

## Common Commands (frontend/survey)

```bash
cd frontend/survey
npm install
npm start          # CRA dev server
npm run build      # Production build
npm test
```

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | React 17 + TypeScript, CRA (react-scripts 4) |
| Survey | survey-react 1.8.35 |
| i18n | react-intl |
| Logging | @datadog/browser-logs |
| Backend | Django (see backend/) |
