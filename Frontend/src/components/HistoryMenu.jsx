import React, {useEffect, useRef, useState} from 'react';
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faBars} from "@fortawesome/free-solid-svg-icons";
import {buildConversationTitle} from "../utils/conversationUtils";

export function HistoryMenu(props) {
    const {selectedConversation, conversations, setSelectedConversation} = props;
    const [showHistoryMenu, setShowHistoryMenu] = useState(false);
    const menuRef = useRef(null);

    useEffect(() => {
        if (!showHistoryMenu) return;
        const handleClickOutside = (event) => {
            if (menuRef.current && !menuRef.current.contains(event.target)) {
                setShowHistoryMenu(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [showHistoryMenu]);

    return (
        <>
            <div className="HPAG-history-selector" ref={menuRef}>
                <button
                    className="HPAG-history-button"
                    onClick={() => setShowHistoryMenu(!showHistoryMenu)}
                >
                    <FontAwesomeIcon icon={faBars} className="HPAG-tool-run-status-icon" />
                    <span className="HPAG-history-name">History</span>
                </button>
                {showHistoryMenu && (
                    <div className="HPAG-history-dropdown">
                        <div className="HPAG-history-item HPAG-history-active">
                            <ul className="HPAG-conversations-list" id="conversation-list">
                                {conversations.map(conv => (
                                    <li
                                        key={conv.id}
                                        className={`HPAG-conversation-item ${selectedConversation === conv.id ? 'HPAG-active' : ''}`}
                                        onClick={() => {setSelectedConversation(conv.id); setShowHistoryMenu(!showHistoryMenu)}}
                                    >
                                        {buildConversationTitle(conv)}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </div>
                )}
            </div>
        </>
    );
}
