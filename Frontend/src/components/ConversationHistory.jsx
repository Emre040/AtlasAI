import React from 'react';
import {getUiConfig} from '../api/config';
import {formatRelativeTime} from "../utils/textUtils";
import {buildConversationTitle} from "../utils/conversationUtils";

const UI_CONFIG = getUiConfig();

export function ConversationHistory({ conversations, selectedConversation, onSelectConversation, onNewChat }) {
    return (
        <>
            <div className="HPAG-sidebar-logo">
                <img src="https://www.proteinatlas.org/images_static/logo.svg" alt="Human Protein Atlas" />
            </div>
            <div className="HPAG-sidebar-header">
                <h2>Conversations</h2>
                <button className="HPAG-new-chat-btn" onClick={onNewChat}>
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M7 1V13M1 7H13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                    </svg>
                    New
                </button>
            </div>

            <div className="HPAG-conversations-list">
                {conversations.map(conv => (
                    <button type="button"
                        key={conv.id}
                        className={`HPAG-conversation-item ${selectedConversation === conv.id ? 'HPAG-active' : ''}`}
                        aria-current={selectedConversation === conv.id ? 'page' : undefined}
                        onClick={() => onSelectConversation(conv.id)}
                    >
                        <div className="HPAG-conversation-title">{buildConversationTitle(conv, UI_CONFIG.maxConversationTitleLength)}</div>
                        <div className="HPAG-conversation-date">{formatRelativeTime(conv.created_at || conv.date)}</div>
                    </button>
                ))}
            </div>
        </>
    );
}
