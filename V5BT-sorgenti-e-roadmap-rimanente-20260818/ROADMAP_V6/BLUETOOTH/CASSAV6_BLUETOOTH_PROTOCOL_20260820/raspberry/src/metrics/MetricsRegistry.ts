export interface NodeMetricsSnapshot {
  readonly state: string;
  readonly stateTransitionsTotal: number;
  readonly startAttemptsTotal: number;
  readonly startsTotal: number;
  readonly startFailuresTotal: number;
  readonly stopsTotal: number;
  readonly adapterErrorsTotal: number;
  readonly scannerErrorsTotal: number;
  readonly maintenanceFailuresTotal: number;
  readonly maintenanceRunsTotal: number;
  readonly peersPrunedTotal: number;
  readonly observationsTotal: number;
  readonly observationsAcceptedTotal: number;
  readonly observationsRejectedTotal: number;
  readonly lateObservationsIgnoredTotal: number;
  readonly currentPeers: number;
  readonly peerHighWatermark: number;
  readonly lastObservationOutcome: string | null;
}

export class MetricsRegistry {
  #state = "IDLE";
  #stateTransitionsTotal = 0;
  #startAttemptsTotal = 0;
  #startsTotal = 0;
  #startFailuresTotal = 0;
  #stopsTotal = 0;
  #adapterErrorsTotal = 0;
  #scannerErrorsTotal = 0;
  #maintenanceFailuresTotal = 0;
  #maintenanceRunsTotal = 0;
  #peersPrunedTotal = 0;
  #observationsTotal = 0;
  #observationsAcceptedTotal = 0;
  #observationsRejectedTotal = 0;
  #lateObservationsIgnoredTotal = 0;
  #currentPeers = 0;
  #peerHighWatermark = 0;
  #lastObservationOutcome: string | null = null;

  recordStateTransition(state: string): void {
    this.#state = state;
    this.#stateTransitionsTotal += 1;
  }

  recordStartAttempt(): void {
    this.#startAttemptsTotal += 1;
  }

  recordStarted(): void {
    this.#startsTotal += 1;
  }

  recordStartFailure(): void {
    this.#startFailuresTotal += 1;
  }

  recordStopped(): void {
    this.#stopsTotal += 1;
  }

  recordAdapterError(): void {
    this.#adapterErrorsTotal += 1;
  }

  recordScannerError(): void {
    this.#scannerErrorsTotal += 1;
  }

  recordLateObservation(): void {
    this.#lateObservationsIgnoredTotal += 1;
  }

  recordObservation(input: {
    accepted: boolean;
    outcome: string;
    currentPeers: number;
  }): void {
    this.#observationsTotal += 1;
    this.#lastObservationOutcome = input.outcome;
    if (input.accepted) {
      this.#observationsAcceptedTotal += 1;
    } else {
      this.#observationsRejectedTotal += 1;
    }
    this.recordCurrentPeers(input.currentPeers);
  }

  recordMaintenance(removedPeers: number, currentPeers: number): void {
    this.#maintenanceRunsTotal += 1;
    this.#peersPrunedTotal += removedPeers;
    this.recordCurrentPeers(currentPeers);
  }

  recordMaintenanceFailure(): void {
    this.#maintenanceFailuresTotal += 1;
  }

  recordCurrentPeers(currentPeers: number): void {
    this.#currentPeers = currentPeers;
    this.#peerHighWatermark = Math.max(
      this.#peerHighWatermark,
      currentPeers
    );
  }

  snapshot(): Readonly<NodeMetricsSnapshot> {
    return Object.freeze({
      state: this.#state,
      stateTransitionsTotal: this.#stateTransitionsTotal,
      startAttemptsTotal: this.#startAttemptsTotal,
      startsTotal: this.#startsTotal,
      startFailuresTotal: this.#startFailuresTotal,
      stopsTotal: this.#stopsTotal,
      adapterErrorsTotal: this.#adapterErrorsTotal,
      scannerErrorsTotal: this.#scannerErrorsTotal,
      maintenanceFailuresTotal: this.#maintenanceFailuresTotal,
      maintenanceRunsTotal: this.#maintenanceRunsTotal,
      peersPrunedTotal: this.#peersPrunedTotal,
      observationsTotal: this.#observationsTotal,
      observationsAcceptedTotal: this.#observationsAcceptedTotal,
      observationsRejectedTotal: this.#observationsRejectedTotal,
      lateObservationsIgnoredTotal: this.#lateObservationsIgnoredTotal,
      currentPeers: this.#currentPeers,
      peerHighWatermark: this.#peerHighWatermark,
      lastObservationOutcome: this.#lastObservationOutcome
    });
  }
}
