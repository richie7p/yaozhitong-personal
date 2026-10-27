import { useEffect, useState } from "react";
import { taipeiDay } from "../shared/dates";

export function useTaipeiDay() {
  const [today, setToday] = useState(() => taipeiDay());
  useEffect(() => {
    let timer: number;
    const update = () => {
      setToday(taipeiDay());
      // Align with minute boundaries, including Taipei midnight.
      timer = window.setTimeout(update, 60_000 - (Date.now() % 60_000));
    };
    const refreshWhenVisible = () => {
      if (!document.hidden) setToday(taipeiDay());
    };
    update();
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);
  return today;
}
