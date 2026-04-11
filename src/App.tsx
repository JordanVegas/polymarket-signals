import { startTransition, useEffect, useState } from "react";
import { Sidebar, SignalDetailModal } from "./components";
import {
  AboutPage,
  AuthStatusPage,
  ChatPage,
  FaqPage,
  HistoryPage,
  HomePage,
  LoginPage,
  MarketsPage,
  PrivacyPage,
  ResetPasswordPage,
  SignalsPage,
  SmartTradersPage,
  TermsPage,
} from "./pages";
import type { AppRoute, SignalSummary } from "./types";
import { nativeRoutes, normalizeRoute, pageTitles, recordLocalSignal } from "./utils";

function navigate(path: AppRoute) {
  if (window.location.pathname === path) {
    return;
  }

  window.history.pushState({}, "", path);
  startTransition(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

function App() {
  const [route, setRoute] = useState<AppRoute>(() => normalizeRoute(window.location.pathname));
  const [selectedSignal, setSelectedSignal] = useState<SignalSummary | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    document.documentElement.lang = "he";
    document.documentElement.dir = "rtl";
    document.body.classList.add("money-radar-react");

    const onPopState = () => {
      setRoute(normalizeRoute(window.location.pathname));
    };

    window.addEventListener("popstate", onPopState);
    return () => {
      document.body.classList.remove("money-radar-react");
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  useEffect(() => {
    setMobileOpen(false);
    document.title = pageTitles[route];
  }, [route]);

  const openSignal = (signal: SignalSummary) => {
    recordLocalSignal(signal, "viewed");
    setSelectedSignal(signal);
  };

  const trackAnalysis = (signal: SignalSummary) => {
    recordLocalSignal(signal, "analysis");
  };

  return (
    <div className="app-shell">
      <Sidebar
        route={route}
        mobileOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
        onOpen={() => setMobileOpen(true)}
        onNavigate={navigate}
      />
      <main className={`main-shell ${nativeRoutes.has(route) ? "" : "main-shell-bridge"}`}>
        {route === "/" ? <HomePage onOpenSignal={openSignal} onTrackAnalysis={trackAnalysis} navigate={navigate} /> : null}
        {route === "/login" ? <LoginPage navigate={navigate} /> : null}
        {route === "/about" ? <AboutPage /> : null}
        {route === "/faq" ? <FaqPage /> : null}
        {route === "/privacy" ? <PrivacyPage /> : null}
        {route === "/terms" ? <TermsPage /> : null}
        {route === "/signals" ? <SignalsPage onOpenSignal={openSignal} /> : null}
        {route === "/markets" ? <MarketsPage onOpenSignal={openSignal} /> : null}
        {route === "/smart-traders" ? <SmartTradersPage onOpenSignal={openSignal} /> : null}
        {route === "/chat" ? <ChatPage /> : null}
        {route === "/history" ? <HistoryPage onOpenSignal={openSignal} /> : null}
        {route === "/auth/callback" ? <AuthStatusPage mode="callback" navigate={navigate} /> : null}
        {route === "/auth/confirm" ? <AuthStatusPage mode="confirm" navigate={navigate} /> : null}
        {route === "/reset-password" ? <ResetPasswordPage navigate={navigate} /> : null}
      </main>
      {selectedSignal ? (
        <SignalDetailModal
          signal={selectedSignal}
          onClose={() => setSelectedSignal(null)}
          onTrackAnalysis={trackAnalysis}
        />
      ) : null}
    </div>
  );
}

export default App;
