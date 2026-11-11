import React from 'react';
import ReactDOM from 'react-dom/client';
import ChatDialog from "./components/ChatDialog";
import {setApiBaseUrl} from "./api/config";


// apiBase, when given, is the backend origin to use instead of the build's VITE_HPA_API_BASE
// (e.g. "https://atlasai.proteinatlas.net"). It must be a bare origin, HTTPS unless localhost.
export function runHPAChat(elemId, apiBase) {
    if (apiBase !== undefined && apiBase !== null) {
        setApiBaseUrl(apiBase);
    }
    const root = ReactDOM.createRoot(document.getElementById(elemId));
    root.render(
        <React.StrictMode>
            <ChatDialog />
        </React.StrictMode>
    );
}
