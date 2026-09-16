import React from "react";
import ReactMarkdown from "react-markdown";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowUp } from "@fortawesome/free-solid-svg-icons";
import { nodeTitle } from "./studyRunModel";
import { remarkStudyCitations } from "./studyCitations";
import "./StudyAnswer.css";

export default function StudyAnswer({ text, study, onSelectArtifact }) {
  if (!study) return <ReactMarkdown>{text}</ReactMarkdown>;
  return (
    <ReactMarkdown
      remarkPlugins={[remarkStudyCitations]}
      components={{
        "study-citation": ({ node }) => {
          const artifactId = node.properties["data-artifact-id"];
          const artifact = study.artifacts.get(artifactId);
          if (!artifact)
            return (
              <span
                className="HPAG-study-citation is-unavailable"
                title={`Artifact ${artifactId} is not available in this study`}
              >
                [{artifactId}]
              </span>
            );
          const title = nodeTitle(artifact);
          return (
            <button
              type="button"
              className="HPAG-study-citation"
              onClick={() => onSelectArtifact(artifactId)}
              aria-label={`View artifact ${artifactId}: ${title}`}
              title={`View ${artifactId} · ${title}`}
            >
              <span>{artifactId}</span>
              <FontAwesomeIcon icon={faArrowUp} />
            </button>
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
