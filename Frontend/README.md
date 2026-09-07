# AtlasAI Frontend

The React app of AtlasAI: a chat over the Human Protein Atlas agents that streams every run as
it happens, including a study's map of steps, its artifacts, its figures and its provenance
graph.

## Run

```bash
npm install
REACT_APP_HPA_API_BASE=http://localhost:9000 npm start   # any origin; HTTPS is required off localhost
CI=true npm run build                                     # production bundle; lint warnings fail the build
CI=true npx react-scripts test --watchAll=false
```

`REACT_APP_HPA_API_BASE` is the only required build variable: the backend origin the app talks
to. `npm run start:local` and `npm run start:prod` are the same command pointed at a local
backend and at the production API.

## Structure

```text
src/
├── App.js                       # routes and layout
├── api/
│   ├── auth.js                  # session and visitor authentication
│   ├── config.js                # backend origin
│   ├── models.js                # the model catalog shown in the menu
│   └── timeline.js              # a conversation's runs as an ordered timeline
├── components/
│   ├── Chat.js / Chat.css       # the conversation, search results, gene cards
│   ├── ModelMenu.js             # model selection
│   ├── DictionaryCarousel.js    # dictionary expert answers with atlas images
│   ├── StudyRun.js              # a study as a map of steps while it runs
│   ├── StudyRunDetails.js       # the artifacts, figures and report of a study
│   ├── studyRunModel.js         # builds the map from the study's run events
│   ├── ProvenanceGraph.js       # the stored provenance graph of a finished study
│   └── AsoChart.js              # interactive figures
└── assets/providers/            # provider logos
```

Production builds run on Vercel from every push to `main`.
