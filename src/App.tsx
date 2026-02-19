import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

interface DirEntry {
  name: string;
  is_dir: boolean;
}

function App() {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [error, setError] = useState("");

  async function listDir() {
    setError("");
    try {
      const result = await invoke<DirEntry[]>("list_directory", { path });
      setEntries(result);
    } catch (e) {
      setError(String(e));
      setEntries([]);
    }
  }

  return (
    <main className="container">
      <h1>Directory Browser</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          listDir();
        }}
      >
        <input
          type="text"
          value={path}
          onChange={(e) => setPath(e.currentTarget.value)}
          placeholder="Enter a directory path..."
        />
        <button type="submit">List</button>
      </form>
      {error && <p style={{ color: "red" }}>{error}</p>}
      {entries.length > 0 && (
        <ul style={{ textAlign: "left" }}>
          {entries.map((entry) => (
            <li key={entry.name}>
              {entry.is_dir ? "📁" : "📄"} {entry.name}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

export default App;
