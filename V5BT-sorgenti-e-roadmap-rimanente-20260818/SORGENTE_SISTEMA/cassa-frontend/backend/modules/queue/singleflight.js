export function createSingleflight(task, options = {}) {
  if (typeof task !== "function") {
    throw new Error("singleflight richiede una funzione task.");
  }
  const onStart = typeof options.onStart === "function" ? options.onStart : () => {};
  const onJoin = typeof options.onJoin === "function" ? options.onJoin : () => {};
  let inFlight = null;

  return function run(...args) {
    if (inFlight) {
      onJoin();
      return inFlight;
    }
    onStart();
    const current = Promise.resolve().then(() => task(...args));
    inFlight = current;
    void current.then(
      () => {
        if (inFlight === current) inFlight = null;
      },
      () => {
        if (inFlight === current) inFlight = null;
      },
    );
    return current;
  };
}
