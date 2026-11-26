import { createContext, useContext, useEffect, type ReactNode } from "react";

/** A detail page's own header: the list it belongs to, its name and a logo (Providers › OpenAI). */
export interface PageHead {
  parent: { label: string; href: string };
  title: string;
  media?: ReactNode;
}

/** Lets a page replace the page header and the breadcrumb's last steps. */
export const PageHeadContext = createContext<(head: PageHead | null) => void>(() => {});

/** Shows `head` while the page is open; `key` says when it changed. */
export function usePageHead(head: PageHead | null, key: string): void {
  const set = useContext(PageHeadContext);
  useEffect(() => {
    set(head);
    return () => set(null);
    // `head` is a new object on each render; `key` stands for its content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set, key]);
}
