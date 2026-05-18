import { createRoot } from "react-dom/client";
import { DemoApp } from "./DemoApp.js";
import "../styles.css";
import "./demo.css";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<DemoApp />);
}
