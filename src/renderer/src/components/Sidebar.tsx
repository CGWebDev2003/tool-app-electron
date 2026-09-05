import styles from "./Sidebar.module.css";

export type RouteId = "dashboard" | "youtube-download" | "converter";

const NAV_ITEMS: Array<{ id: RouteId; label: string }> = [
  { id: "dashboard", label: "Dashboard" },
  { id: "youtube-download", label: "YouTube Download" },
  { id: "converter", label: "Converter" },
];

type Props = {
  active: RouteId;
  onNavigate: (route: RouteId) => void;
};

export default function Sidebar({ active, onNavigate }: Props) {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.title}>tool-app</div>
      <nav className={styles.nav}>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={item.id === active ? `${styles.link} ${styles.linkActive}` : styles.link}
            onClick={() => onNavigate(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
    </aside>
  );
}
