import { useCallback, useEffect, useRef, useState } from "react";

type BarcodeDetectorResultLike = {
  rawValue?: string;
};

type BarcodeDetectorLike = {
  detect: (source: HTMLVideoElement) => Promise<BarcodeDetectorResultLike[]>;
};

type BarcodeDetectorConstructorLike = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

type QrCameraScannerProps = {
  active: boolean;
  disabled?: boolean;
  onDetected: (payload: string) => void;
  onError: (message: string) => void;
};

const getBarcodeDetector = () =>
  typeof window === "undefined"
    ? null
    : ((window as unknown as { BarcodeDetector?: BarcodeDetectorConstructorLike }).BarcodeDetector ??
      null);

export function QrCameraScanner({
  active,
  disabled = false,
  onDetected,
  onError,
}: QrCameraScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const detectorRef = useRef<BarcodeDetectorLike | null>(null);
  const detectingRef = useRef(false);
  const startingRef = useRef(false);
  const autoStartAttemptedRef = useRef(false);
  const [cameraActive, setCameraActive] = useState(false);

  const stopCamera = useCallback(() => {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    detectingRef.current = false;
    setCameraActive(false);
  }, []);

  const resolveDetector = useCallback(() => {
    if (detectorRef.current) return detectorRef.current;
    const Detector = getBarcodeDetector();
    if (!Detector) return null;
    detectorRef.current = new Detector({ formats: ["qr_code"] });
    return detectorRef.current;
  }, []);

  const handleDetected = useCallback(
    (payload: string) => {
      const normalized = payload.trim();
      if (!normalized) return;
      stopCamera();
      onDetected(normalized);
    },
    [onDetected, stopCamera]
  );

  const scanVideoFrame = useCallback(() => {
    const detector = resolveDetector();
    const video = videoRef.current;
    if (!detector || !video || !cameraActive) return;

    const scheduleNext = () => {
      rafRef.current = window.requestAnimationFrame(scanVideoFrame);
    };

    if (detectingRef.current || video.readyState < 2) {
      scheduleNext();
      return;
    }

    detectingRef.current = true;
    void detector
      .detect(video)
      .then((codes) => {
        const payload = codes.find((code) => code.rawValue?.trim())?.rawValue ?? "";
        if (payload) {
          handleDetected(payload);
          return;
        }
        scheduleNext();
      })
      .catch(() => {
        scheduleNext();
      })
      .finally(() => {
        detectingRef.current = false;
      });
  }, [cameraActive, handleDetected, resolveDetector]);

  const startCamera = useCallback(async () => {
    if (disabled || startingRef.current || streamRef.current) return;
    startingRef.current = true;
    const detector = resolveDetector();
    if (!detector) {
      startingRef.current = false;
      onError("Scanner QR live non disponibile su questo dispositivo.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      startingRef.current = false;
      onError("Videocamera live non disponibile su questo dispositivo.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
        },
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        stopCamera();
        return;
      }
      video.srcObject = stream;
      await video.play();
      setCameraActive(true);
    } catch (caught) {
      const message =
        caught instanceof DOMException && caught.name === "NotAllowedError"
          ? "Permesso fotocamera negato."
          : "Impossibile avviare la videocamera live.";
      onError(message);
    } finally {
      startingRef.current = false;
    }
  }, [disabled, onError, resolveDetector, stopCamera]);

  useEffect(() => {
    if (cameraActive) {
      rafRef.current = window.requestAnimationFrame(scanVideoFrame);
    }
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [cameraActive, scanVideoFrame]);

  useEffect(() => {
    if (!active || disabled) {
      autoStartAttemptedRef.current = false;
      stopCamera();
      return;
    }
    if (!cameraActive && !streamRef.current && !autoStartAttemptedRef.current) {
      autoStartAttemptedRef.current = true;
      void startCamera();
    }
  }, [active, cameraActive, disabled, startCamera, stopCamera]);

  useEffect(() => stopCamera, [stopCamera]);

  return (
    <div className="payments-qr-scanner">
      <div className="payments-qr-view">
        <video
          ref={videoRef}
          className={`payments-qr-video ${cameraActive ? "is-active" : ""}`}
          playsInline
          muted
          aria-label="Scanner QR fondo cassa"
        />
        {!cameraActive ? (
          <div className="payments-qr-camera-placeholder" aria-hidden="true" />
        ) : null}
        <div className="payments-qr-frame" aria-hidden="true">
          <span className="payments-qr-corner is-top-left" />
          <span className="payments-qr-corner is-top-right" />
          <span className="payments-qr-corner is-bottom-left" />
          <span className="payments-qr-corner is-bottom-right" />
        </div>
      </div>
    </div>
  );
}
