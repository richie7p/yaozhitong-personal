// GIS delivers a Google ID token to Firebase; it does not grant application
// access. Firebase and the authenticated backend still verify the identity.
const SCRIPT_URL = "https://accounts.google.com/gsi/client?hl=zh_TW";
const LOAD_TIMEOUT_MS = 15_000;
const LOAD_ERROR =
  "Google 登入按鈕載入失敗，請重試或使用電子信箱登入。";
const SIGN_IN_ERROR =
  "Google 登入未完成，請重試或使用電子信箱登入。";

interface CredentialResponse {
  credential?: string;
  state?: string;
}
interface GoogleIdentity {
  initialize(options: {
    client_id: string;
    callback: (response: CredentialResponse) => void;
    auto_select: false;
    button_auto_select: false;
    ux_mode: "popup";
  }): void;
  renderButton(
    element: HTMLElement,
    options: {
      type: "standard";
      theme: "outline";
      size: "large";
      text: "signin_with";
      shape: "rectangular";
      locale: "zh_TW";
      width: number;
      state: string;
    },
  ): void;
}
type GoogleWindow = Window & {
  google?: { accounts?: { id?: GoogleIdentity } };
};
const scriptLoads = new WeakMap<Document, Promise<GoogleIdentity>>();

function availableIdentity(document: Document) {
  const identity = (document.defaultView as GoogleWindow | null)?.google?.accounts
    ?.id;
  return identity &&
    typeof identity.initialize === "function" &&
    typeof identity.renderButton === "function"
    ? identity
    : undefined;
}

export function loadGoogleIdentity(document: Document): Promise<GoogleIdentity> {
  const ready = availableIdentity(document);
  if (ready) return Promise.resolve(ready);
  const previous = scriptLoads.get(document);
  if (previous) return previous;
  const script = document.createElement("script");
  script.src = SCRIPT_URL;
  script.async = true;
  script.defer = true;
  const loading = new Promise<GoogleIdentity>((resolve, reject) => {
    let settled = false;
    const finish = (identity?: GoogleIdentity) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.removeEventListener("load", onLoad);
      script.removeEventListener("error", onError);
      if (identity) resolve(identity);
      else {
        script.remove();
        reject(new Error(LOAD_ERROR));
      }
    };
    const onLoad = () => finish(availableIdentity(document));
    const onError = () => finish();
    const timer = setTimeout(onError, LOAD_TIMEOUT_MS);
    script.addEventListener("load", onLoad);
    script.addEventListener("error", onError);
    document.head.appendChild(script);
  });
  scriptLoads.set(document, loading);
  void loading.catch(() => {
    if (scriptLoads.get(document) === loading) scriptLoads.delete(document);
  });
  return loading;
}

interface Broker {
  clientId: string;
  receivers: Map<string, (response: CredentialResponse) => void>;
}
const brokers = new WeakMap<GoogleIdentity, Broker>();

function credentialBroker(identity: GoogleIdentity, clientId: string) {
  const existing = brokers.get(identity);
  if (existing) {
    // GIS configuration is global. Never silently change the client/audience of
    // an already-open login flow.
    if (existing.clientId !== clientId) throw new Error(LOAD_ERROR);
    return existing;
  }
  const broker: Broker = { clientId, receivers: new Map() };
  identity.initialize({
    client_id: clientId,
    auto_select: false,
    button_auto_select: false,
    ux_mode: "popup",
    callback: (response) => {
      // The documented button state routes the response to its live mount.
      // This is lifecycle correlation, not a substitute for token verification.
      if (typeof response?.state === "string")
        broker.receivers.get(response.state)?.(response);
    },
  });
  brokers.set(identity, broker);
  return broker;
}

export type GoogleButtonStatus =
  | "loading"
  | "ready"
  | "busy"
  | "complete"
  | "error";

export function mountGoogleSignInButton(
  element: HTMLElement,
  options: {
    clientId: string;
    onCredential: (idToken: string) => Promise<void>;
    onStatus: (status: GoogleButtonStatus) => void;
    onError: (message: string) => void;
    isDisabled: () => boolean;
  },
) {
  let disposed = false;
  let consumed = false;
  let broker: Broker | undefined;
  let state = "";
  let resize: ResizeObserver | undefined;
  options.onStatus("loading");
  const fail = (message: string) => {
    if (disposed) return;
    consumed = true;
    options.onStatus("error");
    options.onError(message);
  };
  void (async () => {
    try {
      if (!/^[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(options.clientId))
        throw new Error(LOAD_ERROR);
      const identity = await loadGoogleIdentity(element.ownerDocument);
      if (disposed) return;
      broker = credentialBroker(identity, options.clientId);
      state = crypto.randomUUID();
      broker.receivers.set(state, (response) => {
        if (disposed || consumed || options.isDisabled()) return;
        consumed = true;
        if (
          typeof response.credential !== "string" ||
          !response.credential.trim()
        ) {
          fail(SIGN_IN_ERROR);
          return;
        }
        options.onStatus("busy");
        // Do not save or log this token. Duplicate and stale callbacks are
        // ignored, including while the authenticated bootstrap is in flight.
        void Promise.resolve()
          .then(() => {
            if (!disposed) return options.onCredential(response.credential!);
          })
          .then(() => {
            if (!disposed) options.onStatus("complete");
          })
          .catch(() => fail(SIGN_IN_ERROR));
      });
      let previousWidth = 0;
      const render = () => {
        if (disposed || consumed) return;
        const width = Math.min(
          400,
          Math.max(1, Math.floor(element.getBoundingClientRect().width || 280)),
        );
        if (previousWidth === width) return;
        previousWidth = width;
        element.replaceChildren();
        identity.renderButton(element, {
          type: "standard",
          theme: "outline",
          size: "large",
          text: "signin_with",
          shape: "rectangular",
          locale: "zh_TW",
          width,
          state,
        });
      };
      render();
      if (typeof ResizeObserver !== "undefined") {
        resize = new ResizeObserver(() => {
          try {
            render();
          } catch {
            fail(LOAD_ERROR);
          }
        });
        resize.observe(element);
      }
      options.onStatus("ready");
    } catch {
      fail(LOAD_ERROR);
    }
  })();
  return () => {
    disposed = true;
    if (state) broker?.receivers.delete(state);
    resize?.disconnect();
    element.replaceChildren();
  };
}
