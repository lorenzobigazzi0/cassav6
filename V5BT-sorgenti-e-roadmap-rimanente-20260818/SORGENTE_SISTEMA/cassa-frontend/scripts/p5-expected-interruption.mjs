export function createExpectedInterruptionRequestTracker(isExpectedInterruption) {
  if (typeof isExpectedInterruption !== "function") {
    throw new TypeError("isExpectedInterruption deve essere una funzione.");
  }

  const expectedRequests = new WeakSet();

  return {
    observe(request) {
      if (request && isExpectedInterruption()) expectedRequests.add(request);
    },
    includes(request) {
      return Boolean(request && expectedRequests.has(request));
    },
  };
}
