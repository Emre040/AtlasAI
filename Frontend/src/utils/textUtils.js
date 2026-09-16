// Title case: lowercase everything, then capitalize first letter of each word
import React from "react";
import {
    faMagnifyingGlass,
    faMicroscope,
    faVirus,
    faNetworkWired,
    faDroplet,
    faFlask,
    faCubes,
    faBrain,
    faFileCode
} from '@fortawesome/free-solid-svg-icons';
import {TOOL_STAGE_META} from "./constants";
import {hpaIcon} from "../assets/icons/hpaIcon";

export const titleCase = (str = '') => str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

export const cleanPreviewText = (text = '') => String(text || '').replace(/\s+/g, ' ').trim();

export const truncateText = (text = '', maxLen = 50) => {
    if (!text) return '';
    if (text.length <= maxLen) return text;
    if (maxLen <= 3) return text.slice(0, maxLen);
    return `${text.slice(0, maxLen - 3)}...`;
};

const REPLY_MARKER_NEW = /^⟪HPA▸GENE:(ENSG\d+):([^⟫]+)⟫\s*/;
const REPLY_MARKER_COMPAT = /^\[\[REPLY:(ENSG\d+):([^\]]+)\]\]\s*/;

export const extractReplyContext = (t = '') => {
    let match = t.match(REPLY_MARKER_NEW);
    let regex = REPLY_MARKER_NEW;
    if (!match) {
        match = t.match(REPLY_MARKER_COMPAT);
        regex = REPLY_MARKER_COMPAT;
    }
    if (match) {
        return { ensg: match[1], geneName: match[2], textWithoutReply: t.replace(regex, '') };
    }
    return null;
};

export const stripReplyMarker = (text = '') => {
    const cleaned = cleanPreviewText(text);
    if (!cleaned) return '';
    const extracted = extractReplyContext(cleaned);
    return cleanPreviewText(extracted ? extracted.textWithoutReply : cleaned);
};

export const buildTitleFromText = (text = '', maxConversationTitleLength) => {
    const cleaned = cleanPreviewText(text);
    if (!cleaned) return '';
    return truncateText(cleaned, maxConversationTitleLength);
};

export const getFirstUserMessageText = (conv) => {
    const messages = Array.isArray(conv?.messages) ? conv.messages : [];
    const firstUserMessage = messages.find(msg => msg?.type === 'user' && cleanPreviewText(msg.text));
    if (!firstUserMessage) return '';
    return stripReplyMarker(firstUserMessage.text);
};


// Format date to human-readable relative time
export const formatRelativeTime = (dateString) => {
    if (!dateString) return 'Just now';

    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSecs < 60) return 'Just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;

    // Check if yesterday
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';

    // Check if this week (within last 7 days)
    if (diffDays < 7) return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;

    // Check if last week (7-14 days ago)
    if (diffDays < 14) return 'Last week';

    // Check if this month
    if (date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear()) {
        return 'This month';
    }

    // Otherwise show date
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

export const stageMetaFor = (event = {}) => {
    if (!event) return TOOL_STAGE_META.info;
    if (event.status === 'started') return TOOL_STAGE_META.start;
    if (event.status === 'completed') return TOOL_STAGE_META.complete;
    const key = (event.stage || '').toLowerCase();
    return TOOL_STAGE_META[key] || TOOL_STAGE_META.info;
};

// Compute the display label for a tool event (shared by shimmer + timeline)
export const getStepDisplayLabel = (evt) => {
    if (!evt) return 'Update';
    const meta = stageMetaFor(evt);
    return titleCase(evt.label || meta?.label || 'Update');
};

export const linkifyInline = (text = '') => {
    if (!text) return '';
    const regex = /(https?:\/\/[^\s)]+)/gi;
    const segments = [];
    let lastIndex = 0;
    let match;
    let key = 0;

    while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            segments.push(<span key={`text-${key++}`}>{text.slice(lastIndex, match.index)}</span>);
        }
        const rawUrl = match[1];
        const url = rawUrl.replace(/[),.;]+$/, '');
        segments.push(
            <a key={`url-${key++}`} href={url} target="_blank" rel="noopener noreferrer" className="HPAG-tool-inline-link">
                {url}
            </a>
        );
        lastIndex = match.index + rawUrl.length;
    }

    if (lastIndex < text.length) {
        segments.push(<span key={`text-${key++}`}>{text.slice(lastIndex)}</span>);
    }

    return segments.length ? segments : text;
};

// Extract HPA URLs from message text
export const extractHPAUrls = (text) => {
    const urlRegex = /https?:\/\/www\.proteinatlas\.org\/[^\s)]+/g;
    const matches = text.match(urlRegex) || [];
    const uniqueUrls = [...new Set(matches)];

    // Filter out URLs with + EXCEPT for our known sub-pages
    const knownSubPages = ['/single+cell', '/cell+line'];
    const filteredUrls = uniqueUrls.filter(url => {
        // If it has a +, only keep it if it's one of our known sub-pages
        if (url.includes('+')) {
            return knownSubPages.some(subPage => url.includes(subPage));
        }
        return true;
    });

    return filteredUrls.map(url => {
        return makeLinkButtonFromUrl(url);
    });
}

export function makeLinkButtonFromUrl(url) {
    if (url.includes('/search/')) {
        const geneName = url.split('/search/')[1]?.split(/[?&#]/)[0] || 'Search';
        return {
            url,
            type: 'search',
            label: geneName,
            icon: faMagnifyingGlass
        };
    }
    url = url.replace(/[\]).]+$/, '');
    // Parse the URL to determine the type
    let type = 'summary';
    let u = new URL(url);
    let label = u.pathname.split('/').at(-1)?.replace('+', ' ');
    label = label.charAt(0).toUpperCase() + label.slice(1);
    let icon = hpaIcon;

    // Check if it's an ENSG protein page (e.g., ENSG00000121410-A1BG)
    const ensgMatch = url.match(/ENSG\d+-([A-Z0-9]+)/);
    if (ensgMatch && !url.includes('/tissue') && !url.includes('/brain') && !url.includes('/single+cell') &&
        !url.includes('/subcellular') && !url.includes('/cancer') && !url.includes('/blood') &&
        !url.includes('/cell+line') && !url.includes('/structure') &&
        !url.includes('/interaction')) {
        // It's a base protein page, use the gene name
        label = ensgMatch[1];
    }

    if (url.includes('/tissue')) {
        type = 'tissue';
        label = 'Tissue';
        icon = faMicroscope;
    } else if (url.includes('/brain')) {
        type = 'brain';
        label = 'Brain';
        icon = faBrain;
    } else if (url.includes('/single+cell')) {
        type = 'single_cell';
        label = 'Single Cell';
        icon = faVirus;
    } else if (url.includes('/subcellular')) {
        type = 'subcellular';
        label = 'Subcellular';
        icon = faCubes;
    } else if (url.includes('/cancer')) {
        type = 'cancer';
        label = 'Cancer';
        icon = faVirus;
    } else if (url.includes('/blood')) {
        type = 'blood';
        label = 'Blood';
        icon = faDroplet;
    } else if (url.includes('/cell+line')) {
        type = 'cell_line';
        label = 'Cell Line';
        icon = faFlask;
    } else if (url.includes('/structure')) {
        type = 'structure';
        label = 'Structure';
        icon = faNetworkWired;
    } else if (url.includes('/interaction')) {
        type = 'interaction';
        label = 'Interaction';
        icon = faNetworkWired;
    } else if (url.endsWith('.xml')) {
        type = 'xml';
        label = 'XML';
        icon = faFileCode;
    }

    return { url, type, label, icon };
}
