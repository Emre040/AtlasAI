import React from 'react';
import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import {faReply, faTimes} from '@fortawesome/free-solid-svg-icons';

export function ReplyBar({ replyTo, setReplyTo }) {
    return (
        <div className="HPAG-reply-bar">
            <FontAwesomeIcon icon={faReply} className="HPAG-reply-bar-icon" />
            <span className="HPAG-reply-bar-text">
              Asking about <strong>{replyTo.geneName}</strong> <span className="HPAG-reply-bar-ensg">{replyTo.ensg}</span>
            </span>
            <button className="HPAG-reply-bar-close" onClick={() => setReplyTo(null)} title="Remove">
                <FontAwesomeIcon icon={faTimes} />
            </button>
        </div>
    );
}
