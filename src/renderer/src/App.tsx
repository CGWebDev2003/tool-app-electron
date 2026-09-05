import { useCallback, useEffect, useState } from "react";
import Sidebar, { type RouteId } from "./components/Sidebar";
import Dashboard from "./pages/Dashboard";
import YoutubeDownload from "./pages/YoutubeDownload";
import Converter from "./pages/Converter";
import { useToolStatus } from "./hooks/useToolStatus";
import styles from "./App.module.css";

function routeFromHash(): RouteId {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash === "youtube-download" || hash === "converter") return hash;
  return "dashboard";
}

export default function App() {
  const [route, setRoute] = useState<RouteId>(routeFromHash);
  const status = useToolStatus();

  // Hash-based routing keeps the back/forward shortcuts working and survives
  // renderer hot reloads without losing the current page.
  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((next: RouteId) => {
    window.location.hash = next === "dashboard" ? "/" : `/${next}`;
  }, []);

  return (
    <div className={styles.shell}>
      <Sidebar active={route} onNavigate={navigate} />
      <main className={styles.content}>
        {route === "dashboard" && <Dashboard status={status} onNavigate={navigate} />}
        {route === "youtube-download" && <YoutubeDownload status={status} />}
        {route === "converter" && <Converter status={status} />}
      </main>
    </div>
  );
}
