import { useCallback, useState } from "react";

import AppShell from "../components/AppShell";
import MeetingRoom from "../components/MeetingRoom";
import { useAuth } from "../context/auth-context";
import "./Practice.css";

export default function Practice() {
  const { user } = useAuth();
  const [phase, setPhase] = useState("lobby");

  const handlePhaseChange = useCallback((next) => setPhase(next), []);
  const live = phase === "meeting";

  // A live meeting runs full-bleed so nothing competes with the mic controls.
  // Before it starts, and after it ends, the app navigation stays put so you
  // can reach Home or Reports without going back through the browser.
  //
  // The element tree is deliberately identical in both states - only classes
  // and the `bare` flag change. Swapping the wrapper instead would unmount
  // MeetingRoom mid-session and throw away its session id.
  return (
    <AppShell bare={live}>
      <div className={live ? "practice-live" : "practice-frame"}>
        <MeetingRoom userName={user?.full_name?.split(" ")[0]} onPhaseChange={handlePhaseChange} />
      </div>
    </AppShell>
  );
}
