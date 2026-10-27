import { build } from "esbuild";
import { createServer } from "node:http";
import { createHash } from "node:crypto";

/** Real AuthProvider and push lifecycle; only Firebase/provider/HTTP boundaries
 * are synthetic. Both pages use the browser's actual shared Web Locks. */
export async function pushSessionHarness() {
  const source = process.cwd();
  const expectedDeviceId = createHash("sha256")
    .update("synthetic-shared-token")
    .digest("hex");
  const mocks: Record<string, string> = {
    "firebase/app": "export const initializeApp=()=>({});",
    "firebase/auth":
      "export const linkWithCredential=async()=>{};export const EmailAuthProvider={credential:()=>({})};",
    "firebase/messaging": `
      export const getMessaging=()=>({});
      export const getToken=async()=>{window.pushProbe.getCalls++;await fetch('/provider/get',{method:'POST'});return 'synthetic-shared-token';};
      export const deleteToken=async()=>{window.pushProbe.deleteCalls++;await fetch('/provider/delete',{method:'POST'});};
      export const isSupported=async()=>true;`,
    "./api": `
      export const api=async(path)=>{
        if(path==='/config')return {mode:'firebase',firebase:{apiKey:'synthetic'},vapidKey:'synthetic'};
        if(path==='/me')return {account:{id:window.pushProbe.auth.currentUser.uid},profile:null};return {};
      };export const setJobIdentity=()=>{};export const setTokenProvider=()=>{};`,
    "./google-auth": `
      export const createSessionFirebaseAuth=()=>window.pushProbe.auth;
      export const observeFirebaseSession=async(auth,onUser)=>{window.pushProbe.onUser=onUser;await onUser(auth.currentUser,()=>true);return ()=>{window.pushProbe.onUser=null;};};
      export const commitFirebaseSession=async()=>{};export const configureFirebaseTokenProvider=()=>{};
      export const clearFirebaseSession=async(auth)=>{auth.currentUser=null;await window.pushProbe.onUser?.(null,()=>true);};
      export const firebaseSessionNeedsReload=()=>false;export const linkGoogle=async()=>{};
      export const signInGoogle=async()=>{};export const signInGoogleCredential=async()=>{};`,
    "./email-auth": `
      export const signInEmail=async(auth)=>{auth.currentUser=window.pushProbe.user('synthetic-B');await window.pushProbe.onUser?.(auth.currentUser,()=>true);return '';};
      export const refreshEmailVerification=async()=>{};`,
  };
  const bundle = await build({
    stdin: {
      contents: `import React from 'react';import{createRoot}from'react-dom/client';import{AuthProvider,useAuth}from'./src/auth.tsx';function Probe(){window.authProbe=useAuth();return null;}createRoot(document.getElementById('root')).render(<AuthProvider><Probe/></AuthProvider>);`,
      resolveDir: source,
      loader: "tsx",
    },
    bundle: true,
    format: "iife",
    write: false,
    platform: "browser",
    jsx: "automatic",
    plugins: [
      {
        name: "synthetic-auth-boundaries",
        setup(plugin) {
          plugin.onResolve(
            { filter: /^(firebase\/|\.\/(api|google-auth|email-auth)$)/ },
            (args) =>
              mocks[args.path]
                ? { path: args.path, namespace: "synthetic" }
                : undefined,
          );
          plugin.onLoad({ filter: /.*/, namespace: "synthetic" }, (args) => ({
            contents: mocks[args.path],
            loader: "js",
          }));
        },
      },
    ],
  });
  let state = {
    owner: "synthetic-A" as string | null,
    active: true,
    gets: 0,
    deletes: 0,
    posts: [] as string[],
    deleteStatuses: [] as number[],
  };
  let getGate: Promise<void> | undefined, deleteGate: Promise<void> | undefined;
  let postGate: Promise<void> | undefined;
  let releaseGet = () => {},
    releaseDelete = () => {};
  let releasePost = () => {};
  let failDelete = false;
  const setup = `
    if(location.search.includes('fresh'))sessionStorage.removeItem('yzt-device-id');
    else sessionStorage.setItem('yzt-device-id','${expectedDeviceId}');
    const user=uid=>({uid,emailVerified:true,getIdToken:async()=>uid});
    window.pushProbe={user,auth:{currentUser:user('synthetic-A')},getCalls:0,deleteCalls:0};
    Object.defineProperty(window,'Notification',{value:{permission:'granted',requestPermission:async()=>'granted'}});
    Object.defineProperty(navigator,'serviceWorker',{value:{register:async()=>({})}});
  `;
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/provider/get") {
      state.gets++;
      await getGate;
      state.active = true;
      response.end("{}");
      return;
    }
    if (request.url === "/provider/delete") {
      state.deletes++;
      await deleteGate;
      state.active = false;
      response.end("{}");
      return;
    }
    if (request.url?.startsWith("/api/v1/devices")) {
      const owner =
        request.headers.authorization?.replace(/^Bearer /, "") || "";
      if (request.method === "POST") {
        state.owner = owner;
        state.posts.push(owner);
        await postGate;
        response.end(JSON.stringify({ id: expectedDeviceId }));
      } else {
        response.statusCode = failDelete
          ? 503
          : state.owner === owner &&
              request.url.endsWith("/" + expectedDeviceId)
            ? 200
            : 404;
        if (response.statusCode === 200) state.owner = null;
        state.deleteStatuses.push(response.statusCode);
        response.end("{}");
      }
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(
      '<div id="root"></div><script>' +
        setup +
        "</script><script>" +
        bundle.outputFiles[0].text +
        "</script>",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing synthetic address");
  return {
    url: "http://127.0.0.1:" + address.port,
    state: () => structuredClone(state),
    reset() {
      releaseGet();
      releaseDelete();
      releasePost();
      getGate = undefined;
      deleteGate = undefined;
      postGate = undefined;
      failDelete = false;
      state = {
        owner: "synthetic-A",
        active: true,
        gets: 0,
        deletes: 0,
        posts: [],
        deleteStatuses: [],
      };
    },
    holdGet() {
      getGate = new Promise<void>((resolve) => {
        releaseGet = resolve;
      });
    },
    releaseGet() {
      releaseGet();
      getGate = undefined;
    },
    holdDelete() {
      deleteGate = new Promise<void>((resolve) => {
        releaseDelete = resolve;
      });
    },
    releaseDelete() {
      releaseDelete();
      deleteGate = undefined;
    },
    holdPost() {
      postGate = new Promise<void>((resolve) => {
        releasePost = resolve;
      });
    },
    releasePost() {
      releasePost();
      postGate = undefined;
    },
    failDelete(value: boolean) {
      failDelete = value;
    },
    async close() {
      releaseGet();
      releaseDelete();
      releasePost();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
