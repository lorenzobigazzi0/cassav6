import { isRuntimeFeatureEnabled } from "../../config/runtimeConfig";

export function isClientOptimisticActionsEnabled() {
  return (
    isRuntimeFeatureEnabled("clientOptimisticActions") ||
    isRuntimeFeatureEnabled("CLIENT_OPTIMISTIC_ACTIONS")
  );
}

export function runBackgroundOptimisticRequest<T>(
  request: () => Promise<T>,
  handlers: {
    onSuccess?: (value: T) => void;
    onError?: (error: unknown) => void;
    onSettled?: () => void;
  } = {}
) {
  void request()
    .then((value) => {
      handlers.onSuccess?.(value);
    })
    .catch((error) => {
      handlers.onError?.(error);
    })
    .finally(() => {
      handlers.onSettled?.();
    });
}
