export type AppSection = "conversations" | "jobs";

export interface AppNavigationProps {
  readonly section: AppSection;
  readonly connected: boolean;
  readonly onSelect: (section: AppSection) => void;
}

function ConversationsIcon() {
  return (
    <svg viewBox="0 0 24 24" focusable="false">
      <path d="M5.75 5.25h12.5a2.5 2.5 0 0 1 2.5 2.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4.75 3.5v-3.5a2 2 0 0 1-2-2v-7.5a2.5 2.5 0 0 1 2.5-2.5Z" />
      <path d="M7.5 9.25h9M7.5 13.25h5.5" />
    </svg>
  );
}

function JobsIcon() {
  return (
    <svg viewBox="0 0 24 24" focusable="false">
      <circle cx="12" cy="12" r="8.75" />
      <path d="M12 7.25v5.15l3.4 2.1" />
      <path className="navigation-icon-accent" d="M5.8 3.9 3.65 6.05M18.2 3.9l2.15 2.15" />
    </svg>
  );
}

export function AppNavigation({ section, connected, onSelect }: AppNavigationProps) {
  return (
    <nav className="app-navigation" aria-label="Application sections">
      <div className="navigation-brand" aria-label="ChatWCA">W</div>
      <button
        type="button"
        className={section === "conversations" ? "is-selected" : ""}
        aria-current={section === "conversations" ? "page" : undefined}
        title="Conversations"
        onClick={() => onSelect("conversations")}
      >
        <span className="navigation-icon" aria-hidden="true"><ConversationsIcon /></span>
        <span className="navigation-label">Conversations</span>
      </button>
      <button
        type="button"
        className={section === "jobs" ? "is-selected" : ""}
        aria-current={section === "jobs" ? "page" : undefined}
        title="Jobs"
        onClick={() => onSelect("jobs")}
      >
        <span className="navigation-icon" aria-hidden="true"><JobsIcon /></span>
        <span className="navigation-label">Jobs</span>
      </button>
      <span
        className={`navigation-connection${connected ? " is-connected" : ""}`}
        role="status"
        title={connected ? "Server online" : "Server offline"}
      >
        <i aria-hidden="true" />
        <span className="navigation-label">{connected ? "Online" : "Offline"}</span>
      </span>
    </nav>
  );
}
