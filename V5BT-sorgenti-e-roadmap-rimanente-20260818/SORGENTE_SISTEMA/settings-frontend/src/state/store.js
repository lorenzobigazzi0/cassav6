const listeners = new Set();

const initialState = {
  activeTab: "overview",
  sessionReady: false,
  workspace: null,
  draft: null,
  draftSnapshot: null,
  validation: null,
  loading: false,
  saving: false,
  dirty: false,
  error: "",
  toast: null,
  filter: "",
  simulatorResult: null,
  selectedVersionIds: [],
  advancedJson: false,
};

let state = structuredClone(initialState);

export function getState() {
  return state;
}

export function setState(patch) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  for (const listener of listeners) listener(state);
}

export function updateSnapshot(mutator, { dirty = true } = {}) {
  const snapshot = structuredClone(state.draftSnapshot ?? {});
  mutator(snapshot);
  setState({ draftSnapshot: snapshot, dirty, validation: null });
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetStore() {
  state = structuredClone(initialState);
  for (const listener of listeners) listener(state);
}

export function setToast(message, tone = "success", timeoutMs = 3500) {
  const token = `${Date.now()}_${Math.random()}`;
  setState({ toast: { message, tone, token } });
  globalThis.setTimeout(() => {
    if (getState().toast?.token === token) setState({ toast: null });
  }, timeoutMs);
}
