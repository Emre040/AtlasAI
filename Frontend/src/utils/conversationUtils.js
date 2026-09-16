import {authenticatedDownload} from "../api/auth";
import {
    buildTitleFromText,
    cleanPreviewText, titleCase,
    truncateText
} from "./textUtils";
import {TOOL_STAGE_META} from "./constants";


export const getFirstUserMessageText = (conv) => {
    const messages = Array.isArray(conv?.messages) ? conv.messages : [];
    const firstUserMessage = messages.find(msg => msg?.type === 'user' && cleanPreviewText(msg.text));
    if (!firstUserMessage) return '';
    return stripReplyMarker(firstUserMessage.text);
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

export const extractOptionsForEvent = (event) => {
    if (!event || !event.message) return [];
    const label = (event.label || '').toLowerCase();
    const shouldParse = /\boptions\b/i.test(label);
    if (!shouldParse) return [];
    const parts = event.message
        .split(/[,;]/)
        .map(s => s.trim())
        .filter(Boolean);
    if (parts.length < 2) return [];
    return parts;
};

export const extractSelectionsForEvent = (event) => {
    if (!event || !event.message) return [];
    const stage = (event.stage || '').toLowerCase();
    if (stage !== 'selection_step') return [];
    // Don't split URLs or long paths
    if (event.message.includes('http') || event.message.includes('→')) return [];
    return event.message
        .split(/,/)
        .map(s => s.trim())
        .filter(Boolean);
};

export const stripReplyMarker = (text = '') => {
    const cleaned = cleanPreviewText(text);
    if (!cleaned) return '';
    const extracted = extractReplyContext(cleaned);
    return cleanPreviewText(extracted ? extracted.textWithoutReply : cleaned);
};

export const groupMessagesIntoRuns = (messages) => {
    const groups = [];
    let currentRun = null;

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const toolEvent = msg.type === 'tool' ? (msg.toolEvent) : null;

        if (msg.type === 'tool' && toolEvent?.runId) {
            // This is part of a tool run
            if (!currentRun || currentRun.runId !== toolEvent.runId) {
                // Start a new run
                if (currentRun) groups.push(currentRun);
                currentRun = {
                    type: 'run',
                    runId: toolEvent.runId,
                    messages: [msg],
                    startTime: Date.now(),
                    isComplete: toolEvent.status === 'completed'
                };
            } else {
                // Add to existing run
                currentRun.messages.push(msg);
                if (toolEvent.status === 'completed') {
                    currentRun.isComplete = true;
                }
            }
        } else {
            // Not part of a tool run
            if (currentRun) {
                groups.push(currentRun);
                currentRun = null;
            }
            groups.push({ type: 'message', message: msg, index: i });
        }
    }

    if (currentRun) groups.push(currentRun);

    return groups;
};

export const downloadArtifact = async (preview, apiBaseUrl) => {
    const filename = `${preview.artifactId}.${preview.format}`;
    try {
        await authenticatedDownload(
            `${apiBaseUrl}/workspaces/${preview.workspaceUuid}/artifacts/${filename}`,
            filename
        );
    } catch (error) {
        console.error('[FE] Artifact download failed:', error.message);
    }
};

export const buildConversationTitle = (conv, maxConversationTitleLength) => {
    const explicitTitle = cleanPreviewText(conv?.title);
    const hasCustomTitle = explicitTitle && explicitTitle.toLowerCase() !== 'new conversation';
    if (hasCustomTitle) return truncateText(explicitTitle, maxConversationTitleLength);

    const firstUserText = getFirstUserMessageText(conv);
    if (firstUserText) return buildTitleFromText(firstUserText);

    const previewText = stripReplyMarker(conv?.preview);
    if (previewText) return buildTitleFromText(previewText);

    return explicitTitle || 'New Conversation';
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
