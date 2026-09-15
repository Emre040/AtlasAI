# AtlasAI Frontend

The React app of AtlasAI: a chat over the Human Protein Atlas agents that streams every run as
it happens, including a study's map of steps, readable operations, saved figures and the trace
of how each node was created.

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

Component tests exercise the actual Markdown renderer. The Jest configuration transforms its
ESM dependencies and maps their browser imports for the CRA test runner.

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
│   ├── StudyOperation.js        # structured operation summaries and results
│   ├── studyOperations.js       # labels and details for the registered operations
│   ├── StudyTrace.js            # a selected node's recorded history
│   ├── studyTraceModel.js       # follows artifact IDs through producing steps
│   ├── StudyOutputs.js          # workspace download and saved figure carousel
│   ├── StudyAnswer.js           # Markdown answers with selectable artifact citations
│   ├── studyCitations.js        # run-scoped citation lookup and Markdown transformation
│   ├── useArtifactImage.js      # authenticated image loading and URL cleanup
│   └── AsoChart.js              # interactive figures
└── assets/providers/            # provider logos
```

Production builds run on Vercel from every push to `main`.

Answer citations resolve through the message's run ID, including live responses. Selecting one
opens that study's flow and pins the artifact; an unavailable ID never resolves into a different
study. Markdown links and code retain their original behavior.
