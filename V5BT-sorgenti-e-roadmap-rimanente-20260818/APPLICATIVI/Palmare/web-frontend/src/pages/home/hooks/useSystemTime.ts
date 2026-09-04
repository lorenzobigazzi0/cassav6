import { useEffect, useMemo, useState } from "react";

export function useSystemTime(locale = "it-IT") {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let intervalId: number | null = null;
    const current = new Date();
    const nextMinuteDelay =
      60_000 - (current.getSeconds() * 1000 + current.getMilliseconds()) + 50;
    const timeoutId = window.setTimeout(() => {
      setNow(new Date());
      intervalId = window.setInterval(() => setNow(new Date()), 60_000);
    }, nextMinuteDelay);
    return () => {
      window.clearTimeout(timeoutId);
      if (intervalId !== null) window.clearInterval(intervalId);
    };
  }, []);

  const timeLabel = useMemo(() => {
    return new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(now);
  }, [now, locale]);

  return timeLabel;
}
