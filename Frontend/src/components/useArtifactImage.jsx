import { useEffect, useState } from "react";
import { authenticatedFetch } from "../api/auth";

// Workspace images use the same authenticated artifact route in the inspector
// and gallery. Each mounted image owns and releases its object URL.
export default function useArtifactImage(apiBaseUrl, workspaceUuid, filename) {
  const path =
    apiBaseUrl && workspaceUuid && filename
      ? `${apiBaseUrl}/workspaces/${workspaceUuid}/artifacts/${encodeURIComponent(filename)}`
      : null;
  const [image, setImage] = useState({ path: null, url: null, error: null });
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    let active = true;
    let objectUrl;
    setImage({ path, url: null, error: null });
    (async () => {
      try {
        const response = await authenticatedFetch(path, {
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(`Figure unavailable (HTTP ${response.status}).`);
        const blob = await response.blob();
        if (!blob.type.startsWith("image/"))
          throw new Error("The saved artifact is not an image.");
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setImage({ path, url: objectUrl, error: null });
      } catch (error) {
        if (active && error.name !== "AbortError")
          setImage({ path, url: null, error: error.message });
      }
    })();
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);
  if (!path)
    return { url: null, error: "Figure image is unavailable for this run." };
  return image.path === path ? image : { url: null, error: null };
}
