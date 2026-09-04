import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { MobileBatteryWidget } from "./MobileBatteryWidget";
import { useSystemTime } from "../hooks/useSystemTime";
import { formatPttElapsed, formatRadioSpeakerName } from "../../../radio/radioProtocol";
import { normalizeRadioColor } from "../../../radio/radioUi";
import type { IncomingRadioState, OutgoingRadioState } from "../../../radio/radioTypes";
import { useOptionalRadio } from "../../../radio/useRadio";

const RADIO_PILL_LINGER_MS = 1000;
const RADIO_PILL_COLLAPSE_MS = 240;
const RADIO_PILL_WAVEFORM_BAR_COUNT = 12;
const RADIO_PILL_CHANNEL_MARQUEE_MIN_LENGTH = 12;
const RADIO_PILL_WAVEFORM_FALLBACK_LEVELS = [
  0.18, 0.3, 0.52, 0.76, 0.62, 0.34, 0.22, 0.42, 0.7, 0.56, 0.32, 0.2,
];

type RadioPillActivity =
  | { kind: "incoming"; incoming: IncomingRadioState; levels: number[] }
  | { kind: "outgoing"; outgoing: OutgoingRadioState; levels: number[] };

export function SystemRow({
  timeLabel,
  showBattery = true,
  showRadioPill = showBattery,
}: {
  timeLabel?: string;
  showBattery?: boolean;
  showRadioPill?: boolean;
}) {
  const liveTimeLabel = useSystemTime();
  const resolvedTimeLabel = timeLabel ?? liveTimeLabel;
  const radio = useOptionalRadio();
  const incoming = showRadioPill ? (radio?.incoming ?? null) : null;
  const outgoing = showRadioPill ? (radio?.outgoing ?? null) : null;
  const liveActivity = useMemo<RadioPillActivity | null>(
    () =>
      outgoing
        ? { kind: "outgoing", outgoing, levels: radio?.audioLevels ?? [] }
        : incoming
          ? { kind: "incoming", incoming, levels: radio?.incomingAudioLevels ?? [] }
          : null,
    [incoming, outgoing, radio?.audioLevels, radio?.incomingAudioLevels]
  );
  const [visibleActivity, setVisibleActivity] = useState<RadioPillActivity | null>(liveActivity);
  const [closingActivity, setClosingActivity] = useState(false);
  const [pttNow, setPttNow] = useState(() => Date.now());

  useEffect(() => {
    if (outgoing) {
      setPttNow(Date.now());
      const timer = window.setInterval(() => setPttNow(Date.now()), 250);
      return () => window.clearInterval(timer);
    }
    return undefined;
  }, [outgoing]);

  useEffect(() => {
    if (liveActivity) {
      setVisibleActivity(liveActivity);
      setClosingActivity(false);
      return undefined;
    }
    if (!visibleActivity) return undefined;
    let collapseTimer: number | null = null;
    const lingerTimer = window.setTimeout(() => {
      setClosingActivity(true);
      collapseTimer = window.setTimeout(() => {
        setVisibleActivity(null);
        setClosingActivity(false);
      }, RADIO_PILL_COLLAPSE_MS);
    }, RADIO_PILL_LINGER_MS);
    return () => {
      window.clearTimeout(lingerTimer);
      if (collapseTimer !== null) window.clearTimeout(collapseTimer);
    };
  }, [liveActivity, visibleActivity]);

  useEffect(() => {
    if (visibleActivity) return undefined;
    setClosingActivity(false);
    return undefined;
  }, [visibleActivity]);

  return (
    <div className="system-row">
      <time className="system-time" aria-label={`Ora ${resolvedTimeLabel}`}>
        {resolvedTimeLabel}
      </time>
      <div className="system-radio-pill-slot" aria-live="polite">
        {visibleActivity ? (
          <RadioActivityPill activity={visibleActivity} closing={closingActivity} now={pttNow} />
        ) : null}
      </div>
      <div className="system-status" aria-label="Stato sistema">
        {showBattery ? <MobileBatteryWidget /> : null}
      </div>
    </div>
  );
}

function RadioPillWaveform({ levels }: { levels: number[] }) {
  const resolvedLevels =
    levels.length > 0
      ? levels.slice(0, RADIO_PILL_WAVEFORM_BAR_COUNT)
      : RADIO_PILL_WAVEFORM_FALLBACK_LEVELS;

  return (
    <span className="radio-pill-waveform" aria-hidden="true">
      {resolvedLevels.map((level, index) => (
        <i
          key={`${index}-${resolvedLevels.length}`}
          style={
            {
              "--radio-pill-wave-delay": `${index * -42}ms`,
              "--radio-pill-wave-level": Math.max(0.04, Math.min(1, level)),
            } as CSSProperties
          }
        />
      ))}
    </span>
  );
}

function RadioPillChannelName({ name }: { name: string }) {
  const shouldScroll = name.trim().length >= RADIO_PILL_CHANNEL_MARQUEE_MIN_LENGTH;
  return (
    <span
      className={`radio-incoming-channel radio-pill-channel${shouldScroll ? " is-marquee" : ""}`}
      title={name}
    >
      <span className="radio-pill-channel-viewport">
        <span className="radio-pill-channel-track">
          <span className="radio-pill-channel-text">{name}</span>
          {shouldScroll ? (
            <span className="radio-pill-channel-text radio-pill-channel-copy" aria-hidden="true">
              {name}
            </span>
          ) : null}
        </span>
      </span>
    </span>
  );
}

export function RadioActivityPill({
  activity,
  closing,
  now,
}: {
  activity: RadioPillActivity;
  closing?: boolean;
  now?: number;
}) {
  const isOutgoing = activity.kind === "outgoing";
  const channelColor = isOutgoing ? activity.outgoing.channelColor : activity.incoming.channelColor;
  const channelName = isOutgoing ? activity.outgoing.channelName : activity.incoming.channelName;
  const style = {
    "--radio-pill-color": normalizeRadioColor(channelColor, 0),
  } as CSSProperties;

  if (isOutgoing) {
    return (
      <div
        className={`radio-incoming-pill radio-activity-pill is-outgoing${closing ? " is-closing" : ""}`}
        style={style}
        aria-label="Trasmissione radio in corso"
      >
        <RadioPillChannelName name={channelName} />
        <RadioPillWaveform levels={activity.levels} />
        <span className="radio-pill-timer">
          {formatPttElapsed((now ?? Date.now()) - activity.outgoing.startedAt)}
        </span>
      </div>
    );
  }

  const speakerName = formatRadioSpeakerName(
    activity.incoming.speaker.fullName,
    activity.incoming.speaker.displayName || activity.incoming.speaker.userId
  );

  return (
    <div
      className={`radio-incoming-pill radio-activity-pill is-incoming${closing ? " is-closing" : ""}`}
      style={style}
      aria-label="Trasmissione radio in arrivo"
    >
      <span className="radio-incoming-channel">{channelName}</span>
      <RadioPillWaveform levels={activity.levels} />
      <span className="radio-incoming-speaker">{speakerName}</span>
    </div>
  );
}

export function RadioIncomingPill({
  incoming,
  closing,
}: {
  incoming: IncomingRadioState;
  closing?: boolean;
}) {
  return (
    <RadioActivityPill activity={{ kind: "incoming", incoming, levels: [] }} closing={closing} />
  );
}
