import React, { createContext, useContext, useState, useEffect } from "react";

interface ThemeContextType {
  isDark: boolean;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const THEME_STORAGE_KEY = "theme";

function getSystemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved) return saved === "dark";
    return getSystemPrefersDark();
  });

  useEffect(() => {
    document.documentElement.setAttribute(
      "data-theme",
      isDark ? "dark" : "light",
    );
  }, [isDark]);

  // #769: track the OS theme live so a contributor who never manually toggled
  // sees the app follow their system setting (e.g. switching at sunset)
  // without needing a reload. A manual toggle (below) writes an explicit
  // preference to localStorage, which takes over from the OS setting.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event: MediaQueryListEvent) => {
      if (localStorage.getItem(THEME_STORAGE_KEY)) return; // explicit override wins
      setIsDark(event.matches);
    };
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  const toggleTheme = () => {
    setIsDark((prev) => {
      const next = !prev;
      localStorage.setItem(THEME_STORAGE_KEY, next ? "dark" : "light");
      return next;
    });
  };

  return (
    <ThemeContext.Provider value={{ isDark, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
};
