import { useRef, useState } from "react";
import { cloudOrigin } from "./cloudProxy";
import { useAi } from "./aiStore";

/** The plaintext input is a short-lived draft. Saved secrets never enter the store. */
export function useCloudSettingsDraft() {
  const saved = useAi(s => s.config.cloud);
  const [url, setUrlState] = useState(saved.baseUrl);
  const [key, setKeyState] = useState("");
  const [cleared, setCleared] = useState(false);
  const draft = useRef({ url: saved.baseUrl, key: "", revision: 0 });
  const setUrl = (url: string) => {
    draft.current = { ...draft.current, url, revision: draft.current.revision + 1 };
    setUrlState(url);
  };
  const setKey = (key: string) => {
    draft.current = { ...draft.current, key, revision: draft.current.revision + 1 };
    setKeyState(key);
  };
  const save = async (clear = false) => {
    const snapshot = { ...draft.current };
    const previous = useAi.getState().config.cloud;
    const origin = cloudOrigin(snapshot.url);
    const sameOrigin = origin !== null && origin === cloudOrigin(previous.baseUrl);
    const nextKey = clear ? "" : snapshot.key.trim();
    const hasKey = !clear && (Boolean(nextKey) || (sameOrigin && Boolean(previous.hasKey || previous.apiKey)));
    if (!clear && !nextKey && snapshot.url.trim() === previous.baseUrl) return true;
    const ok = await useAi.getState().updateCloud({ baseUrl: snapshot.url.trim(), apiKey: nextKey, hasKey });
    if (!ok) return false;
    if (draft.current.revision === snapshot.revision) {
      draft.current.key = "";
      setKeyState("");
    }
    setCleared(!hasKey && Boolean(previous.hasKey || previous.apiKey));
    return true;
  };
  return { url, key, setUrl, setKey, cleared, save, hasKey: Boolean(saved.hasKey || saved.apiKey) };
}
