export function createPostazioneSyncCoordinator({
  execute,
  canRun = () => true,
  cooldownMs = 0,
  now = () => Date.now(),
  schedule = (callback, delayMs) => setTimeout(callback, delayMs),
  clearScheduled = (timer) => clearTimeout(timer),
}) {
  if (typeof execute !== "function") {
    throw new TypeError("execute must be a function");
  }
  if (typeof canRun !== "function") {
    throw new TypeError("canRun must be a function");
  }
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0) {
    throw new TypeError("cooldownMs must be a non-negative number");
  }
  if (
    typeof now !== "function" ||
    typeof schedule !== "function" ||
    typeof clearScheduled !== "function"
  ) {
    throw new TypeError("cooldown clock functions must be callable");
  }

  let cancelled = false;
  let trailing = false;
  let executing = false;
  let runningPromise = null;
  let runningToken = null;
  let cooldownWait = null;
  let lastStartedAt = null;

  const isAllowed = () => !cancelled && canRun() === true;

  const waitForCooldown = () => {
    if (cooldownMs === 0 || lastStartedAt === null) return Promise.resolve();
    const remainingMs = cooldownMs - Math.max(0, now() - lastStartedAt);
    if (remainingMs <= 0) return Promise.resolve();

    return new Promise((resolve) => {
      const token = {};
      const finish = () => {
        if (cooldownWait?.token === token) cooldownWait = null;
        resolve();
      };
      const timer = schedule(finish, remainingMs);
      cooldownWait = { finish, timer, token };
    });
  };

  const drain = async () => {
    let lastResult = false;
    let lastError = null;
    const context = Object.freeze({
      isCancelled: () => !isAllowed(),
    });

    while (isAllowed()) {
      await waitForCooldown();
      if (!isAllowed()) return false;

      const queuedBeforePass = cooldownMs === 0 && trailing;
      trailing = false;
      lastStartedAt = now();
      executing = true;
      try {
        lastResult = await execute(context);
        lastError = null;
      } catch (error) {
        lastResult = false;
        lastError = error;
      } finally {
        executing = false;
      }
      const runAgain = (queuedBeforePass || trailing) && isAllowed();
      if (!runAgain) break;
      trailing = false;
    }

    if (!isAllowed()) return false;
    if (lastError) throw lastError;
    return lastResult;
  };

  const trigger = () => {
    if (!isAllowed()) return Promise.resolve(false);
    if (runningPromise) {
      // During cooldown the pending pass already covers incoming events.
      if (cooldownMs === 0 || executing) trailing = true;
      return runningPromise;
    }

    const token = {};
    runningToken = token;
    runningPromise = Promise.resolve()
      .then(drain)
      .finally(() => {
        if (runningToken === token) {
          runningToken = null;
          runningPromise = null;
        }
      });
    return runningPromise;
  };

  return Object.freeze({
    trigger,
    cancel() {
      cancelled = true;
      trailing = false;
      if (cooldownWait) {
        const pendingWait = cooldownWait;
        cooldownWait = null;
        clearScheduled(pendingWait.timer);
        pendingWait.finish();
      }
    },
    status() {
      return Object.freeze({
        cancelled,
        running: runningPromise !== null,
        trailing,
      });
    },
  });
}

export function createSingleFlight(execute) {
  if (typeof execute !== "function") {
    throw new TypeError("execute must be a function");
  }

  let runningPromise = null;
  let runningToken = null;

  return Object.freeze({
    run(...args) {
      if (runningPromise) return runningPromise;

      const token = {};
      runningToken = token;
      runningPromise = Promise.resolve()
        .then(() => execute(...args))
        .finally(() => {
          if (runningToken === token) {
            runningToken = null;
            runningPromise = null;
          }
        });
      return runningPromise;
    },
    isRunning() {
      return runningPromise !== null;
    },
  });
}
