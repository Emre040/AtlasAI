import React, {useEffect, useRef} from 'react';
import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import {faTimes} from '@fortawesome/free-solid-svg-icons';
import {ConversationHistory} from './ConversationHistory';

export function MobileHistoryDialog({ open, onClose, ...historyProps }) {
    const dialogRef = useRef(null);

    useEffect(() => {
        const dialog = dialogRef.current;
        if (open) dialog.showModal();
        else if (dialog.open) dialog.close();
    }, [open]);

    return (
        <dialog
            ref={dialogRef}
            className="HPAG-mobile-history"
            id="HPAG-mobile-history"
            aria-label="Conversations"
            onCancel={event => { event.preventDefault(); onClose(); }}
            onClick={event => {
                // Close when clicking the backdrop to the right of the drawer.
                if (event.target === event.currentTarget) {
                    const rect = event.currentTarget.getBoundingClientRect();
                    if (event.clientX > rect.right) onClose();
                }
            }}
        >
            <button type="button" className="HPAG-history-close" onClick={onClose} aria-label="Close conversations">
                <FontAwesomeIcon icon={faTimes} />
            </button>
            <ConversationHistory {...historyProps} />
        </dialog>
    );
}
