import { createContext, useContext, useEffect, type ReactNode } from "react";

/** Lets a page replace the top bar's title (the provider detail page shows "Providers › logo + name"). */
export const ShellTitleContext = createContext<(title: ReactNode | null) => void>(() => {});

/** Shows `title` in the top bar while the page is open; `key` says when it changed. */
export function useShellTitle(title: ReactNode | null, key: string): void {
  const set = useContext(ShellTitleContext);
  useEffect(() => {
    set(title);
    return () => set(null);
    // `title` is a new element on each render; `key` stands for its content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set, key]);
}
