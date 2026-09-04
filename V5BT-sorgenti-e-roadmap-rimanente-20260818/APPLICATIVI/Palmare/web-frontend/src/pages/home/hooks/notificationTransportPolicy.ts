export type NotificationPullDecision = "discard" | "merge" | "snapshot";

export const isNotificationTransportLifecycleCurrent = (
  active: boolean,
  currentLifecycleKey: string,
  expectedLifecycleKey: string
) => active && currentLifecycleKey === expectedLifecycleKey;

export const decideNotificationPullApplication = (input: {
  lifecycleCurrent: boolean;
  requestSequence: number;
  lastAppliedSequence: number;
  streamRevisionAtStart: number;
  currentStreamRevision: number;
}): NotificationPullDecision => {
  if (!input.lifecycleCurrent || input.requestSequence < input.lastAppliedSequence) {
    return "discard";
  }
  if (input.streamRevisionAtStart !== input.currentStreamRevision) return "merge";
  return "snapshot";
};
