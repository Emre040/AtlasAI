import React from 'react';
import ReactDOM from 'react-dom/client';
import ChatDialog from "./components/ChatDialog";


export function runHPAChat(elemId) {
    const root = ReactDOM.createRoot(document.getElementById(elemId));
    root.render(
        <React.StrictMode>
            <ChatDialog />
        </React.StrictMode>
    );
}
