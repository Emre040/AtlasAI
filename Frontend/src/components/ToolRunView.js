import React from 'react';
import StudyOutputs from "./StudyOutputs";
import StudyRun, {studyStatusLine} from "./StudyRun";
import {getStepDisplayLabel, linkifyInline, stageMetaFor, titleCase} from "../utils/textUtils";
import {FontAwesomeIcon} from "@fortawesome/react-fontawesome";
import {faChevronDown, faChevronRight, faExternalLinkAlt, faSearch} from "@fortawesome/free-solid-svg-icons";
import {extractOptionsForEvent, extractSelectionsForEvent} from "../utils/conversationUtils";

export function ToolRunView({group, collapsedRuns, toggleRunCollapsed, toolRunRefs, handleArtifactChipEnter, handleArtifactChipLeave, apiBaseUrl, studySelection}) {
    // Render a collapsible tool run container - starts collapsed by default
    // Detect run type from first message tool name
    const firstToolEvent = group.messages[0]?.toolEvent;
    const isInvestigatorRun = firstToolEvent?.toolName === 'investigator_hpa';
    const isAsoRun = firstToolEvent?.toolName === 'aso_hpa';
    const runTitle = isAsoRun ? 'Study' : isInvestigatorRun ? 'Investigator' : 'Deep Research';

    const runEvents = group.messages.map(m => m.toolEvent).filter(Boolean);

    // Get latest step label for shimmer text (identical to HPAG-tool-line-label)
    const lastStepMsg = (() => {
        if (isAsoRun) return studyStatusLine(runEvents);
        for (let mi = group.messages.length - 1; mi >= 0; mi--) {
            const evt = group.messages[mi].toolEvent;
            if (evt && evt.status !== 'started' && evt.status !== 'completed') {
                return getStepDisplayLabel(evt);
            }
        }
        return runTitle;
    })();

    // A study is its map: always open, never folded.
    const isExpanded = isAsoRun || collapsedRuns[group.runId] === false;

    return (
        <React.Fragment key={group.runId}>
            {!isAsoRun && <div
                className={`HPAG-shimmer-bar ${group.isComplete ? 'HPAG-shimmer-done' : ''}`}
                onClick={isAsoRun ? undefined : () => toggleRunCollapsed(group.runId)}
            >
                      <span className="HPAG-shimmer-text">
                        {group.isComplete ? `${runTitle} complete` : <>Working<span className="HPAG-shimmer-dot">{'\u00B7'}</span>{lastStepMsg}</>}
                      </span>
                {!isAsoRun && <FontAwesomeIcon icon={isExpanded ? faChevronDown : faChevronRight} className="HPAG-shimmer-chevron" />}
            </div>}
            {isExpanded && (
                <div className={`HPAG-tool-run-container ${isAsoRun ? 'HPAG-tool-run-container-study' : ''}`}>
                    <div
                        className={`HPAG-tool-run-content ${isAsoRun ? 'HPAG-tool-run-content-study' : ''}`}
                        ref={el => { toolRunRefs.current[group.runId] = el; }}
                        data-study-run-id={isAsoRun ? group.runId : undefined}
                    >
                        {isAsoRun && (
                            <StudyRun
                                events={runEvents}
                                apiBaseUrl={apiBaseUrl}
                                isComplete={group.isComplete}
                                selectionRequest={studySelection?.runId === group.runId ? studySelection : null}
                                onArtifactEnter={handleArtifactChipEnter}
                                onArtifactLeave={handleArtifactChipLeave}
                            />
                        )}
                        {/* Non-ASO runs: original per-message timeline */}
                        {!isAsoRun && group.messages.map((message, msgIndex) => {
                            const nextMsg = group.messages[msgIndex + 1];
                            const nextEvent = nextMsg?.type === 'tool' ? (nextMsg.toolEvent) : null;
                            const nextSelections = nextEvent ? extractSelectionsForEvent(nextEvent) : [];
                            const selectionsForThisRow = new Set(nextSelections.map(s => s.toLowerCase().trim()));

                            const toolEvent = message.toolEvent;
                            const toolStageMeta = toolEvent ? stageMetaFor(toolEvent) : null;
                            const stageBadgeClass = toolStageMeta?.css ? `HPAG-tool-stage-${toolStageMeta.css}` : '';
                            const toolMetaLine = toolEvent
                                ? [toolStageMeta?.description || null, toolEvent.toolName || null].filter(Boolean).join(' • ')
                                : '';
                            const toolOptions = toolEvent ? extractOptionsForEvent(toolEvent) : [];
                            const toolSelections = toolEvent ? extractSelectionsForEvent(toolEvent) : [];
                            const hasScanVisual = toolEvent?.meta?.visual === 'scan';
                            const hasUrl = toolEvent?.meta?.url;
                            const shouldShowToolMessage = toolEvent?.message && toolOptions.length === 0 && toolSelections.length === 0 && !hasScanVisual && !hasUrl;

                            return (
                                <div key={message.id} className="HPAG-tool-line">
                                    <div className={`HPAG-tool-timeline ${msgIndex > 0 ? 'HPAG-has-line-above' : ''} ${msgIndex < group.messages.length - 1 ? 'HPAG-has-line-below' : ''}`}>
                                        <div className="HPAG-tool-timeline-dot" />
                                    </div>
                                    <div className={`HPAG-tool-stage-badge ${stageBadgeClass}`}>
                                        {toolStageMeta?.label || 'Info'}
                                    </div>
                                    <div className="HPAG-tool-line-body">
                                        <div className="HPAG-tool-line-label">
                                            {titleCase(toolEvent?.label || toolStageMeta?.label || 'Update')}
                                        </div>
                                        {hasUrl && (
                                            <a href={toolEvent.meta.url} target="_blank" rel="noopener noreferrer" className="HPAG-navigate-box">
                                                <FontAwesomeIcon icon={faExternalLinkAlt} className="HPAG-navigate-box-icon" />
                                                <span className="HPAG-navigate-box-page">{toolEvent.message || 'Page'}</span>
                                            </a>
                                        )}
                                        {hasScanVisual && (
                                            <div className="HPAG-scan-box">
                                                <div className="HPAG-scan-box-icon"><FontAwesomeIcon icon={faSearch} /></div>
                                                <span className="HPAG-scan-box-text">{toolEvent.message || 'Searching...'}</span>
                                            </div>
                                        )}
                                        {shouldShowToolMessage && (
                                            <div className="HPAG-tool-line-message">{linkifyInline(toolEvent.message)}</div>
                                        )}
                                        {toolOptions.length > 0 && (
                                            <div className="HPAG-tool-options-row">
                                                {toolOptions.map((opt, idx) => {
                                                    const isSelected = selectionsForThisRow.has(opt.toLowerCase().trim());
                                                    return (
                                                        <span key={idx} className={`HPAG-tool-option-chip ${isSelected ? 'HPAG-selected' : ''}`}>{titleCase(opt)}</span>
                                                    );
                                                })}
                                            </div>
                                        )}
                                        {toolSelections.length > 0 && (
                                            <div className="HPAG-tool-selections-row">
                                                {toolSelections.map((sel, idx) => (
                                                    <span key={idx} className="HPAG-tool-selection-chip" style={{ animationDelay: `${idx * 0.1}s` }}>{titleCase(sel)}</span>
                                                ))}
                                            </div>
                                        )}
                                        {toolMetaLine && (
                                            <div className="HPAG-tool-line-meta">{toolMetaLine}</div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
            {isAsoRun && group.isComplete && (
                <StudyOutputs events={runEvents} apiBaseUrl={apiBaseUrl} />
            )}
        </React.Fragment>
    );
}
