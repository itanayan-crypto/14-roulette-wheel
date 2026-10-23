import { useEffect } from "react";
import RouletteWheel from "./components/RouletteWheel/RouletteWheel.jsx";

// body[data-task] is used by styles/base.css for this task's page background.
const TASK_ID = "14";

export default function App() {
  useEffect(() => {
    document.body.dataset.task = TASK_ID;
    return () => { delete document.body.dataset.task; };
  }, []);

  return (
    <main className="page">
      <div className="page-head">
        <span className="task-chip">Task 14</span>
        <h1 className="page-title">Roulette Wheel</h1>
        <p className="page-sub">Bid on a number, spin the wheel and win if it stops on your number. Otherwise it is a loss.</p>
      </div>
      <RouletteWheel />
    </main>
  );
}
