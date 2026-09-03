export type AppSection = "conversations" | "jobs";

export interface AppNavigationProps {
  readonly section: AppSection;
  readonly connected: boolean;
  readonly onSelect: (section: AppSection) => void;
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
        <span className="navigation-icon" aria-hidden="true">●</span>
        <span className="navigation-label">Conversations</span>
      </button>
      <button
        type="button"
        className={section === "jobs" ? "is-selected" : ""}
        aria-current={section === "jobs" ? "page" : undefined}
        title="Jobs"
        onClick={() => onSelect("jobs")}
      >
        <span className="navigation-icon" aria-hidden="true">◷</span>
        <span className="navigation-label">Jobs</span>
      </button>
      <span className={`navigation-connection${connected ? " is-connected" : ""}`}>
        <i aria-hidden="true" />
        <span className="navigation-label">{connected ? "Online" : "Offline"}</span>
      </span>
    </nav>
  );
}
