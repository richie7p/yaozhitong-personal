import { useEffect, useRef, useState } from "react";
import {
  mountGoogleSignInButton,
  type GoogleButtonStatus,
} from "./google-identity";

interface GoogleSignInButtonProps {
  clientId: string;
  onCredential: (idToken: string) => Promise<void>;
  disabled?: boolean;
  onError?: (message: string) => void;
}

export function GoogleSignInButton(props: GoogleSignInButtonProps) {
  const container = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  current.current = props;
  const [status, setStatus] = useState<GoogleButtonStatus>("loading");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    setError("");
    return mountGoogleSignInButton(element, {
      clientId: props.clientId,
      onCredential: (token) => current.current.onCredential(token),
      isDisabled: () => !!current.current.disabled,
      onStatus: setStatus,
      onError: (message) => {
        setError(message);
        current.current.onError?.(message);
      },
    });
  }, [props.clientId, attempt]);
  const blocked =
    !!props.disabled ||
    status === "busy" ||
    status === "complete" ||
    status === "error";
  return (
    <div style={{ width: "100%", minWidth: 0 }}>
      <div
        ref={container}
        inert={blocked}
        aria-disabled={blocked || undefined}
        style={{
          width: "100%",
          minHeight: 44,
          opacity: blocked ? 0.65 : 1,
          pointerEvents: blocked ? "none" : undefined,
        }}
      />
      <div role="status" aria-live="polite">
        {status === "loading" && <p className="muted">正在載入 Google 登入…</p>}
        {status === "busy" && <p className="muted">正在確認 Google 登入…</p>}
      </div>
      {error && (
        <div className="notice error" role="alert">
          <div>
            <p>{error}</p>
            <button
              type="button"
              className="btn secondary"
              disabled={props.disabled}
              onClick={() => setAttempt((value) => value + 1)}
            >
              重試 Google 登入
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
