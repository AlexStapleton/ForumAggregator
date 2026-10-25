import { useCallback, useEffect, useState } from "react";
import type { AuthStatus } from "@fa/shared";
import { api, errorMessage } from "./api";
import { Alert } from "./components";
import { FeedPage } from "./pages/FeedPage";
import { LinkPage, linkFromHash } from "./pages/LinkPage";
import { LoginPage } from "./pages/LoginPage";
import { SecurityPage } from "./pages/SecurityPage";
import { SetupPage } from "./pages/SetupPage";
import { SourcesPage } from "./pages/SourcesPage";

type Route = "feed" | "sources" | "settings";

function routeFromHash(): Route {
  if (location.hash === "#/settings") return "settings";
  if (location.hash === "#/sources") return "sources";
  return "feed";
}

export function App() {
  const [status, setStatus] = useState<AuthStatus>();
  const [loadError, setLoadError] = useState<string>();
  const [route, setRoute] = useState<Route>(routeFromHash);
  // An invitation or password-reset link (D-114), shown whether or not someone is logged in here.
  const [link, setLink] = useState(() => linkFromHash(location.hash));

  const refresh = useCallback(async () => {
    try {
      setStatus(await api<AuthStatus>("GET", "/api/auth/status"));
      setLoadError(undefined);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onHash = () => {
      setRoute(routeFromHash());
      setLink(linkFromHash(location.hash));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [refresh]);

  if (loadError) {
    return (
      <main className="auth-page">
        <Alert>{loadError}</Alert>
        <button onClick={() => void refresh()}>Retry</button>
      </main>
    );
  }
  if (link) {
    return (
      <LinkPage
        token={link.token}
        onDone={() => {
          setLink(null);
          setRoute("feed");
          void refresh();
        }}
      />
    );
  }
  if (!status) return <main className="auth-page" aria-busy="true" />;
  if (status.setupRequired) return <SetupPage onDone={refresh} />;
  if (!status.authenticated) return <LoginPage authMode={status.authMode} onDone={refresh} />;

  const logout = async () => {
    await api("POST", "/api/auth/logout").catch(() => undefined);
    await refresh();
  };

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/">
          <img src="/icon.svg" alt="" width={24} height={24} />
          <span>ForumAggregator</span>
        </a>
        <nav>
          <a href="#/" aria-current={route === "feed" ? "page" : undefined}>Feed</a>
          <a href="#/sources" aria-current={route === "sources" ? "page" : undefined}>Sources</a>
          <a href="#/settings" aria-current={route === "settings" ? "page" : undefined}>Settings</a>
          {status.via === "session" && (
            <button className="link" onClick={() => void logout()}>Log out</button>
          )}
        </nav>
      </header>
      <main className="content">
        {route === "feed" && <FeedPage />}
        {route === "sources" && <SourcesPage />}
        {route === "settings" && <SecurityPage status={status} onChange={refresh} />}
      </main>
    </div>
  );
}
